import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, Check, Copy, Server, Terminal as TerminalIcon, MousePointerClick } from 'lucide-react';

/**
 * Docs hub. Two views:
 *   • Index (/docs)           — grid of all documented projects
 *   • Per-project (/docs/:slug) — tabbed: "Manual via PuTTY/SSH" vs "Via qcontrol UI"
 *
 * Project docs are declared inline below — keep them in this file so the
 * canonical "what command do I run for X" reference travels with qcontrol
 * itself. New projects: add an entry to PROJECT_DOCS.
 */

interface Step {
  title: string;
  body?: string;     // optional prose, rendered above the command block
  cmd?: string;      // multi-line bash; rendered in a copyable terminal block
  note?: string;     // optional follow-up note rendered below
}

interface ProjectDoc {
  slug: string;
  name: string;
  blurb: string;
  domains: string[];
  manual: Step[];
  viaQcontrol: Step[];
}

const COMMON_MANUAL_BOOTSTRAP: Step = {
  title: 'SSH into the VPS',
  body: 'All deployment commands run on the VPS host. From your laptop:',
  cmd: `ssh root@<vps-host>
# or with the key you've registered:
ssh -i ~/.ssh/qbot_vps root@<vps-host>`,
};

const PROJECT_DOCS: ProjectDoc[] = [
  {
    slug: 'qrpos',
    name: 'qrpos',
    blurb: 'Merchant POS — Laravel API + Vite SPA, served at qr.qbot.now via the shared reverse-proxy.',
    domains: ['qr.qbot.now'],
    manual: [
      COMMON_MANUAL_BOOTSTRAP,
      {
        title: 'Pull the latest main',
        cmd: `cd /opt/qrpos
git fetch --all --prune
git reset --hard origin/main
git log -1 --oneline`,
      },
      {
        title: 'Run the deploy script',
        body: 'The repo ships a deploy.sh that does the full cycle: build → up → migrate → cache.',
        cmd: `cd /opt/qrpos
./deploy.sh`,
        note: 'If deploy.sh isn\'t executable yet: chmod +x deploy.sh',
      },
      {
        title: 'Watch the rollout',
        cmd: `cd /opt/qrpos
docker compose -f docker-compose.yml -f docker-compose.vps.yml ps
docker compose -f docker-compose.yml -f docker-compose.vps.yml logs --tail 100 -f`,
      },
      {
        title: 'Verify',
        body: 'Hit the public domain — it should serve the latest build.',
        cmd: `curl -I https://qr.qbot.now`,
      },
    ],
    viaQcontrol: [
      {
        title: 'Open the project in qcontrol',
        body: 'Sidebar → Projects → qrpos. The status badge at the top tells you whether the stack is fully up.',
      },
      {
        title: 'Pull + rebuild in one click',
        body: 'Press Pull + rebuild. Equivalent to git pull + docker compose build --no-cache + up -d --force-recreate. Output streams to the Action output tab.',
      },
      {
        title: 'Check logs if anything is red',
        body: 'Switch to the Container logs tab — qcontrol auto-loads the last 200 lines whenever any container is not running.',
      },
    ],
  },
  {
    slug: 'qbotu',
    name: 'project_qbotu_a3 (qbotu)',
    blurb: 'Hub frontend + Laravel API. Served at hub.qbot.jp and hub-api.qbot.jp via the shared reverse-proxy.',
    domains: ['hub.qbot.jp', 'hub-api.qbot.jp', 'minio.qbotu.example.com'],
    manual: [
      COMMON_MANUAL_BOOTSTRAP,
      {
        title: 'Pull the latest',
        cmd: `cd /opt/project_qbotu_a3
git fetch --all --prune
git reset --hard origin/main`,
      },
      {
        title: 'Rebuild + bring up',
        cmd: `cd /opt/project_qbotu_a3
docker compose -f docker-compose.yml -f docker-compose.vps.yml build --no-cache
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --force-recreate --remove-orphans
docker image prune -f`,
      },
      {
        title: 'Tail logs',
        cmd: `cd /opt/project_qbotu_a3
docker compose -f docker-compose.yml -f docker-compose.vps.yml logs --tail 200 -f`,
      },
    ],
    viaQcontrol: [
      {
        title: 'Pull + rebuild',
        body: 'Projects → project_qbotu_a3 → Pull + rebuild. Status badge confirms when every container is back.',
      },
      {
        title: 'Clone to a staging instance',
        body: 'Use the Clone button on the Projects row. qcontrol auto-allocates ports, rewrites docker-compose.vps.yml + .env (HOST_PORT and every embedded domain), and wires the reverse-proxy with one Caddy block per source domain.',
      },
    ],
  },
  {
    slug: 'qparking',
    name: 'qparking',
    blurb: 'Parking lot system — Laravel backend + Vite frontend behind a single domain (path-split routing). Auto-deploys on push to main.',
    domains: ['parking.qbot.now'],
    manual: [
      COMMON_MANUAL_BOOTSTRAP,
      {
        title: 'Pull + rebuild',
        cmd: `cd /opt/qparking
git fetch --all --prune
git reset --hard origin/main
docker compose -f docker-compose.yml -f docker-compose.vps.yml build --no-cache
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --force-recreate --remove-orphans
docker image prune -f`,
      },
      {
        title: 'Tail logs',
        cmd: `cd /opt/qparking
docker compose -f docker-compose.yml -f docker-compose.vps.yml logs --tail 200 -f`,
      },
    ],
    viaQcontrol: [
      {
        title: 'Automatic CI/CD',
        body: 'qparking has a GitHub Actions workflow that SSHes in and re-deploys on every push to main. You shouldn\'t need to deploy manually unless CI fails.',
      },
      {
        title: 'Force a redeploy',
        body: 'Projects → qparking → Pull + rebuild. Same outcome as the CI workflow.',
      },
    ],
  },
  {
    slug: 'face_auth',
    name: 'face_auth',
    blurb: 'Face authentication — Go backend + Vite admin UI, single domain with path-split routing. Auto-deploys on push to main.',
    domains: ['face.qbot.now'],
    manual: [
      COMMON_MANUAL_BOOTSTRAP,
      {
        title: 'Pull + rebuild',
        cmd: `cd /opt/face_auth
git fetch --all --prune
git reset --hard origin/main
docker compose -f docker-compose.yml -f docker-compose.vps.yml build --no-cache
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --force-recreate --remove-orphans`,
      },
      {
        title: 'Tail logs',
        cmd: `cd /opt/face_auth
docker compose -f docker-compose.yml -f docker-compose.vps.yml logs --tail 200 -f`,
      },
    ],
    viaQcontrol: [
      {
        title: 'Automatic CI/CD',
        body: 'face_auth has a GitHub Actions workflow that SSHes in and re-deploys on every push to main.',
      },
      {
        title: 'Manual redeploy',
        body: 'Projects → face_auth → Pull + rebuild.',
      },
    ],
  },
  {
    slug: 'reverse-proxy',
    name: 'reverse-proxy',
    blurb: 'Shared Caddy that fronts every domain on the VPS. Edits hit /opt/reverse-proxy/.env and /opt/reverse-proxy/Caddyfile.',
    domains: ['(all *.qbot.now and *.qbot.jp domains)'],
    manual: [
      COMMON_MANUAL_BOOTSTRAP,
      {
        title: 'Edit Caddyfile or .env',
        cmd: `cd /opt/reverse-proxy
vi Caddyfile      # add or edit reverse_proxy blocks
vi .env           # add the *_DOMAIN and *_UPSTREAM lines they reference`,
      },
      {
        title: 'Validate before reloading',
        body: 'A bad Caddyfile takes every site down. Always validate first.',
        cmd: `cd /opt/reverse-proxy
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile`,
      },
      {
        title: 'Reload (zero downtime, Caddyfile edits only)',
        cmd: `cd /opt/reverse-proxy
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile`,
      },
      {
        title: 'Recreate (~1s downtime, required for new .env vars)',
        body: 'Caddy expands {$VAR} only at container startup, so new env vars need a recreate, not a reload.',
        cmd: `cd /opt/reverse-proxy
docker compose up -d --force-recreate caddy`,
      },
    ],
    viaQcontrol: [
      {
        title: 'Edit in the browser',
        body: 'Sidebar → Reverse proxy. Two tabs (.env / Caddyfile) backed by /opt/reverse-proxy. Save writes to disk only.',
      },
      {
        title: 'Apply changes',
        body: 'Validate runs caddy validate (no side effects). Validate & reload Caddy applies Caddyfile-only edits with zero downtime. Apply .env changes pre-validates then recreates the container (~1s downtime) — required when you\'ve added a new *_DOMAIN / *_UPSTREAM pair.',
      },
    ],
  },
  {
    slug: 'qcontrol',
    name: 'qcontrol',
    blurb: 'This panel. Single Node container that shells out to docker via the host\'s socket. Auto-deploys on push to main.',
    domains: ['qcontrol.qbot.now'],
    manual: [
      COMMON_MANUAL_BOOTSTRAP,
      {
        title: 'Pull + rebuild',
        cmd: `cd /opt/qcontrol
git fetch --all --prune
git reset --hard origin/main
docker compose -f docker-compose.yml -f docker-compose.vps.yml build --no-cache
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --force-recreate --remove-orphans
docker image prune -f
docker compose -f docker-compose.yml -f docker-compose.vps.yml ps`,
      },
      {
        title: 'Logs',
        cmd: `cd /opt/qcontrol
docker compose -f docker-compose.yml -f docker-compose.vps.yml logs --tail 200 -f`,
      },
    ],
    viaQcontrol: [
      {
        title: 'You\'re using it',
        body: 'qcontrol manages itself the same way — Projects → qcontrol → Pull + rebuild. The page will disconnect for ~5s while the container restarts; refresh after.',
      },
    ],
  },
];

