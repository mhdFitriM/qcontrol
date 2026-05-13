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
// Real path on the docker host that HOST_OPT mounts. Needed when we shell
// out to `docker run -v <path>:...` — the daemon (on the host) interprets
// those paths, NOT the qcontrol container's view. Default is /opt.
const HOST_OPT_REAL = process.env.HOST_OPT_REAL || '/opt';
const TOKEN = process.env.QCONTROL_TOKEN || '';
const REVERSE_PROXY_DIR = path.join(HOST_OPT, 'reverse-proxy');
const REVERSE_PROXY_HOST_PATH = `${HOST_OPT_REAL.replace(/\/+$/, '')}/reverse-proxy`;
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

// ─── VPS health (CPU / mem / disk / processes / containers) ──────────────
//
// We mount /proc from the host at /host/proc:ro, so reading these files
// gives us the *host's* numbers — not the container's namespaced view.
// If the mount isn't there (dev box), we fall back to the container view
// gracefully; the page just shows the dev environment's numbers.
const HOST_PROC = existsSync('/host/proc') ? '/host/proc' : '/proc';

async function readProc(name) {
  try { return await readFile(path.join(HOST_PROC, name), 'utf8'); }
  catch { return ''; }
}

function parseMeminfo(body) {
  const out = {};
  for (const line of body.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)\s*(\w+)?/);
    if (m) out[m[1]] = Number(m[2]) * 1024; // /proc/meminfo is in kB
  }
  return out;
}

async function readVpsHealth() {
  const [meminfoBody, loadavgBody, uptimeBody, cpuinfoBody, statBody, hostnameBody, osBody] = await Promise.all([
    readProc('meminfo'),
    readProc('loadavg'),
    readProc('uptime'),
    readProc('cpuinfo'),
    readProc('stat'),
    readFile('/etc/hostname', 'utf8').catch(() => ''),
    readFile('/etc/os-release', 'utf8').catch(() => ''),
  ]);

  const mem = parseMeminfo(meminfoBody);
  const memTotal = mem.MemTotal || 0;
  const memAvailable = mem.MemAvailable ?? (mem.MemFree || 0) + (mem.Buffers || 0) + (mem.Cached || 0);
  const memUsed = memTotal - memAvailable;
  const swapTotal = mem.SwapTotal || 0;
  const swapUsed = swapTotal - (mem.SwapFree || 0);

  const loadParts = loadavgBody.trim().split(/\s+/);
  const loadavg = loadParts.length >= 3 ? [Number(loadParts[0]), Number(loadParts[1]), Number(loadParts[2])] : [0, 0, 0];

  const uptimeSeconds = Number((uptimeBody.split(/\s+/)[0] || '0'));
  const cpuCount = (cpuinfoBody.match(/^processor\s*:/gm) || []).length || 1;

  // CPU usage % — derived from the first sample of /proc/stat. To get a
  // real "right now" number you'd diff two samples; for a snapshot page
  // we estimate from uptime + idle time (cumulative since boot — good
  // enough as a coarse load indicator alongside loadavg).
  let cpuUsedPct = null;
  const cpuLine = statBody.split('\n').find((l) => l.startsWith('cpu '));
  if (cpuLine) {
    const nums = cpuLine.split(/\s+/).slice(1).map(Number);
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = nums;
    const total = user + nice + system + idle + iowait + irq + softirq + steal;
    const busy = total - idle - iowait;
    if (total > 0) cpuUsedPct = (busy / total) * 100;
  }

  // Disk — df against /host/opt (the mount of the host's /opt), and also
  // ask docker about its own root. df is in the container but the bind
  // mount points to the host filesystem, so the numbers are real.
  const disks = [];
  try {
    const r = await execFileP('df', ['-PB1', '/host/opt'], { timeout: 3000 });
    const lines = r.stdout.trim().split('\n').slice(1);
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 6) continue;
      disks.push({
        mount: '/opt',
        filesystem: parts[0],
        sizeBytes: Number(parts[1]),
        usedBytes: Number(parts[2]),
        availBytes: Number(parts[3]),
        usedPct: Number((parts[4] || '0').replace('%', '')),
      });
    }
  } catch { /* df missing — fine */ }

  const hostname = hostnameBody.trim();
  const osMatch = osBody.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  const os = osMatch ? osMatch[1] : '';

  return {
    hostname,
    os,
    uptimeSeconds,
    cpu: { count: cpuCount, usedPct: cpuUsedPct, loadavg },
    memory: { totalBytes: memTotal, usedBytes: memUsed, availableBytes: memAvailable, usedPct: memTotal > 0 ? (memUsed / memTotal) * 100 : 0 },
    swap: { totalBytes: swapTotal, usedBytes: swapUsed, usedPct: swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0 },
    disks,
  };
}

