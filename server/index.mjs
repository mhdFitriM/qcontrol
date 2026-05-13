/**
 * qcontrol — single Express process that:
 *   1. Reads /host/opt to enumerate docker-compose projects
 *   2. Talks to docker via shell-out to `docker` CLI (sock is mounted in)
 *   3. Reads/writes /host/opt/reverse-proxy/.env and Caddyfile
 *   4. Validates Caddy config and reloads in place
 *   5. Serves the React SPA from web/dist (or proxies to vite in dev)
 *
 * All state lives on the host filesystem — qcontrol itself is stateless
 * and can be restarted at any time without losing anything.
 *
 * Auth: a single shared bearer token (env var QCONTROL_TOKEN). Set this
 * to a long random string, paste it on first login, it's stored in a
 * cookie. No user accounts to manage.
 */
import express from 'express';
import cookieParser from 'cookie-parser';
import { execFile, exec } from 'node:child_process';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const execP = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration via env.
const PORT = Number(process.env.PORT || 8089);
const HOST_OPT = process.env.HOST_OPT || '/host/opt';
const TOKEN = process.env.QCONTROL_TOKEN || '';
const REVERSE_PROXY_DIR = path.join(HOST_OPT, 'reverse-proxy');
const WEB_DIST = path.join(__dirname, '..', 'web', 'dist');

if (!TOKEN) {
  console.warn('[qcontrol] QCONTROL_TOKEN not set — the UI will refuse every request. Set it in .env before going live.');
}

// Git "safe.directory" — when /opt is owned by root on the host and this
// container runs as a different uid, git 2.35+ refuses to operate on those
// repos with "fatal: detected dubious ownership". Without this, branch +
// last-commit detection silently fail for every host-owned repo. Allow
// every path; we only ever read, never mutate (clone uses fresh dirs).
try {
  await execFileP('git', ['config', '--global', '--add', 'safe.directory', '*'], { timeout: 3000 });
} catch { /* ignore — not fatal if git is missing in dev */ }

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ─── auth ────────────────────────────────────────────────────────────────
function authed(req, res, next) {
  const supplied = (req.cookies?.qcontrol_token || '').trim() ||
                   (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!TOKEN || supplied !== TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.post('/api/auth/login', (req, res) => {
  const { token } = req.body || {};
  if (!TOKEN || token !== TOKEN) {
    return res.status(401).json({ error: 'invalid_token' });
  }
  res.cookie('qcontrol_token', TOKEN, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
  });
  res.json({ ok: true });
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('qcontrol_token');
  res.json({ ok: true });
});

app.get('/api/auth/whoami', (req, res) => {
  const supplied = (req.cookies?.qcontrol_token || '').trim();
  res.json({ authed: !!TOKEN && supplied === TOKEN });
});

// ─── projects (read-only enumeration) ────────────────────────────────────
async function listProjects() {
  let entries = [];
  try { entries = await readdir(HOST_OPT, { withFileTypes: true }); } catch { return []; }
  const projects = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.')) continue;
    const dir = path.join(HOST_OPT, e.name);
    const compose = path.join(dir, 'docker-compose.yml');
    const vpsOverlay = path.join(dir, 'docker-compose.vps.yml');
    if (!existsSync(compose)) continue;

    let branch = null;
    let lastCommit = null;
    try {
      const r1 = await execFileP('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 3000 });
      branch = r1.stdout.trim();
    } catch { /* not a git repo, fine */ }
    try {
      const r2 = await execFileP('git', ['-C', dir, 'log', '-1', '--pretty=format:%h %s'], { timeout: 3000 });
      lastCommit = r2.stdout.trim();
    } catch { /* ignore */ }

    projects.push({
      name: e.name,
      path: dir,
      hasVpsOverlay: existsSync(vpsOverlay),
      branch,
      lastCommit,
    });
  }
  return projects;
}

app.get('/api/projects', authed, async (_req, res) => {
  const projects = await listProjects();

  // Running detection — authoritative version. We read TWO docker labels at
  // once and match on either:
  //   • `com.docker.compose.project`            — usually the directory name,
  //     but operators sometimes override it via `name:` in compose.yml or
  //     COMPOSE_PROJECT_NAME, which is why label-only matching missed e.g.
  //     /opt/faceapp_main → containers labelled "faceapp".
  //   • `com.docker.compose.project.working_dir` — the absolute path of the
  //     project's compose file dir on the host. This is the unambiguous
  //     anchor: if any running container's working_dir matches our project's
  //     host path, that project is up regardless of how its name was set.
  // Containers report HOST paths (the daemon is on the host), so we compare
  // against the canonical host paths derived from HOST_OPT mount point.
  const runningNames = new Set();      // exact project-name match
  const runningHostPaths = new Set();  // absolute host paths
  try {
    const { stdout } = await execFileP(
      'docker',
      ['ps', '--format', '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}'],
      { timeout: 5000 },
    );
    for (const line of stdout.split('\n')) {
      const [name, wd] = line.split('|');
      if (name && name.trim()) runningNames.add(name.trim());
      if (wd && wd.trim()) runningHostPaths.add(wd.trim().replace(/\/+$/, ''));
    }
  } catch { /* docker offline — leave every project marked stopped */ }

  // Translate /host/opt/<x> back to whatever absolute host path docker
  // reports. Common cases: HOST_OPT="/host/opt" → host path "/opt"; for any
  // other mount we just strip the container-side prefix and pop a leading
  // "/opt" guess; we also keep the original prefixed path as a fallback in
  // case the bind mount uses identical paths on both sides.
  function hostPathFor(project) {
    const containerPath = project.path; // e.g. /host/opt/qparking
    const candidates = new Set([containerPath]);
    if (HOST_OPT.startsWith('/host')) candidates.add(containerPath.replace(/^\/host/, ''));
    return candidates;
  }

  for (const p of projects) {
    let running = runningNames.has(p.name);
    if (!running) {
      for (const candidate of hostPathFor(p)) {
        if (runningHostPaths.has(candidate.replace(/\/+$/, ''))) { running = true; break; }
      }
    }
    p.running = running;
  }
  res.json({ data: projects });
});

app.get('/api/projects/:name/containers', authed, async (req, res) => {
  const project = req.params.name;
  try {
    const { stdout } = await execFileP(
      'docker',
      ['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format',
        '{{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}'],
      { timeout: 5000 },
    );
    const rows = stdout.split('\n').filter(Boolean).map((line) => {
      const [name, status, ports, image] = line.split('\t');
      return { name, status, ports, image };
    });
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: 'docker_error', message: e.message });
  }
});