export function DocsIndex() {
  return (
    <div className="p-5 sm:p-8 max-w-5xl">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Docs</h1>
        <p className="mt-1 text-sm text-gray-500">
          Deployment + operations notes for every project on this VPS. Each entry has a "manual via SSH/PuTTY" tab and a "via qcontrol" tab.
        </p>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {PROJECT_DOCS.map((d) => (
          <Link
            key={d.slug}
            to={`/docs/${d.slug}`}
            className="block rounded-xl border border-gray-200 bg-white p-4 hover:border-gray-900 transition-colors"
          >
            <div className="flex items-center gap-2 text-sm font-bold text-gray-900">
              <div className="w-8 h-8 rounded-md bg-gray-900 text-white flex items-center justify-center flex-shrink-0">
                <BookOpen size={14} strokeWidth={2.5} />
              </div>
              <span className="font-mono">{d.name}</span>
            </div>
            <p className="mt-2 text-xs text-gray-600 leading-relaxed">{d.blurb}</p>
            <div className="mt-2.5 flex flex-wrap gap-1">
              {d.domains.map((dom) => (
                <span key={dom} className="inline-flex items-center px-2 py-0.5 rounded bg-gray-100 text-gray-700 font-mono text-[10px]">{dom}</span>
              ))}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function DocsProject() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const doc = useMemo(() => PROJECT_DOCS.find((d) => d.slug === slug), [slug]);
  const [tab, setTab] = useState<'manual' | 'qcontrol'>('manual');

  useEffect(() => { setTab('manual'); }, [slug]);

  if (!doc) {
    return (
      <div className="p-5 sm:p-8 max-w-3xl">
        <button onClick={() => navigate('/docs')} className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900">
          <ArrowLeft size={14} strokeWidth={2.5} /> Docs
        </button>
        <h1 className="mt-3 text-2xl font-bold tracking-tight text-gray-900">Not found</h1>
        <p className="mt-1 text-sm text-gray-500">No docs entry for <code className="font-mono">{slug}</code>. Add one to <code className="font-mono">qcontrol/web/src/pages/Docs.tsx</code>.</p>
      </div>
    );
  }

  const steps = tab === 'manual' ? doc.manual : doc.viaQcontrol;

  return (
    <div className="p-5 sm:p-8 max-w-4xl">
      <button onClick={() => navigate('/docs')} className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900">
        <ArrowLeft size={14} strokeWidth={2.5} /> Docs
      </button>
      <h1 className="mt-3 text-2xl font-bold tracking-tight text-gray-900 font-mono">{doc.name}</h1>
      <p className="mt-1 text-sm text-gray-600 leading-relaxed">{doc.blurb}</p>
      {doc.domains.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {doc.domains.map((dom) => (
            <span key={dom} className="inline-flex items-center px-2 py-0.5 rounded bg-gray-100 text-gray-700 font-mono text-[10px]">{dom}</span>
          ))}
        </div>
      )}

      <div className="mt-5 inline-flex bg-gray-100 rounded-lg p-1 gap-1">
        <button
          onClick={() => setTab('manual')}
          className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-xs font-bold uppercase tracking-wide transition-colors ${
            tab === 'manual' ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <TerminalIcon size={12} strokeWidth={2.5} />
          Manual (SSH / PuTTY)
        </button>
        <button
          onClick={() => setTab('qcontrol')}
          className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-xs font-bold uppercase tracking-wide transition-colors ${
            tab === 'qcontrol' ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          <MousePointerClick size={12} strokeWidth={2.5} />
          Via qcontrol
        </button>
      </div>

      <ol className="mt-5 space-y-4">
        {steps.map((s, i) => (
          <li key={i} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 sm:px-5 py-3 border-b border-gray-100 flex items-center gap-3">
              <div className="w-6 h-6 rounded-full bg-gray-900 text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0 tabular-nums">{i + 1}</div>
              <h3 className="text-sm font-semibold text-gray-900">{s.title}</h3>
            </div>
            <div className="p-4 sm:p-5 space-y-3">
              {s.body && <p className="text-sm text-gray-700 leading-relaxed">{s.body}</p>}
              {s.cmd && <TerminalBlock cmd={s.cmd} />}
              {s.note && <p className="text-xs text-gray-500 italic leading-relaxed">{s.note}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TerminalBlock({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  }
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-800 bg-gray-900">
        <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-gray-400">
          <Server size={11} strokeWidth={2.5} />
          Terminal
        </div>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1 px-2 h-6 rounded text-[10px] font-semibold uppercase tracking-wide text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
        >
          {copied ? <Check size={11} strokeWidth={2.5} /> : <Copy size={11} strokeWidth={2.5} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="px-4 py-3 text-xs leading-relaxed font-mono text-green-200 whitespace-pre overflow-x-auto">
{cmd}
      </pre>
    </div>
  );
}