/** Top processes by RSS. Walks /host/proc to read each pid's status +
 *  comm + cmdline. Cheap because we cap at top N after sorting. */
async function readTopProcesses(limit = 12) {
  let entries = [];
  try { entries = await readdir(HOST_PROC, { withFileTypes: true }); } catch { return []; }
  const procs = [];
  for (const e of entries) {
    if (!/^\d+$/.test(e.name)) continue;
    const pid = e.name;
    try {
      const [statusBody, cmdlineBody, statBody] = await Promise.all([
        readFile(path.join(HOST_PROC, pid, 'status'), 'utf8').catch(() => ''),
        readFile(path.join(HOST_PROC, pid, 'cmdline'), 'utf8').catch(() => ''),
        readFile(path.join(HOST_PROC, pid, 'stat'), 'utf8').catch(() => ''),
      ]);
      const rssMatch = statusBody.match(/VmRSS:\s+(\d+)/);
      const nameMatch = statusBody.match(/^Name:\s+(.+)/m);
      const uidMatch = statusBody.match(/^Uid:\s+(\d+)/m);
      const stateMatch = statusBody.match(/^State:\s+(\S)/m);
      if (!rssMatch || !nameMatch) continue;
      const cmd = cmdlineBody.replace(/\0+/g, ' ').trim() || nameMatch[1];

      // utime+stime are columns 14+15 in /proc/[pid]/stat. The line has
      // the form: pid (comm) state ppid ... where (comm) may contain
      // spaces — slice from the rightmost ')' to be safe.
      let cpuTicks = 0;
      const closeParen = statBody.lastIndexOf(')');
      if (closeParen !== -1) {
        const after = statBody.slice(closeParen + 2).split(/\s+/);
        const utime = Number(after[11]); const stime = Number(after[12]);
        if (Number.isFinite(utime) && Number.isFinite(stime)) cpuTicks = utime + stime;
      }

      procs.push({
        pid: Number(pid),
        name: nameMatch[1],
        cmd: cmd.length > 120 ? cmd.slice(0, 120) + '…' : cmd,
        uid: Number(uidMatch?.[1] ?? 0),
        state: stateMatch?.[1] || '',
        rssBytes: Number(rssMatch[1]) * 1024,
        cpuTicks,
      });
    } catch { /* race: process exited between readdir and reads */ }
  }
  procs.sort((a, b) => b.rssBytes - a.rssBytes);
  return procs.slice(0, limit);
}

app.get('/api/vps/health', authed, async (_req, res) => {
  try {
    const [health, topProcs] = await Promise.all([readVpsHealth(), readTopProcesses(15)]);
    res.json({ ...health, topProcesses: topProcs });
  } catch (e) {
    res.status(500).json({ error: 'health_failed', message: e.message });
  }
});