app.get('/api/projects/:name/logs', authed, async (req, res) => {
  const project = req.params.name;
  const tail = String(req.query.tail || '200');
  const dir = path.join(HOST_OPT, project);
  const overlay = path.join(dir, 'docker-compose.vps.yml');
  const args = ['compose', '-f', 'docker-compose.yml'];
  if (existsSync(overlay)) args.push('-f', 'docker-compose.vps.yml');
  args.push('logs', '--tail', tail, '--no-color');
  try {
    const { stdout, stderr } = await execFileP('docker', args, { cwd: dir, timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    res.type('text/plain').send(stdout + stderr);
  } catch (e) {
    res.status(500).json({ error: 'docker_error', message: e.message });
  }
});

// ─── project actions ─────────────────────────────────────────────────────
/** Run a compose command inside a project's directory, with the vps overlay when present. */
async function runCompose(project, command, opts = {}) {
  const dir = path.join(HOST_OPT, project);
  const overlay = path.join(dir, 'docker-compose.vps.yml');
  const args = ['compose', '-f', 'docker-compose.yml'];
  if (existsSync(overlay)) args.push('-f', 'docker-compose.vps.yml');
  args.push(...command);
  return execFileP('docker', args, { cwd: dir, timeout: opts.timeout ?? 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
}

app.post('/api/projects/:name/restart', authed, async (req, res) => {
  try {
    const { stdout, stderr } = await runCompose(req.params.name, ['restart']);
    res.json({ ok: true, log: stdout + stderr });
  } catch (e) { res.status(500).json({ error: 'compose_error', message: e.stderr || e.message }); }
});

app.post('/api/projects/:name/up', authed, async (req, res) => {
  try {
    const { stdout, stderr } = await runCompose(req.params.name, ['up', '-d', '--force-recreate']);
    res.json({ ok: true, log: stdout + stderr });
  } catch (e) { res.status(500).json({ error: 'compose_error', message: e.stderr || e.message }); }
});

app.post('/api/projects/:name/rebuild', authed, async (req, res) => {
  try {
    const build = await runCompose(req.params.name, ['build', '--no-cache']);
    const up = await runCompose(req.params.name, ['up', '-d', '--force-recreate']);
    res.json({ ok: true, log: build.stdout + build.stderr + '\n' + up.stdout + up.stderr });
  } catch (e) { res.status(500).json({ error: 'compose_error', message: e.stderr || e.message }); }
});

app.post('/api/projects/:name/pull-and-rebuild', authed, async (req, res) => {
  const project = req.params.name;
  const dir = path.join(HOST_OPT, project);
  try {
    const pull = await execFileP('git', ['-C', dir, 'pull', '--ff-only'], { timeout: 60000 });
    const build = await runCompose(project, ['build', '--no-cache']);
    const up = await runCompose(project, ['up', '-d', '--force-recreate']);
    res.json({ ok: true, log: pull.stdout + pull.stderr + '\n' + build.stdout + build.stderr + '\n' + up.stdout + up.stderr });
  } catch (e) { res.status(500).json({ error: 'deploy_error', message: e.stderr || e.message }); }
});

app.post('/api/projects/:name/down', authed, async (req, res) => {
  try {
    const { stdout, stderr } = await runCompose(req.params.name, ['down']);
    res.json({ ok: true, log: stdout + stderr });
  } catch (e) { res.status(500).json({ error: 'compose_error', message: e.stderr || e.message }); }
});

// ─── clone-to-staging ───────────────────────────────────────────────────

/** Slug-safe identifier (a-z 0-9 dash). Used for derived dest name suffix. */
function slugify(input) {
  return String(input || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Scan the reverse-proxy .env, the Caddyfile, every project's
 *  docker-compose.vps.yml, and the running docker container port
 *  publications — return the union of ports already in use so we don't
 *  double-allocate when picking a port for a new staging clone. */
async function collectUsedPorts() {
  const used = new Set();

  try {
    const envBody = await readFile(path.join(REVERSE_PROXY_DIR, '.env'), 'utf8');
    for (const m of envBody.matchAll(/127\.0\.0\.1:(\d{2,5})/g)) used.add(Number(m[1]));
  } catch { /* ignore */ }
  try {
    const cf = await readFile(path.join(REVERSE_PROXY_DIR, 'Caddyfile'), 'utf8');
    for (const m of cf.matchAll(/127\.0\.0\.1:(\d{2,5})/g)) used.add(Number(m[1]));
  } catch { /* ignore */ }

  try {
    const entries = await readdir(HOST_OPT, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const overlay = path.join(HOST_OPT, e.name, 'docker-compose.vps.yml');
      if (!existsSync(overlay)) continue;
      try {
        const body = await readFile(overlay, 'utf8');
        for (const m of body.matchAll(/127\.0\.0\.1:(\d{2,5})/g)) used.add(Number(m[1]));
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  try {
    const { stdout } = await execFileP('docker', ['ps', '--format', '{{.Ports}}'], { timeout: 5000 });
    for (const m of stdout.matchAll(/(?:127\.0\.0\.1:)?(\d{2,5})->/g)) used.add(Number(m[1]));
  } catch { /* docker offline — fine */ }

  return used;
}

/** Walk forward from start, return the first port not in `used`. */
function nextFreePort(used, start = 8088) {
  for (let p = start; p < 9000; p++) if (!used.has(p)) return p;
  throw new Error('No free port in 8088-8999');
}

app.get('/api/projects/:name/clone-info', authed, async (req, res) => {
  const project = req.params.name;
  const dir = path.join(HOST_OPT, project);
  if (!existsSync(dir)) return res.status(404).json({ error: 'no_such_project' });

  let gitRemote = null;
  let branches = [];
  try {
    const r = await execFileP('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 3000 });
    gitRemote = r.stdout.trim();
  } catch { /* not a git repo */ }
  try {
    const r = await execFileP('git', ['-C', dir, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'], { timeout: 3000 });
    branches = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      .map((b) => b.replace(/^origin\//, '')).filter((b) => b !== 'HEAD');
  } catch { /* ignore */ }

  const used = await collectUsedPorts();
  const suggestedPort = nextFreePort(used);

  res.json({
    source: project,
    gitRemote,
    branches,
    suggestedDest: `${project}-staging`,
    suggestedPort,
    usedPorts: Array.from(used).sort((a, b) => a - b),
  });
});

app.post('/api/projects/clone', authed, async (req, res) => {
  const {
    source,
    dest: rawDest,
    method = 'git',           // 'git' or 'copy'
    branch,                   // required when method=git
    domain,                   // optional — when set, we wire reverse-proxy
    port: rawPort,            // optional — auto-allocate when missing
    reloadCaddy = true,
  } = req.body || {};

  const log = [];
  const push = (line) => log.push(line);

  if (!source || typeof source !== 'string') return res.status(400).json({ error: 'source_required' });
  const dest = slugify(rawDest || `${source}-staging`);
  if (!dest) return res.status(400).json({ error: 'dest_required' });

  const srcDir = path.join(HOST_OPT, source);
  const destDir = path.join(HOST_OPT, dest);
  if (!existsSync(srcDir)) return res.status(404).json({ error: 'no_such_source' });
  if (existsSync(destDir)) return res.status(409).json({ error: 'dest_exists', message: `${destDir} already exists` });

  let port = Number(rawPort);
  if (!Number.isFinite(port) || port < 1024 || port > 65535) {
    const used = await collectUsedPorts();
    port = nextFreePort(used);
    push(`==> Auto-allocated port: ${port}`);
  }

  // 1) Copy or clone the project tree.
  try {
    if (method === 'git') {
      const remoteResult = await execFileP('git', ['-C', srcDir, 'remote', 'get-url', 'origin'], { timeout: 3000 });
      const remote = remoteResult.stdout.trim();
      if (!remote) throw new Error('source has no git remote — switch to copy mode');
      const targetBranch = branch || 'main';
      push(`==> git clone ${remote} -b ${targetBranch} → ${destDir}`);
      const r = await execFileP('git', ['clone', '--branch', targetBranch, '--single-branch', remote, destDir], { timeout: 5 * 60 * 1000 });
      push(r.stdout + r.stderr);
    } else if (method === 'copy') {
      push(`==> cp -r ${srcDir} → ${destDir}`);
      try {
        // Exclude .env: the source's env points at the source's port + DB, never
        // safe to carry over verbatim. The user starts the staging instance with
        // a fresh .env they generate on the VPS.
        const r = await execFileP('rsync', ['-a', '--exclude', '.git', '--exclude', 'node_modules', '--exclude', 'vendor', '--exclude', 'data', '--exclude', '.env', `${srcDir}/`, `${destDir}/`], { timeout: 10 * 60 * 1000 });
        push(r.stdout + r.stderr || '(rsync ok)');
      } catch {
        const r = await execFileP('cp', ['-r', srcDir, destDir], { timeout: 10 * 60 * 1000 });
        push(r.stdout + r.stderr || '(cp ok)');
      }
    } else {
      return res.status(400).json({ error: 'bad_method', message: 'method must be git or copy' });
    }
  } catch (e) {
    push('✗ ' + (e.stderr || e.message));
    return res.status(500).json({ ok: false, log: log.join('\n') });
  }

  // 1.5) Rewrite the cloned project's docker-compose.vps.yml so its
  //      published ports don't collide with the source. The clone inherits
  //      the SOURCE's `127.0.0.1:NNNN:M` bindings verbatim — if the source
  //      is already running on those ports, the new staging stack either
  //      fails to start or reuses them, and the reverse-proxy upstream we
  //      just allocated points at a port that nothing is listening on.
  //
  // Strategy:
  //   • parse every `127.0.0.1:<port>:` in the cloned overlay
  //   • allocate a consecutive new port for each unique source port,
  //     starting from `port` (the auto-allocated upstream we already had)
  //   • rewrite the file in-place
  //   • the FIRST new port becomes the public-facing upstream the
  //     reverse-proxy block points at (multi-port projects with path-split
  //     routing still need a manual Caddy edit, but the single-port case —
  //     which is most projects — is fully automatic).
  const overlayPath = path.join(destDir, 'docker-compose.vps.yml');
  let portMap = {};
  if (existsSync(overlayPath)) {
    try {
      let body = await readFile(overlayPath, 'utf8');
      const matches = [...body.matchAll(/127\.0\.0\.1:(\d{2,5}):/g)];
      const uniqueSourcePorts = [...new Set(matches.map((m) => Number(m[1])))];
      if (uniqueSourcePorts.length > 0) {
        const used = await collectUsedPorts();
        // The user/auto-allocated `port` is the first new port we want.
        // Skip past any already-used ports as we walk forward.
        let cursor = port;
        for (const srcPort of uniqueSourcePorts) {
          while (used.has(cursor)) cursor++;
          portMap[srcPort] = cursor;
          used.add(cursor);
          cursor++;
        }
        for (const [srcPort, newPort] of Object.entries(portMap)) {
          const re = new RegExp(`127\\.0\\.0\\.1:${srcPort}:`, 'g');
          body = body.replace(re, `127.0.0.1:${newPort}:`);
        }
        await writeFile(overlayPath, body, 'utf8');
        push(`==> rewrote ports in docker-compose.vps.yml: ${JSON.stringify(portMap)}`);
        // Make the FIRST remapped port the reverse-proxy upstream so the
        // domain we wire below actually reaches a listening socket.
        port = portMap[uniqueSourcePorts[0]];
      } else {
        push('==> docker-compose.vps.yml has no 127.0.0.1 port bindings — nothing to rewrite');
      }
    } catch (e) {
      push('✗ port rewrite failed (cloned tree still on disk): ' + e.message);
    }
  } else {
    push('==> no docker-compose.vps.yml in source — skipping port rewrite (start the clone with the source\'s ports!)');
  }

  // 2) Optionally wire reverse-proxy: append .env vars + Caddyfile block, validate, reload.
  let proxyDetails = null;
  if (domain) {
    const slug = slugify(dest).toUpperCase().replace(/-/g, '_');
    const envLine1 = `${slug}_DOMAIN=${domain}`;
    const envLine2 = `${slug}_UPSTREAM=127.0.0.1:${port}`;
    const caddyBlock = `{$${slug}_DOMAIN} {\n  reverse_proxy {$${slug}_UPSTREAM}\n}\n`;

    try {
      const envPath = path.join(REVERSE_PROXY_DIR, '.env');
      const caddyPath = path.join(REVERSE_PROXY_DIR, 'Caddyfile');
      const existingEnv = (await readFile(envPath, 'utf8').catch(() => '')) || '';
      const newEnv = existingEnv.replace(/\s*$/, '') + `\n\n# ${dest}\n${envLine1}\n${envLine2}\n`;
      await writeFile(envPath, newEnv, 'utf8');
      push('==> appended to /opt/reverse-proxy/.env');

      const existingCaddy = await readFile(caddyPath, 'utf8');
      await writeFile(caddyPath, existingCaddy.replace(/\s*$/, '') + '\n\n' + caddyBlock, 'utf8');
      push('==> appended to /opt/reverse-proxy/Caddyfile');

      if (reloadCaddy) {
        // IMPORTANT: Caddy reads {$VAR} env-var references ONCE at container
        // startup, not on `caddy reload`. Since the clone just appended a
        // brand-new *_DOMAIN / *_UPSTREAM pair to .env, a plain reload would
        // expand them to empty strings, producing a `<empty> { ... }` block
        // that Caddy treats as a global options block (must be first) and
        // refuses with "server block without any key is global configuration".
        // The reliable path is to recreate the Caddy container so it re-reads
        // .env from disk. ~1 second of downtime; acceptable.
        try {
          const r = await execP(
            'docker compose -f docker-compose.yml up -d --force-recreate caddy',
            { cwd: REVERSE_PROXY_DIR, timeout: 60000 },
          );
          push('==> caddy recreated with fresh env');
          push(r.stdout + r.stderr);
          const v = await execP(
            'docker compose -f docker-compose.yml exec -T caddy caddy validate --config /etc/caddy/Caddyfile',
            { cwd: REVERSE_PROXY_DIR, timeout: 30000 },
          );
          push('==> caddy validate ok');
          push(v.stdout + v.stderr);
        } catch (e) {
          push('✗ caddy recreate/validate failed: ' + (e.stderr || e.message));
          push('   (.env and Caddyfile were still written — fix the syntax and rerun manually)');
        }
      }
      proxyDetails = { domain, port, envKey: slug };
    } catch (e) {
      push('✗ reverse-proxy wire-up failed: ' + e.message);
    }
  }

  res.json({
    ok: true,
    dest,
    destDir,
    port,
    portMap,
    proxy: proxyDetails,
    log: log.join('\n'),
  });
});

// ─── reverse-proxy editor ────────────────────────────────────────────────
app.get('/api/revproxy/env', authed, async (_req, res) => {
  try {
    const body = await readFile(path.join(REVERSE_PROXY_DIR, '.env'), 'utf8');
    res.type('text/plain').send(body);
  } catch (e) { res.status(500).json({ error: 'read_failed', message: e.message }); }
});

app.put('/api/revproxy/env', authed, async (req, res) => {
  const body = String(req.body?.content ?? '');
  if (!body) return res.status(400).json({ error: 'empty_body' });
  try {
    await writeFile(path.join(REVERSE_PROXY_DIR, '.env'), body, 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'write_failed', message: e.message }); }
});

app.get('/api/revproxy/caddyfile', authed, async (_req, res) => {
  try {
    const body = await readFile(path.join(REVERSE_PROXY_DIR, 'Caddyfile'), 'utf8');
    res.type('text/plain').send(body);
  } catch (e) { res.status(500).json({ error: 'read_failed', message: e.message }); }
});

app.put('/api/revproxy/caddyfile', authed, async (req, res) => {
  const body = String(req.body?.content ?? '');
  if (!body) return res.status(400).json({ error: 'empty_body' });
  try {
    await writeFile(path.join(REVERSE_PROXY_DIR, 'Caddyfile'), body, 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'write_failed', message: e.message }); }
});

app.post('/api/revproxy/validate', authed, async (_req, res) => {
  // Use the running Caddy container to validate the current on-disk
  // Caddyfile. No side-effects — Caddy doesn't reload until we ask it to.
  try {
    const { stdout, stderr } = await execP(
      'docker compose -f docker-compose.yml exec -T caddy caddy validate --config /etc/caddy/Caddyfile',
      { cwd: REVERSE_PROXY_DIR, timeout: 30000, maxBuffer: 1024 * 1024 },
    );
    res.json({ ok: true, log: stdout + stderr });
  } catch (e) {
    res.status(400).json({ ok: false, error: 'caddy_invalid', log: e.stdout + e.stderr });
  }
});

app.post('/api/revproxy/reload', authed, async (_req, res) => {
  // Validate FIRST so a typo can't blank out every site. Only reload on green.
  try {
    await execP(
      'docker compose -f docker-compose.yml exec -T caddy caddy validate --config /etc/caddy/Caddyfile',
      { cwd: REVERSE_PROXY_DIR, timeout: 30000 },
    );
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'caddy_invalid', log: e.stdout + e.stderr });
  }
  try {
    const { stdout, stderr } = await execP(
      'docker compose -f docker-compose.yml exec -T caddy caddy reload --config /etc/caddy/Caddyfile',
      { cwd: REVERSE_PROXY_DIR, timeout: 30000 },
    );
    res.json({ ok: true, log: stdout + stderr });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'reload_failed', log: e.stdout + e.stderr });
  }
});

app.post('/api/revproxy/recreate', authed, async (_req, res) => {
  // Use this after editing .env (new *_DOMAIN / *_UPSTREAM vars). Caddy only
  // re-reads its `{$VAR}` expansions at container startup, so adding a brand
  // new var requires a recreate, not a reload. ~1 second of TLS downtime.
  try {
    const { stdout, stderr } = await execP(
      'docker compose -f docker-compose.yml up -d --force-recreate caddy',
      { cwd: REVERSE_PROXY_DIR, timeout: 60000 },
    );
    // After recreate, validate to surface any non-env Caddyfile errors.
    let validateLog = '';
    try {
      const v = await execP(
        'docker compose -f docker-compose.yml exec -T caddy caddy validate --config /etc/caddy/Caddyfile',
        { cwd: REVERSE_PROXY_DIR, timeout: 30000 },
      );
      validateLog = v.stdout + v.stderr;
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'caddy_invalid_after_recreate', log: stdout + stderr + '\n' + (e.stdout + e.stderr) });
    }
    res.json({ ok: true, log: stdout + stderr + '\n' + validateLog });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'recreate_failed', log: (e.stdout || '') + (e.stderr || e.message) });
  }
});

// ─── static SPA ──────────────────────────────────────────────────────────
if (existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => {
    res.status(503).type('text/plain').send(
      'qcontrol web bundle not built yet.\n' +
      'On the host (or in this container at first boot): `npm run build`.\n' +
      'Until then API endpoints under /api still respond.'
    );
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[qcontrol] up on :${PORT} (host_opt=${HOST_OPT}, token-set=${!!TOKEN})`);
});
