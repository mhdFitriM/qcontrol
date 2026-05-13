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
  // Also attach running-container status via `docker ps` once and match by
  // compose-project label (the directory name).
  let runningProjects = new Set();
  try {
    const { stdout } = await execFileP(
      'docker',
      ['ps', '--format', '{{.Label "com.docker.compose.project"}}'],
      { timeout: 5000 },
    );
    runningProjects = new Set(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch { /* docker offline — annotate everything as unknown */ }

  for (const p of projects) p.running = runningProjects.has(p.name);
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