app.get('/api/vps/containers/stats', authed, async (_req, res) => {
  // docker stats --no-stream gives a one-shot snapshot for every container.
  try {
    const { stdout } = await execFileP(
      'docker',
      ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}'],
      { timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
    );
    const rows = stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [name, cpu, mem, memPct, netIO, blockIO] = line.split('\t');
      return { name, cpu, mem, memPct, netIO, blockIO };
    });
    res.json({ data: rows });
  } catch (e) {
    res.status(500).json({ error: 'docker_error', message: e.message });
  }
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
  const dir = path.join(HOST_OPT, project);
  if (!existsSync(dir)) return res.status(404).json({ error: 'no_such_project' });

  // Authoritative listing: ask compose itself, from inside the project dir,
  // using its own compose files. This is immune to project-name mismatches
  // (dashes vs underscores, overridden `name:` in compose.yml, etc.) that
  // broke label-based filtering for clones like project-qbotu-a3-staging.
  const overlay = path.join(dir, 'docker-compose.vps.yml');
  const args = ['compose', '-f', 'docker-compose.yml'];
  if (existsSync(overlay)) args.push('-f', 'docker-compose.vps.yml');
  args.push('ps', '-a', '--format', 'json');

  try {
    const { stdout } = await execFileP('docker', args, { cwd: dir, timeout: 8000, maxBuffer: 4 * 1024 * 1024 });
    // `docker compose ps --format json` may emit either a single JSON array
    // or NDJSON (one object per line) depending on compose version. Handle both.
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    let raw = [];
    if (lines.length === 1 && lines[0].startsWith('[')) {
      try { raw = JSON.parse(lines[0]); } catch { raw = []; }
    } else {
      for (const line of lines) {
        try { raw.push(JSON.parse(line)); } catch { /* skip malformed */ }
      }
    }
    const rows = raw.map((c) => ({
      name: c.Name || c.Names || '',
      status: c.Status || c.State || '',
      state: (c.State || '').toLowerCase(),  // running | exited | created | ...
      ports: typeof c.Publishers === 'object'
        ? (c.Publishers || []).map((p) => {
            const host = p.URL ? `${p.URL}:${p.PublishedPort}` : (p.PublishedPort ? `:${p.PublishedPort}` : '');
            return host ? `${host}->${p.TargetPort}/${p.Protocol || 'tcp'}` : '';
          }).filter(Boolean).join(', ')
        : (c.Ports || ''),
      image: c.Image || '',
    }));
    const runningCount = rows.filter((r) => r.state === 'running').length;
    res.json({
      data: rows,
      running: runningCount > 0,
      total: rows.length,
      runningCount,
    });
  } catch (e) {
    res.status(500).json({ error: 'docker_error', message: e.stderr || e.message });
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

/** Convert a project name to the SLUG used as an env-var prefix in
 *  /opt/reverse-proxy/.env — upper-case, dashes → underscores. Used both
 *  when WRITING new entries and when DETECTING the source project's
 *  existing entries so we can suggest re-mapping them on a clone. */
function projectEnvSlug(projectName) {
  return slugify(projectName).toUpperCase().replace(/-/g, '_');
}

/** Parse /opt/reverse-proxy/.env and return every `<SLUG>_…_DOMAIN=value`
 *  line that belongs to `projectName`. Returns
 *  `[{ envKey, destKeySuffix, value }]` where destKeySuffix is the part
 *  AFTER the SLUG prefix (e.g. for QBOTU_API_DOMAIN we get 'API_DOMAIN',
 *  for the bare QBOTU_DOMAIN we get 'DOMAIN'). Lets the UI surface every
 *  domain the source already serves so the clone gets one new domain per
 *  source domain, all wired to the new upstream. */
async function readSourceDomainEntries(projectName) {
  const slug = projectEnvSlug(projectName);
  const re = new RegExp(`^${slug}((?:_[A-Z0-9]+)*?_DOMAIN)\\s*=\\s*(.+?)\\s*$`);
  const entries = [];
  try {
    const body = await readFile(path.join(REVERSE_PROXY_DIR, '.env'), 'utf8');
    for (const line of body.split('\n')) {
      const m = line.match(re);
      if (!m) continue;
      entries.push({
        envKey: `${slug}${m[1]}`,
        destKeySuffix: m[1].replace(/^_/, ''), // drop leading underscore
        value: m[2],
      });
    }
  } catch { /* file missing — return [] */ }
  return entries;
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
  const sourceDomains = await readSourceDomainEntries(project);

  res.json({
    source: project,
    gitRemote,
    branches,
    suggestedDest: `${project}-staging`,
    suggestedPort,
    usedPorts: Array.from(used).sort((a, b) => a - b),
    sourceDomains,
  });
});

