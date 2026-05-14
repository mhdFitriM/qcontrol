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
    slug: 'fresh-vps-setup',
    name: 'Fresh VPS setup',
    blurb: 'Stand up a brand-new VPS to mirror prod — Docker Engine + firewall + SSH deploy keys + shared reverse-proxy + qcontrol. Used when spinning up staging or a replacement host.',
    domains: ['(any new VPS)'],
    manual: [
      {
        title: 'System update + base tools',
        body: 'Run as root on the freshly-provisioned VPS. Installs the utilities every later step assumes.',
        cmd: `apt-get update && apt-get upgrade -y
apt-get install -y curl git vim htop ufw ca-certificates gnupg lsb-release`,
      },
      {
        title: 'Install Docker Engine (official repo)',
        body: 'Installs docker-ce + the compose v2 plugin. Use `docker compose` (with a space) — there is no standalone docker-compose binary.',
        cmd: `install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

docker --version
docker compose version`,
        note: 'Verify both version commands return something — that confirms the engine + compose plugin are both healthy.',
      },
      {
        title: 'Firewall',
        body: 'Only inbound 22 (SSH) + 80 + 443 are needed — every app on this VPS sits behind the shared reverse-proxy on 80/443.',
        cmd: `ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable
ufw status`,
      },
      {
        title: 'SSH deploy key for private GitHub repos',
        body: 'qcontrol\'s Pull + rebuild uses this key when running git pull against private repos. Generate, then add the public half as a Deploy Key on each private repo (Settings → Deploy keys → Add).',
        cmd: `ssh-keygen -t ed25519 -C "staging-vps-deploy" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub`,
        note: 'Read-only Deploy keys are sufficient for git pull. For an org-wide key, attach to a "deploy bot" user instead.',
      },
      {
        title: 'Bootstrap /opt/reverse-proxy',
        body: 'The shared Caddy that fronts every app on this VPS. Easiest path: scp the entire /opt/reverse-proxy folder from prod, then edit .env to only keep entries for projects that will run on this VPS.',
        cmd: `mkdir -p /opt/reverse-proxy
cd /opt/reverse-proxy

# Option A — copy from prod (run from your laptop):
#   scp -r root@<prod-host>:/opt/reverse-proxy ./

# Option B — start fresh, minimal files:
cat > .env <<'EOF'
ACME_EMAIL=you@example.com
EOF

cat > Caddyfile <<'EOF'
{
    email {$ACME_EMAIL}
}

(common_headers) {
    encode zstd gzip
    header { -Server }
}
EOF

# Drop docker-compose.yml from prod or write a minimal one referencing
# caddy:2 with ports 80/443, /etc/caddy/Caddyfile bind-mounted, and
# --env-file ./.env.

docker compose up -d`,
      },
      {
        title: 'Install qcontrol',
        body: 'Clones the repo, generates a fresh token, sets the VPS name + peers JSON. The peers JSON is what makes the sidebar VPS-switcher appear once both VPSes are configured.',
        cmd: `cd /opt
git clone git@github.com:<your-org>/qcontrol.git
cd qcontrol

# Generate a strong token
TOKEN=$(openssl rand -hex 32)

cat > .env <<EOF
QCONTROL_TOKEN=$TOKEN
QCONTROL_VPS_NAME=staging
QCONTROL_PEERS_JSON=[{"name":"prod","url":"https://qcontrol.qbot.now"},{"name":"staging","url":"https://qcontrol.staging.qbot.now"}]
EOF

docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d

# Save $TOKEN somewhere safe — you'll paste it into the login page.
echo "QCONTROL_TOKEN=$TOKEN"`,
        note: 'Replace QCONTROL_VPS_NAME with this VPS\'s role label (prod / staging / dev / etc.). Keep QCONTROL_PEERS_JSON identical on every peer so the dropdown is consistent.',
      },
      {
        title: 'Wire qcontrol into the reverse-proxy',
        body: 'qcontrol listens on 127.0.0.1:8089 inside the container. The reverse-proxy publishes it on the public domain over HTTPS. flush_interval -1 is REQUIRED so that streaming action output (Pull + rebuild, etc.) appears in the UI in real-time instead of being buffered until each step finishes.',
        cmd: `# /opt/reverse-proxy/.env — append:
echo "" >> /opt/reverse-proxy/.env
echo "QCONTROL_DOMAIN=qcontrol.staging.qbot.now" >> /opt/reverse-proxy/.env
echo "QCONTROL_UPSTREAM=127.0.0.1:8089" >> /opt/reverse-proxy/.env

# /opt/reverse-proxy/Caddyfile — append:
cat >> /opt/reverse-proxy/Caddyfile <<'EOF'

{$QCONTROL_DOMAIN} {
  reverse_proxy {$QCONTROL_UPSTREAM} {
    flush_interval -1
  }
}
EOF

cd /opt/reverse-proxy
docker compose up -d --force-recreate caddy`,
        note: 'Without flush_interval -1 the qcontrol UI looks frozen during long actions — every build step takes ~30s and you see nothing until the very end. Set it once at install and it Just Works.',
      },
      {
        title: 'DNS A record',
        body: 'In cPanel / Cloudflare / wherever the zone lives, create an A record pointing qcontrol.staging.qbot.now to this VPS\'s IPv4 address. Wait 1–2 minutes for propagation, then visit https://qcontrol.staging.qbot.now and paste the token from step 6.',
      },
      {
        title: 'Update the prod VPS to know about staging',
        body: 'So the sidebar VPS-switcher on prod shows the new staging entry. Run on the PROD VPS, not on staging.',
        cmd: `# Edit /opt/qcontrol/.env on the prod VPS
vi /opt/qcontrol/.env
# Make sure QCONTROL_PEERS_JSON includes BOTH prod and staging URLs

cd /opt/qcontrol
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --force-recreate`,
      },
      {
        title: 'Per-project setup',
        body: 'For each app you want to run on this VPS: clone its repo to /opt/<project>, drop its .env in place, then use qcontrol\'s Pull + rebuild button to bring it up. Add reverse-proxy entries for its domains the same way we did for qcontrol in step 7.',
        cmd: `cd /opt
git clone git@github.com:<org>/<project>.git
cd /opt/<project>

# Drop in the project's .env (scp from prod or recreate from .env.example).
# Then in qcontrol: open the project, click Pull + rebuild, type "confirm".`,
        note: 'CI/CD auto-deploys to this VPS need GitHub Actions secrets per repo: STAGING_VPS_HOST, STAGING_VPS_USER, STAGING_VPS_SSH_KEY. Skip this step if you only want manual deploys via qcontrol.',
      },
    ],
    viaQcontrol: [
      {
        title: 'This guide IS the qcontrol install',
        body: 'There\'s no "via qcontrol" shortcut for the initial setup — qcontrol is what you\'re installing in step 6. Once it\'s up, every subsequent project deploy can be done with the Pull + rebuild button (qcontrol auto-detects each project\'s compose layout + project name + private-repo SSH needs).',
      },
      {
        title: 'After qcontrol is up',
        body: 'Future project additions are simpler: clone the repo to /opt/<project>, open it in qcontrol, click Pull + rebuild → type "confirm". qcontrol streams the build + up logs live and reports the status badge as containers come up.',
      },
    ],
  },
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
        title: '/opt/qcontrol/.env — required variables',
        body: 'Created on first install, recreated whenever you add a new peer VPS. Every key listed here must be present, or qcontrol either refuses login (no token) or hides the VPS-switcher (no peers).',
        cmd: `# /opt/qcontrol/.env

# Mandatory — login token. Generate with: openssl rand -hex 32
QCONTROL_TOKEN=<64-hex-char-string>

# Multi-VPS handling. Tells qcontrol "what AM I" and "where are my peers".
# QCONTROL_VPS_NAME labels this VPS in the sidebar; the sidebar dropdown
# is BUILT from QCONTROL_PEERS_JSON. Put both prod + staging in BOTH VPSes'
# peer JSON — the entry whose name == QCONTROL_VPS_NAME gets marked "current"
# and clicking another redirects to its qcontrol URL.
QCONTROL_VPS_NAME=prod
QCONTROL_PEERS_JSON=[{"name":"prod","url":"https://qcontrol.qbot.now"},{"name":"staging","url":"https://qcontrol.staging.qbot.now"}]`,
        note: 'When you spin up a new VPS, update QCONTROL_PEERS_JSON on EVERY existing VPS to include the new entry, then `docker compose ... up -d --force-recreate` qcontrol on each so the dropdown reflects reality.',
      },
      {
        title: 'Reverse-proxy block — must enable flush_interval for live streaming',
        body: 'qcontrol\'s Pull + rebuild / Up / Rebuild / etc. stream output line-by-line. Caddy buffers responses by default, which makes the UI look frozen until each compose step finishes. Adding `flush_interval -1` forces Caddy to flush every write immediately so output appears in the browser in real-time.',
        cmd: `# /opt/reverse-proxy/Caddyfile — qcontrol block:
{$QCONTROL_DOMAIN} {
  reverse_proxy {$QCONTROL_UPSTREAM} {
    flush_interval -1
  }
}

# Apply:
cd /opt/reverse-proxy
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile`,
        note: 'Without `flush_interval -1`, you\'ll see the entire action output dumped in one chunk after every step completes — defeating the point of streaming. Set it once when you wire up qcontrol, never think about it again.',
      },
      {
        title: 'Private repo support — host SSH key must be authorized on GitHub',
        body: 'Pull + rebuild needs git to authenticate against private repos. qcontrol mounts /root/.ssh:ro into its container, so it uses whatever key the VPS\'s root user already has. If pull fails with "Permission denied", grab the public key and add it as a Deploy Key on the GitHub repo.',
        cmd: `# Generate a key if there isn't one yet:
ssh-keygen -t ed25519 -C "qcontrol-deploy" -f ~/.ssh/id_ed25519 -N ""

# View the public key:
cat ~/.ssh/id_ed25519.pub

# Add the printed key on GitHub: repo → Settings → Deploy keys → Add deploy key (read-only is enough for pull).
# Once added, qcontrol's Pull + rebuild against private repos will Just Work.`,
        note: 'Tip: qcontrol\'s Confirm modal has a "Show this VPS\'s deploy public key" disclosure right under the private-repo warning. Click it to copy the .pub contents without leaving the UI.',
      },
      {
        title: 'Pull + rebuild qcontrol itself',
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
      {
        title: 'Adding a new VPS to the switcher',
        body: 'On EVERY existing VPS, edit /opt/qcontrol/.env → update QCONTROL_PEERS_JSON to include the new entry, then run Pull + rebuild on qcontrol itself (or `docker compose ... up -d --force-recreate` manually). The sidebar dropdown picks up the new peer on next page load.',
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