app.post('/api/projects/clone', authed, async (req, res) => {
  const {
    source,
    dest: rawDest,
    method = 'git',           // 'git' or 'copy'
    branch,                   // required when method=git
    domain,                   // legacy single-domain field (kept for back-compat)
    domainMappings: rawDomainMappings, // new — [{ destKeySuffix, sourceDomain, destDomain }]
    port: rawPort,            // optional — auto-allocate when missing
    reloadCaddy = true,
  } = req.body || {};

  // Normalize domain mappings — either an explicit array, OR derive a
  // single-entry one from the legacy `domain` param.
  let domainMappings = Array.isArray(rawDomainMappings)
    ? rawDomainMappings
        .map((m) => ({
          destKeySuffix: String(m.destKeySuffix || 'DOMAIN').toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
          sourceDomain: (m.sourceDomain || '').trim(),
          destDomain: (m.destDomain || '').trim(),
        }))
        .filter((m) => m.destDomain) // skip blanks
    : [];
  if (domainMappings.length === 0 && domain) {
    domainMappings = [{ destKeySuffix: 'DOMAIN', sourceDomain: '', destDomain: String(domain).trim() }];
  }

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
        // .env IS carried over now — qcontrol will rewrite its ports +
        // domain values below, which is the whole reason we're doing this.
        const r = await execFileP('rsync', ['-a', '--exclude', '.git', '--exclude', 'node_modules', '--exclude', 'vendor', '--exclude', 'data', `${srcDir}/`, `${destDir}/`], { timeout: 10 * 60 * 1000 });
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

  // 1.75) Rewrite the cloned project's own .env (if one exists). The
  //       source's .env carries production hostnames and HOST_PORT values
  //       that point at the source's stack — leaving them unchanged means
  //       the staging clone serves the wrong domain bindings (so internal
  //       nginx routing misses) and binds the wrong host ports (collides
  //       with the source). We rewrite:
  //         • every `*_HOST_PORT=N`  →  portMap[N]  (if remapped)
  //         • every occurrence of sourceDomain → destDomain across the file
  //           (catches APP_DOMAIN, API_DOMAIN, FRONTEND_URL, API_URL,
  //            VITE_API_BASE_URL, MINIO_URL, etc. without us having to
  //            enumerate every var name a given stack might use)
  const destEnvPath = path.join(destDir, '.env');
  if (existsSync(destEnvPath)) {
    try {
      let envBody = await readFile(destEnvPath, 'utf8');
      const rewrites = [];

      // Port rewrites — only touch lines that look like a HOST_PORT.
      if (Object.keys(portMap).length > 0) {
        envBody = envBody.replace(/^([A-Z_]+_HOST_PORT)\s*=\s*(\d{2,5})\s*$/gm, (line, key, val) => {
          const n = Number(val);
          if (portMap[n]) { rewrites.push(`${key}: ${n} → ${portMap[n]}`); return `${key}=${portMap[n]}`; }
          return line;
        });
      }

      // Domain rewrites — pure string replacement, applied longest-first
      // so e.g. hub-api.qbot.jp gets swapped before hub.qbot.jp (otherwise
      // the shorter prefix would gobble the longer one).
      const mappingsByLength = [...domainMappings]
        .filter((m) => m.sourceDomain)
        .sort((a, b) => b.sourceDomain.length - a.sourceDomain.length);
      for (const m of mappingsByLength) {
        const re = new RegExp(m.sourceDomain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        const before = envBody;
        envBody = envBody.replace(re, m.destDomain);
        if (before !== envBody) rewrites.push(`domain: ${m.sourceDomain} → ${m.destDomain}`);
      }

      if (rewrites.length > 0) {
        await writeFile(destEnvPath, envBody, 'utf8');
        push(`==> rewrote /opt/${dest}/.env (${rewrites.length} change${rewrites.length === 1 ? '' : 's'}):`);
        for (const r of rewrites) push(`     • ${r}`);
      } else {
        push(`==> /opt/${dest}/.env carried over verbatim (no matching port/domain rewrites)`);
      }
    } catch (e) {
      push('✗ .env rewrite failed (cloned tree still on disk): ' + e.message);
    }
  } else {
    push(`==> no .env in cloned tree at /opt/${dest}/.env — skipping env rewrite (you may need to create one before bringing the stack up)`);
  }

  // 2) Wire reverse-proxy: one Caddy block + env entry per mapped domain,
  //    all pointing at a single shared `${SLUG}_UPSTREAM`. This matches the
  //    qbotu pattern of one proxy fronting multiple Host headers.
  const proxyDetails = [];
  if (domainMappings.length > 0) {
    const slug = projectEnvSlug(dest);
    const envPath = path.join(REVERSE_PROXY_DIR, '.env');
    const caddyPath = path.join(REVERSE_PROXY_DIR, 'Caddyfile');

    // Build env block: one UPSTREAM line + one DOMAIN line per mapping.
    const envLines = [`${slug}_UPSTREAM=127.0.0.1:${port}`];
    const caddyBlocks = [];
    for (const m of domainMappings) {
      const envKey = `${slug}_${m.destKeySuffix}`;
      envLines.push(`${envKey}=${m.destDomain}`);
      caddyBlocks.push(`{$${envKey}} {\n  reverse_proxy {$${slug}_UPSTREAM}\n}\n`);
      proxyDetails.push({ domain: m.destDomain, envKey, sourceDomain: m.sourceDomain || null });
    }

    try {
      const existingEnv = (await readFile(envPath, 'utf8').catch(() => '')) || '';
      const newEnv = existingEnv.replace(/\s*$/, '') + `\n\n# ${dest}\n${envLines.join('\n')}\n`;
      await writeFile(envPath, newEnv, 'utf8');
      push(`==> appended ${envLines.length} line(s) to /opt/reverse-proxy/.env`);

      const existingCaddy = await readFile(caddyPath, 'utf8');
      await writeFile(caddyPath, existingCaddy.replace(/\s*$/, '') + '\n\n' + caddyBlocks.join('\n'), 'utf8');
      push(`==> appended ${caddyBlocks.length} block(s) to /opt/reverse-proxy/Caddyfile`);

      if (reloadCaddy) {
        // Pre-validates in a throw-away container BEFORE recreating, so a
        // bad Caddyfile or empty env var can't take the running reverse-
        // proxy down (which would dark every domain on this VPS).
        const rec = await safeRecreateCaddy();
        push(rec.log);
        if (!rec.ok) {
          push('   (.env and Caddyfile were written but Caddy was left on the OLD config — your traffic is still live)');
        }
      }
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

/**
 * Safely recreate the running Caddy container so it re-reads .env.
 *
 * The previous version did `docker compose up -d --force-recreate caddy`
 * unconditionally, which destroyed the running container BEFORE checking
 * whether the new .env+Caddyfile pair was valid. If it wasn't, the new
 * container failed to start and the whole reverse-proxy went dark.
 *
 * The new flow validates FIRST in a throw-away container that gets the
 * same .env (so any new `{$VAR}` expansions are exercised). Only when
 * validation passes do we actually swap the running container. If
 * validation fails, the running stack keeps serving traffic on its old
 * config — no downtime, no surprise.
 */
async function safeRecreateCaddy() {
  const log = [];

  // Figure out which Caddy image the running stack uses, so the temp
  // validator runs the exact same binary. Falls back to caddy:2 if we
  // can't read the running container (e.g., it's not up yet).
  let image = 'caddy:2';
  try {
    const r = await execP(
      'docker compose -f docker-compose.yml ps caddy --format "{{.Image}}"',
      { cwd: REVERSE_PROXY_DIR, timeout: 5000 },
    );
    const first = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
    if (first) image = first;
  } catch { /* fall back to caddy:2 */ }
  log.push(`==> pre-validating with image ${image}`);

  // Throw-away validator. Mounts the Caddyfile read-only, reads the new
  // .env via --env-file, runs `caddy validate`. No side effects.
  try {
    const r = await execP(
      `docker run --rm -v ${REVERSE_PROXY_HOST_PATH}/Caddyfile:/etc/caddy/Caddyfile:ro --env-file ${REVERSE_PROXY_HOST_PATH}/.env ${image} caddy validate --config /etc/caddy/Caddyfile`,
      { timeout: 30000 },
    );
    log.push('==> pre-validation passed');
    log.push(r.stdout + r.stderr);
  } catch (e) {
    log.push('✗ pre-validation FAILED — running Caddy left untouched');
    log.push(e.stdout + e.stderr);
    return { ok: false, error: 'pre_validate_failed', log: log.join('\n') };
  }

  // Validation passed — safe to recreate.
  try {
    const r = await execP(
      'docker compose -f docker-compose.yml up -d --force-recreate caddy',
      { cwd: REVERSE_PROXY_DIR, timeout: 60000 },
    );
    log.push('==> caddy recreated with fresh env');
    log.push(r.stdout + r.stderr);
    return { ok: true, log: log.join('\n') };
  } catch (e) {
    log.push('✗ recreate failed');
    log.push((e.stdout || '') + (e.stderr || e.message));
    return { ok: false, error: 'recreate_failed', log: log.join('\n') };
  }
}

app.post('/api/revproxy/recreate', authed, async (_req, res) => {
  const result = await safeRecreateCaddy();
  res.status(result.ok ? 200 : 400).json(result);
});

// ─── destroy / remove project ───────────────────────────────────────────

/**
 * Strip a project's lines from the reverse-proxy .env and its block from
 * the Caddyfile. Returns true if anything was removed. We match by the
 * SLUG prefix that the clone code uses (PROJECT_NAME_UPPER_WITH_UNDERSCORES).
 */
async function removeReverseProxyEntries(projectName) {
  const slug = slugify(projectName).toUpperCase().replace(/-/g, '_');
  let changed = false;

  // .env: drop any line that starts with `<SLUG>_…=` plus its preceding
  // `# <projectName>` comment if present.
  try {
    const envPath = path.join(REVERSE_PROXY_DIR, '.env');
    const body = await readFile(envPath, 'utf8');
    const lines = body.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed === `# ${projectName}`) {
        // Skip this comment if the next non-blank line is a SLUG line.
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length && new RegExp(`^${slug}_[A-Z0-9_]*=`).test(lines[j].trim())) {
          changed = true;
          continue;
        }
      }
      if (new RegExp(`^${slug}_[A-Z0-9_]*=`).test(trimmed)) { changed = true; continue; }
      out.push(line);
    }
    if (changed) await writeFile(envPath, out.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
  } catch { /* file missing — nothing to clean */ }

  // Caddyfile: drop the block whose key references `{$<SLUG>_DOMAIN}`. We
  // do a simple brace-balanced scan from the opening line through the
  // matching `}`. This is robust for the simple blocks the clone writes;
  // more elaborate user-authored blocks may need manual cleanup.
  try {
    const caddyPath = path.join(REVERSE_PROXY_DIR, 'Caddyfile');
    const body = await readFile(caddyPath, 'utf8');
    const needle = `{$${slug}_DOMAIN}`;
    if (body.includes(needle)) {
      const idx = body.indexOf(needle);
      // Walk back to the start of the block's opening line.
      let lineStart = body.lastIndexOf('\n', idx) + 1;
      // Walk forward to the opening brace.
      let openBrace = body.indexOf('{', idx);
      if (openBrace !== -1) {
        let depth = 1, cur = openBrace + 1;
        while (depth > 0 && cur < body.length) {
          if (body[cur] === '{') depth++;
          else if (body[cur] === '}') depth--;
          cur++;
        }
        if (depth === 0) {
          // Eat trailing newlines that follow the closing brace.
          while (cur < body.length && (body[cur] === '\n' || body[cur] === '\r')) cur++;
          const newBody = (body.slice(0, lineStart) + body.slice(cur)).replace(/\n{3,}/g, '\n\n');
          await writeFile(caddyPath, newBody, 'utf8');
          changed = true;
        }
      }
    }
  } catch { /* file missing — nothing to clean */ }

  return changed;
}

app.delete('/api/projects/:name', authed, async (req, res) => {
  const { confirm, removeReverseProxy = true } = req.body || {};
  const project = req.params.name;
  const dir = path.join(HOST_OPT, project);

  if (!project || confirm !== project) {
    return res.status(400).json({ error: 'confirm_required', message: 'POST body must contain { confirm: "<project-name>" }' });
  }
  if (!existsSync(dir)) {
    return res.status(404).json({ error: 'no_such_project' });
  }

  const log = [];
  const push = (line) => log.push(line);

  // 1. Bring the project's stack down (volumes + orphans removed).
  try {
    const overlay = path.join(dir, 'docker-compose.vps.yml');
    const args = ['compose', '-f', 'docker-compose.yml'];
    if (existsSync(overlay)) args.push('-f', 'docker-compose.vps.yml');
    args.push('down', '-v', '--remove-orphans');
    const r = await execFileP('docker', args, { cwd: dir, timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
    push('==> docker compose down -v --remove-orphans');
    push(r.stdout + r.stderr || '(no output)');
  } catch (e) {
    // Don't bail — the project may already be stopped or the compose file
    // may be broken. Just record and move on to the folder removal.
    push('warning during docker compose down: ' + (e.stderr || e.message));
  }

  // 2. Remove the on-disk folder.
  try {
    const r = await execFileP('rm', ['-rf', dir], { timeout: 60_000 });
    push(`==> rm -rf ${dir}`);
    push(r.stdout + r.stderr || '(ok)');
  } catch (e) {
    push('✗ rm -rf failed: ' + (e.stderr || e.message));
    return res.status(500).json({ ok: false, log: log.join('\n') });
  }

  // 3. Optionally strip the reverse-proxy entries.
  let revproxyChanged = false;
  if (removeReverseProxy) {
    revproxyChanged = await removeReverseProxyEntries(project);
    push(revproxyChanged
      ? '==> removed reverse-proxy .env + Caddyfile entries'
      : '==> no reverse-proxy entries found for this project (or nothing to remove)');
  }

  // 4. If we touched reverse-proxy, safely recreate Caddy.
  if (revproxyChanged) {
    const rec = await safeRecreateCaddy();
    push('\n' + rec.log);
    if (!rec.ok) {
      return res.status(207).json({
        ok: true,
        projectRemoved: true,
        revproxyApplied: false,
        log: log.join('\n'),
        warning: 'project removed and revproxy entries cleaned, but Caddy did not restart cleanly — fix the Caddyfile and run Apply .env changes',
      });
    }
  }

  res.json({ ok: true, projectRemoved: true, revproxyApplied: revproxyChanged, log: log.join('\n') });
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
