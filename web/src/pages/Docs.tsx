import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  BookOpen,
  Check,
  Copy,
  Server,
  Terminal as TerminalIcon,
  Rocket,
  Wrench,
  Code,
  Github,
  ExternalLink,
  Cpu,
} from 'lucide-react';

/**
 * Docs hub. Two views:
 *   • Index (/docs)           — grid of all documented projects
 *   • Per-project (/docs/:slug) — 4 tabs:
 *         Start Fresh   — clone + env + reverse-proxy port wiring (first-time install)
 *         Dev Mode      — run the stack locally on a laptop / workstation
 *         Prod Mode     — deploy + run on the VPS
 *         Maintenance   — troubleshooting: logs, port conflicts, DB resets, etc.
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
  images?: { src: string; alt: string; caption?: string }[];
}

interface ProjectDoc {
  slug: string;
  name: string;
  repo?: string;              // GitHub URL — clickable pill in the header
  blurb: string;
  domains: string[];
  reverseProxyPort?: string;  // e.g. "127.0.0.1:8083" — shown as a badge for quick copy
  start: Step[];
  dev: Step[];
  prod: Step[];
  maintenance: Step[];
  vpsKnowledge?: Step[];      // optional 5th tab — used by Fresh VPS setup only
}

const COMMON_SSH_NOTE: Step = {
  title: 'SSH into the VPS as root',
  body: 'These commands run on the VPS. If your Linux/WSL laptop has ssh: `ssh root@<vps-host>`. On Windows use PuTTY with your qbot.ppk key (setup screenshots in the Fresh VPS setup docs). All commands below assume you are logged in.',
};

const COMMON_PUTTY_STEP: Step = {
  title: 'Connect to the VPS with PuTTY',
  body: 'All VPS commands run as root. On Windows use PuTTY with a .ppk private key (kept at C:\\Users\\<you>\\Documents\\qbot.ppk). Public half is already in /root/.ssh/authorized_keys on every Qbot VPS.',
  cmd: `# 1. Open PuTTY (Start → PuTTY → PuTTY)
#
# 2. Session pane:
#       Host Name (or IP address): <vps-host or IP>
#       Port: 22
#       Connection type: SSH
#
# 3. Connection → SSH → Auth → Credentials:
#       "Private key file for authentication": C:\\Users\\<you>\\Documents\\qbot.ppk
#
# 4. Connection → Data:
#       Auto-login username: root
#
# 5. Save the session as "qbot-prod" → double-click to login next time.`,
  note: "If you don't have qbot.ppk yet, ask another admin for it (or generate a new keypair with PuTTYgen and have your public key added to /root/.ssh/authorized_keys). Never share the .ppk over chat.",
  images: [
    { src: '/docs/putty/01-session.png', alt: 'PuTTY Session pane — Host Name, Port 22, SSH', caption: '1. Session pane — Host Name + Port 22 + SSH.' },
    { src: '/docs/putty/02-ssh-auth-credentials.png', alt: 'PuTTY SSH → Auth → Credentials with qbot.ppk', caption: '2. Connection → SSH → Auth → Credentials → Browse to qbot.ppk.' },
    { src: '/docs/putty/03-connection-data.png', alt: 'PuTTY Connection → Data with root autologin', caption: '3. Connection → Data → Auto-login username = root.' },
    { src: '/docs/putty/04-saved-sessions.png', alt: 'PuTTY Saved Sessions list', caption: '4. Save the session — one double-click logs you in next time.' },
  ],
};

const COMMON_REVERSE_PROXY_STEP = (domain: string, envKey: string, upstream: string, extraDirectives?: string): Step => ({
  title: `Wire the domain into /opt/reverse-proxy`,
  body: `The shared Caddy at /opt/reverse-proxy terminates TLS for every project on this VPS. Add the *_DOMAIN + *_UPSTREAM pair to .env, add the reverse_proxy block to Caddyfile, then recreate Caddy.`,
  cmd: `# 1. Append the pair to /opt/reverse-proxy/.env
cat >> /opt/reverse-proxy/.env <<'EOF'
${envKey}_DOMAIN=${domain}
${envKey}_UPSTREAM=${upstream}
EOF

# 2. Append the reverse_proxy block to /opt/reverse-proxy/Caddyfile
cat >> /opt/reverse-proxy/Caddyfile <<'EOF'

{\$${envKey}_DOMAIN} {
  reverse_proxy {\$${envKey}_UPSTREAM}${extraDirectives ? ' {\n    ' + extraDirectives + '\n  }' : ''}
}
EOF

# 3. Validate + recreate (new env vars need recreate, not reload)
cd /opt/reverse-proxy
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile
docker compose up -d --force-recreate caddy`,
  note: `DNS A record for ${domain} must point to this VPS's IPv4 BEFORE the first request — Caddy issues the TLS cert via Let's Encrypt HTTP-01 challenge and needs the domain resolving to us. Set the record 1–2 min before the first curl.`,
});

// -----------------------------------------------------------------------------
// PROJECT DOCS
// -----------------------------------------------------------------------------

const PROJECT_DOCS: ProjectDoc[] = [
  // ---------------------------------------------------------------------------
  // FRESH VPS SETUP (no repo — this IS the platform bootstrap)
  // ---------------------------------------------------------------------------
  {
    slug: 'fresh-vps-setup',
    name: 'Fresh VPS setup',
    blurb: 'Stand up a brand-new VPS to mirror prod — Docker Engine + firewall + SSH deploy keys + SFTP user + shared reverse-proxy + qcontrol. Used when spinning up staging or a replacement host.',
    domains: ['(any new VPS)'],
    start: [
      {
        title: 'System update + base tools',
        body: 'Run as root on the freshly-provisioned VPS. Installs the utilities every later step assumes.',
        cmd: `apt-get update && apt-get upgrade -y
apt-get install -y curl git vim htop ufw ca-certificates gnupg lsb-release`,
      },
      {
        title: 'Install Docker Engine (official repo)',
        body: 'Installs docker-ce + compose v2 plugin. Use `docker compose` (with a space) — there is no standalone docker-compose binary.',
        cmd: `install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

docker --version
docker compose version`,
      },
      {
        title: 'Firewall (UFW) — only 22 / 80 / 443',
        body: 'Every app sits behind the shared reverse-proxy on 80/443. No app publishes its own port to the public interface.',
        cmd: `ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable
ufw status`,
      },
      {
        title: 'Chrooted SFTP user (for WinSCP file transfers)',
        body: 'A dedicated sftpuser with password auth, chrooted to /opt so they can only see project folders — never share root credentials for file transfers.',
        cmd: `# 1. Create the user — no shell so they can ONLY sftp, not ssh:
useradd -m -d /home/sftpuser -s /usr/sbin/nologin sftpuser
echo "sftpuser:<choose-a-strong-password>" | chpasswd

# 2. Chroot requires /opt to be root-owned + not group/world writable:
chown root:root /opt
chmod 755 /opt

# 3. Group sftpuser write access on project subdirs:
groupadd -f sftpusers
usermod -aG sftpusers sftpuser
for d in /opt/reverse-proxy /opt/qcontrol; do
  [ -d "$d" ] && chgrp -R sftpusers "$d" && chmod -R g+rwX "$d" && chmod g+s "$d"
done

# 4. SSH/SFTP chroot dropin:
cat > /etc/ssh/sshd_config.d/10-sftpuser.conf <<'EOF'
Match User sftpuser
    ChrootDirectory /opt
    ForceCommand internal-sftp
    AllowTcpForwarding no
    X11Forwarding no
    PasswordAuthentication yes
EOF

# 5. Validate + reload sshd
sshd -t && systemctl restart ssh    # Ubuntu/Debian
# sshd -t && systemctl restart sshd # RHEL/CentOS/Rocky/Fedora`,
        note: 'Test with WinSCP: Protocol=SFTP, Host=<vps-ip>, User=sftpuser. You should land inside /opt without being able to cd above.',
      },
      {
        title: 'SSH deploy key for private GitHub repos',
        body: "qcontrol's Pull + rebuild uses this key when running git pull against private repos. Add the public half as a Deploy Key on each private repo (Settings → Deploy keys → Add).",
        cmd: `ssh-keygen -t ed25519 -C "vps-deploy-$(hostname)" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub

# Copy the printed line and add it to:
#   GitHub repo → Settings → Deploy keys → Add deploy key (read-only is fine)`,
      },
      {
        title: 'Bootstrap /opt/reverse-proxy (shared Caddy)',
        body: 'The shared Caddy that fronts every app on this VPS. Easiest path: copy /opt/reverse-proxy from prod using WinSCP, then edit .env to keep only the projects that will run on this VPS.',
        cmd: `mkdir -p /opt/reverse-proxy && cd /opt/reverse-proxy

# --- Option A: clone from GitHub (see reverse-proxy project docs)
git clone https://github.com/mhdFitriM/reverse-proxy.git .

# --- Option B: copy from prod (run on your laptop):
#   pscp -i qbot.ppk -r root@<prod>:/opt/reverse-proxy/ .
#   pscp -i qbot.ppk -r . root@<new-vps>:/opt/reverse-proxy/

# --- First boot:
cp .env.example .env  # edit ACME_EMAIL etc.
docker compose up -d
docker compose ps`,
      },
      {
        title: 'Install qcontrol',
        body: "Clones the qcontrol repo, generates a fresh token, and sets the VPS name + peers JSON so the sidebar VPS-switcher works.",
        cmd: `cd /opt && git clone https://github.com/mhdFitriM/qcontrol.git
cd qcontrol

TOKEN=$(openssl rand -hex 32)
cat > .env <<EOF
QCONTROL_TOKEN=$TOKEN
QCONTROL_VPS_NAME=staging
QCONTROL_PEERS_JSON=[{"name":"prod","url":"https://qcontrol.qbot.now"},{"name":"staging","url":"https://qcontrol.staging.qbot.now"}]
EOF

docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d
echo "TOKEN=$TOKEN   ← save this, you'll paste it into the login page"`,
      },
      {
        title: 'Wire qcontrol into the reverse-proxy',
        body: "qcontrol listens on 127.0.0.1:8089. `flush_interval -1` is REQUIRED so streaming action output (Pull + rebuild etc.) appears live instead of buffered.",
        cmd: `cat >> /opt/reverse-proxy/.env <<'EOF'
QCONTROL_DOMAIN=qcontrol.staging.qbot.now
QCONTROL_UPSTREAM=127.0.0.1:8089
EOF

cat >> /opt/reverse-proxy/Caddyfile <<'EOF'

{$QCONTROL_DOMAIN} {
  reverse_proxy {$QCONTROL_UPSTREAM} {
    flush_interval -1
  }
}
EOF

cd /opt/reverse-proxy && docker compose up -d --force-recreate caddy`,
      },
      {
        title: 'DNS A record',
        body: 'In cPanel / Cloudflare / wherever the zone lives, add an A record: qcontrol.staging.qbot.now → <this VPS IPv4>. Wait 1–2 min, then load https://qcontrol.staging.qbot.now and paste the token.',
      },
    ],
    dev: [
      {
        title: 'N/A — this guide IS the VPS install',
        body: "This project is a runbook, not a stack you run in dev mode. Every subsequent per-project doc has its own Dev Mode tab for running that specific stack on your laptop.",
      },
    ],
    prod: [
      {
        title: 'Per-project deploy',
        body: "Once /opt/reverse-proxy + qcontrol are up, adding a new project on this VPS is: clone repo → drop .env → add reverse-proxy block → open in qcontrol → Pull + rebuild. See individual project docs for the exact port each app uses.",
        cmd: `cd /opt && git clone git@github.com:<org>/<project>.git
cd /opt/<project>
# Drop in .env (WinSCP from prod, or copy from .env.example)
# Add reverse-proxy block for the project's domain + port
# Open in qcontrol UI → Pull + rebuild → type "confirm"`,
      },
      {
        title: 'Update peer VPSes to know about this one',
        body: 'On EVERY existing qcontrol install, edit /opt/qcontrol/.env → QCONTROL_PEERS_JSON to include the new entry, then Pull + rebuild qcontrol on each.',
      },
    ],
    maintenance: [
      {
        title: "Docker won't start after reboot",
        cmd: `systemctl status docker
journalctl -u docker.service --tail 200

# Full stack restart:
systemctl restart docker
cd /opt/reverse-proxy && docker compose up -d`,
      },
      {
        title: "SFTP user can't login / can cd above /opt",
        cmd: `# Chroot fails silently if /opt isn't root-owned. Verify:
ls -ld /opt
# Must show:  drwxr-xr-x root root

# Then re-check the drop-in:
sshd -T -C user=sftpuser | grep -iE "chroot|forcecommand"`,
      },
      {
        title: 'Free disk space',
        cmd: `df -h                     # overall
du -shx /var/lib/docker  # docker overhead
docker system prune -f   # remove stopped containers + dangling images
docker image prune -a -f # aggressive: removes all unused images`,
      },
    ],
    vpsKnowledge: [
      {
        title: 'Why every Docker project lives in /opt/<name>',
        body: 'Filesystem-Hierarchy Standard convention. `/opt` is defined as "add-on software" — long-lived third-party services (which every Docker stack effectively is from the host\'s POV). Concretely:\n\n  • /home = user home dirs. Wrong for stacks that live longer than any user.\n  • /var = system-managed logs + databases. Docker already writes there via /var/lib/docker.\n  • /srv = "data served by this system" (websites, FTP). Historically LSB but rarely used.\n  • /opt = the right home for self-contained, mount-anywhere Docker stacks.\n\nUsing /opt uniformly means: backups have one root to grep, permissions are consistent (root:sftpusers 775), deploy scripts can assume /opt/<slug>, and the SFTP chroot works out of the box.',
      },
      {
        title: 'Keeping the VPS itself up-to-date',
        body: 'Once a month or after a security advisory. Kernel updates need a reboot; everything else is live.',
        cmd: `# 1. Fetch package index + upgrade everything installed:
apt-get update
apt-get upgrade -y            # bug/security fixes
apt-get dist-upgrade -y       # ALSO installs new deps (may pull new kernel)

# 2. Remove obsolete packages:
apt-get autoremove -y
apt-get autoclean

# 3. Check if a reboot is required (kernel or libc updated):
[ -f /var/run/reboot-required ] && echo "REBOOT REQUIRED" || echo "no reboot needed"
cat /var/run/reboot-required.pkgs 2>/dev/null   # which pkgs need it

# 4. If yes — WARN in the team channel first, then:
shutdown -r now     # or:  systemctl reboot`,
        note: 'Reboots kill every container. After boot, Docker\'s restart policy (unless-stopped / always in our compose files) brings them back — usually. Verify: `docker ps` should list everything within 30s.',
      },
      {
        title: 'Checking listening ports — who has 3306 / 8080 / 443?',
        body: 'When a deploy says "port already in use", find the culprit.',
        cmd: `# ss is the modern replacement for netstat (already installed on Ubuntu):
ss -tlnp                             # all TCP listeners
ss -tlnp | grep :3306                # who owns MySQL port
ss -tlnp sport = :443                # who owns HTTPS

# Legacy netstat (only if you insist):
netstat -tlnp | grep 3306

# Once you know the port is taken, find the container:
docker ps --format '{{.Names}}\\t{{.Ports}}' | grep 3306

# Or the host process:
lsof -i :3306                        # apt-get install lsof
fuser -n tcp 3306                    # alternative`,
      },
      {
        title: 'Checking RAM',
        cmd: `# Human-readable snapshot:
free -h
#                total   used   free  shared  buff/cache  available
# Mem:            3.8Gi  1.2Gi  180Mi   32Mi     2.4Gi      2.4Gi   ← "available" is what matters
# Swap:           2.0Gi  120Mi  1.9Gi

# Per-container memory:
docker stats --no-stream

# Sorted by RSS (biggest first):
ps aux --sort=-rss | head -20`,
        note: '"available" (not "free") is the real number. Linux uses spare RAM as disk cache — high "used" is normal and healthy. If "available" drops below ~200 MB the OOM killer is minutes away from firing.',
      },
      {
        title: 'htop — live view of everything',
        body: 'Better `top`: coloured, sortable, keyboard-driven. If not installed: `apt-get install -y htop`.',
        cmd: `htop
# Inside htop:
#   F2   Setup    — toggle columns (add IO_READ_RATE / IO_WRITE_RATE for disk)
#   F3   Search   — jump to a process by name
#   F4   Filter   — hide everything except matching processes
#   F5   Tree     — see parent/child (Docker daemon → containerd → containers)
#   F6   Sort by  — CPU%, MEM%, TIME, PID
#   F9   Kill     — sends signal to selected process
#   /    Same as F3
#   u    Filter by user (pick www-data to see all PHP-FPM workers)
#   H    Show/hide user threads
#   K    Show/hide kernel threads
#   q    Quit`,
      },
      {
        title: 'Disk usage — where did 40 GB go?',
        cmd: `df -h                            # per-filesystem
df -h /var/lib/docker            # is docker filling up?

# Biggest directories (top-level):
du -shx /* 2>/dev/null | sort -hr | head -20

# Docker-specific:
docker system df                 # what's using docker's disk
docker system df -v              # per-image / per-volume breakdown

# Log spam (journald):
journalctl --disk-usage
journalctl --vacuum-time=7d      # keep last 7 days only

# Container logs (docker's own — not journald):
du -sh /var/lib/docker/containers/*/*-json.log | sort -hr | head`,
        note: 'If /var/lib/docker is huge: `docker system prune -f` removes stopped containers + dangling images. `docker image prune -a -f` removes ALL unused images (aggressive but reversible — you just re-pull/rebuild next deploy).',
      },
      {
        title: 'CPU load + who is burning it',
        cmd: `# 1-min / 5-min / 15-min load averages (compare to CPU count):
uptime
nproc                       # how many CPUs — load 1.0 per CPU = fully busy

# Top CPU consumers:
ps aux --sort=-%cpu | head -20

# Per-container:
docker stats --no-stream --format 'table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}'`,
      },
      {
        title: 'Reading systemd + docker logs',
        cmd: `# systemd services (any *.service you set up):
systemctl status <service>
systemctl restart <service>
journalctl -u <service> -f --tail 200

# Docker daemon itself:
journalctl -u docker.service -f

# Container logs — both patterns:
docker logs <container-name> --tail 200 -f
cd /opt/<project> && docker compose logs -f <service>

# Anything to stderr on the console during boot:
dmesg | tail -50`,
      },
      {
        title: 'Users, sudo, and who is currently logged in',
        cmd: `who                    # who's logged in RIGHT NOW
last -n 20             # last 20 logins (audit trail)
lastb -n 20            # last 20 FAILED login attempts (brute-force check)

# List all users with a shell:
grep -E "/bin/(bash|zsh|sh)$" /etc/passwd

# Add / remove sudo:
usermod -aG sudo <user>
gpasswd -d <user> sudo

# Root's SSH-authorized public keys:
cat /root/.ssh/authorized_keys`,
      },
      {
        title: 'Firewall — UFW cheat sheet',
        cmd: `ufw status verbose            # show all rules
ufw allow OpenSSH             # port 22
ufw allow 80                  # HTTP (Caddy)
ufw allow 443                 # HTTPS (Caddy)
ufw allow from 1.2.3.4 to any port 3306   # DB port only from this office IP
ufw delete allow 3306          # remove a rule
ufw disable                   # PANIC BUTTON — only if you\'re locked out via console`,
        note: 'Never `ufw enable` without first allowing OpenSSH — you\'ll lock yourself out of the VPS. The default-deny will kill your active SSH session too. Test rules from a second SSH session before disabling the first.',
      },
      {
        title: 'DNS + connectivity tests',
        cmd: `# Does the domain point here?
dig +short qr.qbot.now A       # should return this VPS's IPv4
dig +short qr.qbot.now AAAA    # IPv6 (if you use it)

# Can this VPS resolve outbound?
dig +short google.com          # sanity check DNS
curl -I https://github.com     # sanity check HTTPS egress

# Traceroute (when a client says "the site is slow from Malaysia"):
mtr -rw --report-cycles 20 qr.qbot.now
traceroute qr.qbot.now`,
      },
      {
        title: 'Backup best practices for this VPS',
        body: 'Rule of thumb: if it lives only on this VPS, it\'s gone tomorrow. Always have a copy elsewhere.',
        cmd: `# 1. MySQL dumps live in /opt/<project>/data/backups/ (per-project cron).
# 2. Weekly full snapshot at the hypervisor level (DigitalOcean / Linode / Contabo panel).
# 3. Off-site copy of /opt/reverse-proxy/{.env,Caddyfile} — this is the ONE
#    config that binds every project to its domain. Losing it means rebuilding
#    every reverse_proxy block from memory. Push it to a private GitHub repo:

cd /opt/reverse-proxy
git init
git remote add origin git@github.com:mhdFitriM/reverse-proxy.git
git add .env Caddyfile
git commit -m "snapshot $(date +%F)"
git push -u origin main`,
      },
      {
        title: 'Emergency: locked out of SSH',
        body: 'If you break sshd_config, a firewall rule, or authorized_keys, your terminal freezes but the VPS is still running. Recovery:',
        cmd: `# 1. Open the hypervisor console (DigitalOcean → Droplet → Access → Recovery Console).
# 2. Log in as root with the panel password (or "Reset root password" first).
# 3. Undo the last change:
#      cat /etc/ssh/sshd_config.d/10-sftpuser.conf
#      systemctl restart ssh
#      ufw disable
# 4. THEN reconnect via SSH and fix properly.

# Prevention: before touching sshd_config, ALWAYS have a second SSH session
# open in another window — if the reload breaks new logins, the existing one
# can undo the change.`,
      },
      {
        title: 'Read the shared reverse-proxy port table before adding a new project',
        body: 'Every project on this VPS binds to a specific loopback port. See the reverse-proxy project docs (Start Fresh tab) for the canonical table. Pick the next free number in the 80xx range — never reuse a port, never bind to 0.0.0.0 (that would collide with Caddy on 80/443).',
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // REVERSE-PROXY
  // ---------------------------------------------------------------------------
  {
    slug: 'reverse-proxy',
    name: 'reverse-proxy',
    repo: 'https://github.com/mhdFitriM/reverse-proxy.git',
    blurb: 'Shared Caddy that fronts every domain on the VPS. Runs in network_mode: host so it can reach every project on 127.0.0.1:80xx. Edits hit /opt/reverse-proxy/.env and /opt/reverse-proxy/Caddyfile.',
    domains: ['(all *.qbot.now, *.qbot.jp, aigenius.now, etc.)'],
    reverseProxyPort: 'host: 80 + 443',
    start: [
      COMMON_PUTTY_STEP,
      {
        title: 'Clone the repo',
        cmd: `cd /opt
git clone https://github.com/mhdFitriM/reverse-proxy.git
cd reverse-proxy`,
      },
      {
        title: 'Configure .env',
        cmd: `cp .env.example .env
vi .env
# Required:
#   ACME_EMAIL=you@example.com   # Let's Encrypt registration email
# Plus one *_DOMAIN + *_UPSTREAM pair per project (added as you deploy each app).`,
      },
      {
        title: 'First boot',
        cmd: `docker compose up -d
docker compose ps
# Expect the caddy container to be Up. Certs mint automatically on first request.`,
      },
      {
        title: 'Port table (canonical assignments)',
        body: 'Every app binds only to 127.0.0.1:<port>. Caddy proxies public 443 → 127.0.0.1:<port>. Keep this table in sync with reality — collision = broken deploy.',
        cmd: `127.0.0.1:8081  →  QBotu (project_qbotu_a3 caddy)
127.0.0.1:8082  →  faceapp (old Hikvision turnstile)
127.0.0.1:8083  →  qrpos
127.0.0.1:8084  →  face_auth API (new HIK Vision controller)
127.0.0.1:8085  →  face_auth Admin UI
127.0.0.1:8086  →  qparking backend
127.0.0.1:8087  →  qparking frontend
127.0.0.1:8088  →  (reserved — shopamine when deployed)
127.0.0.1:8089  →  qcontrol
127.0.0.1:8090  →  aigenius-full (web nginx)
127.0.0.1:8091  →  aigeniusBackend (OLD version)
127.0.0.1:8092  →  qbot-checkin backend (FISB)
127.0.0.1:8093  →  Wonderstar backend`,
      },
    ],
    dev: [
      {
        title: 'Run Caddy locally against a test Caddyfile',
        body: 'For iterating on Caddyfile edits without touching a VPS. Requires Docker Desktop.',
        cmd: `git clone https://github.com/mhdFitriM/reverse-proxy.git
cd reverse-proxy
cp .env.example .env

# Point *_UPSTREAM to a local dev container or use "respond \"hello\"" for smoke test.
docker compose up
# Open http://localhost:80`,
      },
    ],
    prod: [
      COMMON_PUTTY_STEP,
      {
        title: 'Edit Caddyfile or .env',
        cmd: `cd /opt/reverse-proxy
vi Caddyfile      # add or edit reverse_proxy blocks
vi .env           # add the *_DOMAIN and *_UPSTREAM lines they reference`,
      },
      {
        title: 'Validate before applying — a bad Caddyfile takes every site down',
        cmd: `docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile`,
      },
      {
        title: 'Reload (zero downtime, Caddyfile-only)',
        cmd: `docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile`,
      },
      {
        title: 'Recreate (~1s downtime, required for new .env vars)',
        body: 'Caddy expands {$VAR} only at container startup — new env vars need a recreate, not a reload.',
        cmd: `docker compose up -d --force-recreate caddy`,
      },
    ],
    maintenance: [
      {
        title: 'Cert stuck in "waiting for HTTP challenge"',
        cmd: `docker compose logs --tail 200 caddy | grep -i acme
# Check the DNS A record actually points here:
dig +short <the-domain>
# Should match the VPS's public IPv4. If not, fix the DNS zone.`,
      },
      {
        title: '502 Bad Gateway on one domain',
        body: 'Means Caddy is up but cannot reach the upstream. Ninety percent of the time the upstream container is down.',
        cmd: `# Which upstream was it?
grep -A1 '<the-broken-domain>' /opt/reverse-proxy/Caddyfile
# Then check that upstream project:
cd /opt/<that-project>
docker compose ps
docker compose logs --tail 100`,
      },
      {
        title: 'Port collision with a project — Caddy takes 80/443',
        body: 'No app on this VPS may bind to 0.0.0.0:80/443. If a docker-compose.yml has "80:80" instead of "127.0.0.1:80xx:80", it will conflict with Caddy. Fix the project compose, not Caddy.',
      },
      {
        title: 'View all sites Caddy is serving',
        cmd: `docker compose exec -T caddy caddy list-modules | grep -i acme
# Or dump the resolved config:
docker compose exec -T caddy caddy adapt --config /etc/caddy/Caddyfile | jq . | head -60`,
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // QCONTROL
  // ---------------------------------------------------------------------------
  {
    slug: 'qcontrol',
    name: 'qcontrol',
    repo: 'https://github.com/mhdFitriM/qcontrol.git',
    blurb: 'This panel. Single Go container that shells out to docker via the host socket. Manages every /opt/<project> from the browser. Auto-deploys on push to main.',
    domains: ['qcontrol.qbot.now', 'qcontrol.staging.qbot.now'],
    reverseProxyPort: '127.0.0.1:8089',
    start: [
      COMMON_PUTTY_STEP,
      {
        title: 'Clone + generate token',
        cmd: `cd /opt
git clone https://github.com/mhdFitriM/qcontrol.git
cd qcontrol

TOKEN=$(openssl rand -hex 32)
cat > .env <<EOF
QCONTROL_TOKEN=$TOKEN
QCONTROL_VPS_NAME=prod
QCONTROL_PEERS_JSON=[{"name":"prod","url":"https://qcontrol.qbot.now"},{"name":"staging","url":"https://qcontrol.staging.qbot.now"}]
EOF

echo "SAVE THIS TOKEN: $TOKEN"`,
      },
      {
        title: 'First boot (VPS overlay)',
        cmd: `cd /opt/qcontrol
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d
docker compose -f docker-compose.yml -f docker-compose.vps.yml ps`,
      },
      COMMON_REVERSE_PROXY_STEP('qcontrol.qbot.now', 'QCONTROL', '127.0.0.1:8089', 'flush_interval -1'),
      {
        title: 'Why flush_interval -1 is mandatory',
        body: "qcontrol's Pull + rebuild streams output line-by-line. Caddy buffers responses by default, making the UI look frozen until each compose step finishes. flush_interval -1 forces Caddy to flush every write immediately.",
      },
    ],
    dev: [
      {
        title: 'Clone + install deps',
        cmd: `git clone https://github.com/mhdFitriM/qcontrol.git
cd qcontrol
npm install
(cd web && npm install)
(cd server && npm install)`,
      },
      {
        title: 'Run locally',
        body: "Runs the Go/Node server at :8089 and Vite dev server for the React UI. Uses your laptop's Docker Desktop socket — every action runs against your local Docker.",
        cmd: `# In one terminal — API server
QCONTROL_TOKEN=devtoken \\
QCONTROL_VPS_NAME=local \\
QCONTROL_PEERS_JSON='[{"name":"local","url":"http://localhost:8089"}]' \\
node server/index.mjs

# In another terminal — Vite HMR
cd web && npm run dev

# Open http://localhost:5173  (Vite proxies /api → :8089)`,
      },
    ],
    prod: [
      COMMON_PUTTY_STEP,
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
        title: 'Or use the qcontrol UI to update itself',
        body: "Projects → qcontrol → Pull + rebuild. The page disconnects for ~5s while the container restarts; refresh after.",
      },
      {
        title: 'Add a new peer VPS to the switcher',
        body: 'On EVERY existing qcontrol, edit /opt/qcontrol/.env → QCONTROL_PEERS_JSON, then Pull + rebuild.',
      },
    ],
    maintenance: [
      {
        title: 'Login screen keeps rejecting the token',
        cmd: `# Confirm the container has the token you're pasting:
cd /opt/qcontrol
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec qcontrol env | grep TOKEN
# If mismatch → edit .env → recreate:
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --force-recreate`,
      },
      {
        title: 'Pull + rebuild against a private repo fails with "Permission denied"',
        body: 'The container mounts /root/.ssh:ro. The host root user\'s public key must be a Deploy Key on the target GitHub repo.',
        cmd: `cat ~/.ssh/id_ed25519.pub
# Add the printed key on GitHub: repo → Settings → Deploy keys → Add`,
      },
      {
        title: 'Streaming output looks stuck / frozen',
        body: "flush_interval -1 is missing from the Caddyfile block. Fix and reload:",
        cmd: `vi /opt/reverse-proxy/Caddyfile
# Ensure the qcontrol block contains:
#   reverse_proxy {$QCONTROL_UPSTREAM} { flush_interval -1 }
cd /opt/reverse-proxy
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile`,
      },
      {
        title: 'Sidebar VPS-switcher not showing the new peer',
        body: 'QCONTROL_PEERS_JSON must be updated on the VPS you\'re looking at, not just the new one. Update every peer.',
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // QRPOS
  // ---------------------------------------------------------------------------
  {
    slug: 'qrpos',
    name: 'qrpos',
    repo: 'https://github.com/seancreative/qrpos.git',
    blurb: 'Merchant POS — Laravel 11 API + Vite/React SPA in a single container (qrpos-app), served at qr.qbot.now. Uses the conventional docker-compose.yml + docker-compose.vps.yml pair (no separate production overlay). CI auto-deploys on push to main.',
    domains: ['qr.qbot.now'],
    reverseProxyPort: '127.0.0.1:8083',
    start: [
      COMMON_PUTTY_STEP,
      {
        title: 'Clone + .env',
        cmd: `cd /opt
git clone https://github.com/seancreative/qrpos.git
cd qrpos
cp .env.example .env
vi .env
# Required:
#   APP_KEY=          (run: docker compose run --rm app php artisan key:generate --show)
#   DB_PASSWORD=
#   RESEND_API_KEY=
#   FIUU_MERCHANT_ID=  FIUU_VERIFY_KEY=  FIUU_SECRET_KEY=
#   CLOUDINARY_URL=
#   VITE_API_URL=https://qr.qbot.now`,
      },
      {
        title: 'First build',
        cmd: `docker compose -f docker-compose.yml -f docker-compose.vps.yml build --no-cache
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d
docker compose -f docker-compose.yml -f docker-compose.vps.yml ps
# Migrations + storage link:
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec app php artisan migrate --force
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec app php artisan storage:link`,
      },
      COMMON_REVERSE_PROXY_STEP('qr.qbot.now', 'QRPOS', '127.0.0.1:8083'),
    ],
    dev: [
      {
        title: 'Clone + install',
        cmd: `git clone https://github.com/seancreative/qrpos.git
cd qrpos
cp .env.example .env    # edit DB creds — defaults point at the mysql service

docker compose up -d mysql redis
docker compose exec app composer install
docker compose exec app php artisan key:generate
docker compose exec app php artisan migrate --seed`,
      },
      {
        title: 'Run dev mode (Vite HMR)',
        cmd: `# Backend + hot-reload Vite:
docker compose up -d app mysql redis node
docker compose logs -f node       # Vite dev server on :5173
# Open http://localhost         (Nginx inside app) or
#      http://localhost:5173     (Vite HMR)`,
        note: 'Enable mailhog for local email testing: docker compose --profile mail up -d mailhog (UI at http://localhost:8025).',
      },
    ],
    prod: [
      {
        title: 'Easiest — push to main, CI auto-deploys',
        cmd: `# On your laptop, in the qrpos repo:
git add .
git commit -m "<your change>"
git push origin main

# Watch the deploy in Actions:
# https://github.com/seancreative/qrpos/actions`,
      },
      {
        title: 'Manual deploy from the VPS (full rebuild ~3 min)',
        cmd: `cd /opt/qrpos
git fetch --all --prune
git reset --hard origin/main
docker compose -f docker-compose.yml -f docker-compose.vps.yml build --no-cache app
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --force-recreate --remove-orphans
docker image prune -f`,
      },
      {
        title: 'Frontend-only fast path (~30s, cached layers)',
        cmd: `cd /opt/qrpos
git fetch --all --prune && git reset --hard origin/main

# No --no-cache — reuses composer + npm install layers:
docker compose -f docker-compose.yml -f docker-compose.vps.yml build app
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --force-recreate app`,
        note: 'Hard-refresh the browser (Ctrl+Shift+R). Vite hashes bundles; a normal reload can serve stale assets.',
      },
    ],
    maintenance: [
      {
        title: 'MySQL port 3306 conflict on the VPS',
        body: "Prod compose (docker-compose.vps.yml) does NOT expose 3306. If you see \"port already in use\", something else on the VPS is holding it — most commonly another project's dev compose was left running.",
        cmd: `ss -tlnp | grep 3306
# Track down the container:
docker ps | grep 3306
# Stop the offending stack:
docker compose -f <that-project>/docker-compose.yml down`,
      },
      {
        title: 'Tail logs',
        cmd: `cd /opt/qrpos
docker compose -f docker-compose.yml -f docker-compose.vps.yml logs --tail 200 -f app`,
      },
      {
        title: 'Laravel APP_KEY missing after fresh clone',
        cmd: `cd /opt/qrpos
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec app php artisan key:generate
# Then edit .env manually to make it persistent`,
      },
      {
        title: 'Clear Laravel caches (config/route/view)',
        cmd: `cd /opt/qrpos
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec app php artisan optimize:clear
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec app php artisan config:cache
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec app php artisan route:cache
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec app php artisan view:cache`,
      },
      {
        title: '⚠ DANGER — reset the MySQL volume (WIPES DATABASE)',
        body: '🚨 STOP AND READ. `docker compose down -v` deletes ALL named volumes for this stack — including the MySQL data volume. Every row in every table is GONE. There is NO undo. Only run this if:\n  1. You have a fresh backup you\'ve verified (mysqldump on your laptop, downloaded — not left on the VPS)\n  2. AND you are 100% sure you\'re on the right VPS (never on prod without an incident ticket)\n  3. AND you\'ve announced it in the team channel first\n\nIf you\'re just trying to fix a stuck migration, use `php artisan migrate:rollback` or fix the migration file — DO NOT reach for -v.',
        cmd: `cd /opt/qrpos

# 1. Take a backup FIRST (do not skip):
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec mysql \\
  mysqldump -u root -p"$DB_ROOT_PASSWORD" qrpos > /tmp/qrpos-backup-$(date +%Y%m%d-%H%M%S).sql
ls -lh /tmp/qrpos-backup-*.sql   # confirm the file exists + has bytes

# 2. Download the backup to your laptop (WinSCP / pscp) — do NOT trust the VPS
#    to still have it if this step fails.

# 3. Only NOW run the destructive command:
docker compose -f docker-compose.yml -f docker-compose.vps.yml down -v   # ← WIPES DB
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec app php artisan migrate --force`,
        note: 'The `-v` flag on `docker compose down` is the single most dangerous flag in this entire doc. Even seasoned engineers have wiped prod DBs by muscle-memory-typing `down -v` when they meant `down`. There is no "are you sure?" — the command executes instantly. Slow down.',
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // QBOTU (MAIN QBOT)
  // ---------------------------------------------------------------------------
  {
    slug: 'qbotu',
    name: 'project_qbotu_a3 (qbotu)',
    repo: 'https://github.com/seancreative/project_qbotu_a3.git',
    blurb: 'Hub frontend + Laravel API. Served at hub.qbot.jp + hub-api.qbot.jp. Canonical deploy is `./deploy-vps.sh` — wraps docker-compose.production.yml + docker-compose.vps.yml, pre-deploy backup, incremental image rebuilds, state tracking. NEVER run raw `docker compose` against this project.',
    domains: ['hub.qbot.jp', 'hub-api.qbot.jp', 'minio.qbotu.example.com'],
    reverseProxyPort: '127.0.0.1:8081',
    start: [
      COMMON_PUTTY_STEP,
      {
        title: 'Clone + .env',
        cmd: `cd /opt
git clone https://github.com/seancreative/project_qbotu_a3.git
cd project_qbotu_a3
cp .env.example .env
vi .env
# Required (short list — see docs/QBotu_DevOps_Maintenance_Guide.docx for full):
#   APP_DOMAIN=hub.qbot.jp
#   API_DOMAIN=hub-api.qbot.jp
#   MINIO_DOMAIN=minio.qbot.jp
#   DB_PASSWORD=...       MYSQL_ROOT_PASSWORD=...
#   MINIO_ROOT_USER=...   MINIO_ROOT_PASSWORD=...
#   REVERB_APP_KEY=...    REVERB_APP_SECRET=...
#   DO_ACCESS_KEY_ID=...  DO_SECRET_ACCESS_KEY=...
#   VITE_API_BASE_URL=https://hub-api.qbot.jp
#   HTTP_HOST_PORT=8081`,
      },
      {
        title: 'First deploy — build face-recognition manually first!',
        body: 'deploy-vps.sh --full-build only rebuilds a hardcoded list (bootstrap, frontend-static, backup, minio-restore) — face-recognition is NOT in that list. On a fresh VPS the image does not exist yet, so the deploy fails. Build it manually first, THEN run the deploy.',
        cmd: `cd /opt/project_qbotu_a3

# 1. Build the missing image (5–15 min — heaviest in the stack):
COMPOSE_PROJECT_NAME=project_qbotu_a3_prod docker compose \\
  -f docker-compose.production.yml -f docker-compose.vps.yml \\
  build face-recognition

# 2. Now the regular deploy can finish:
./deploy-vps.sh --full-build`,
        note: 'Long-term fix: patch deploy-vps.sh so `build_services` includes `face-recognition`, then this trap never bites again.',
      },
      COMMON_REVERSE_PROXY_STEP('hub.qbot.jp', 'QBOTU', '127.0.0.1:8081'),
    ],
    dev: [
      {
        title: 'Clone + first-time init',
        cmd: `git clone https://github.com/seancreative/project_qbotu_a3.git
cd project_qbotu_a3
cp .env.example .env
# Dev uses the docker-compose.yml file (Vite dev server + hot-reload)`,
      },
      {
        title: 'Run dev stack (Vite HMR + backend + all services)',
        cmd: `# Bring up dev stack — DO NOT use production files here
docker compose up -d
docker compose logs -f frontend backend

# URLs:
#   Frontend Vite HMR:  http://localhost:5174
#   Backend API:        http://localhost:8080/api (via proxy)
#   MinIO console:      http://localhost:9101
#   MySQL:              localhost:3306`,
      },
      {
        title: 'First migrate/seed',
        cmd: `docker compose exec backend php artisan migrate --seed
docker compose exec backend php artisan storage:link`,
      },
    ],
    prod: [
      COMMON_PUTTY_STEP,
      {
        title: 'Standard deploy (smart rebuild)',
        body: 'deploy-vps.sh reads .deploy-vps-state, computes a git diff, and only rebuilds images that changed. Safe to run as often as you want.',
        cmd: `cd /opt/project_qbotu_a3
git fetch --all --prune
git reset --hard origin/main
./deploy-vps.sh`,
        note: 'Auto-takes a pre-deploy backup unless one ran in the last 4 hours. Force fresh: `./deploy-vps.sh --fresh-backup`.',
      },
      {
        title: 'deploy-vps.sh flags',
        cmd: `./deploy-vps.sh                # Standard smart deploy
./deploy-vps.sh --dry-run      # Preview plan, no changes
./deploy-vps.sh --full-build   # Force rebuild all in build_services=(...)
./deploy-vps.sh --skip-backup  # Skip pre-deploy backup (hotfix only)
./deploy-vps.sh --fresh-backup # Force a backup even if one ran <4h ago`,
      },
      {
        title: 'Frontend-only change with VITE_* var updates',
        body: "VITE_* vars are baked at build time. deploy-vps.sh --full-build kicks off scripts/build-frontend-assets.sh which rebuilds the static bundle. qcontrol's Pull + rebuild DOESN'T run this script — always SSH in for VITE_* changes.",
      },
      {
        title: 'Tail logs',
        cmd: `cd /opt/project_qbotu_a3
docker compose -f docker-compose.production.yml -f docker-compose.vps.yml logs --tail 200 -f

# Or per service via helpers:
./enter-backend.sh
./enter-frontend.sh`,
      },
    ],
    maintenance: [
      {
        title: 'Orphan compose stack (bare docker compose commands)',
        body: 'Never run bare `docker compose ...` — this project uses non-standard COMPOSE_PROJECT_NAME=project_qbotu_a3_prod. Bare commands create an orphan stack under the directory name.',
        cmd: `# Detect orphans:
docker ps -a | grep -i qbotu
# If you see containers named "project_qbotu_a3-*" (without _prod), those are orphans.

# Kill orphans:
cd /opt/project_qbotu_a3
docker compose down --remove-orphans
# Then re-deploy properly:
./deploy-vps.sh`,
      },
      {
        title: '"Images to build: none" but you know you need a rebuild',
        cmd: `# The state file thinks you're up to date. Reset it:
cd /opt/project_qbotu_a3
rm data/backups/.deploy-vps-state
./deploy-vps.sh --full-build`,
      },
      {
        title: 'Face-recognition container crash-looping',
        cmd: `docker compose -f docker-compose.production.yml -f docker-compose.vps.yml logs --tail 200 face-recognition
# Common cause: missing model files. Force rebuild:
COMPOSE_PROJECT_NAME=project_qbotu_a3_prod docker compose \\
  -f docker-compose.production.yml -f docker-compose.vps.yml \\
  build --no-cache face-recognition`,
      },
      {
        title: 'MySQL port conflict — 3306 in use',
        cmd: `# Prod uses port 3306 inside its own network. If bind fails on host:
docker ps | grep 3306
# Kill the other container OR change MYSQL_HOST_PORT in .env to 3307
vi .env
# Then re-deploy: ./deploy-vps.sh`,
      },
      {
        title: 'Reverb / WebSocket connection fails',
        body: 'Reverb runs on internal :8080. The Caddyfile block for hub-api.qbot.jp must include /app/reverb path routing + WebSocket upgrade headers.',
      },
      {
        title: 'Restore from backup',
        cmd: `# Backups live in data/backups/
ls -lh data/backups/*.tar.gz | head
# The restore procedure is documented in docs/QBotu_DevOps_Maintenance_Guide.docx — do NOT ad-hoc restore.`,
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // QPARKING CLOUD
  // ---------------------------------------------------------------------------
  {
    slug: 'qparking',
    name: 'qparking (cloud)',
    repo: 'https://github.com/seancreative/qparking.git',
    blurb: 'Cloud parking-lot management — Laravel 11 backend + Vue 3 (Vite) frontend + camera SDK sidecar. Frontend and backend behind separate reverse-proxy ports. Auto-deploys on push to main.',
    domains: ['parking.qbot.now', 'parking-api.qbot.now'],
    reverseProxyPort: 'api: 127.0.0.1:8086  |  web: 127.0.0.1:8087',
    start: [
      COMMON_PUTTY_STEP,
      {
        title: 'Clone + .env',
        cmd: `cd /opt
git clone https://github.com/seancreative/qparking.git
cd qparking
cp .env.example .env
vi .env
# Required:
#   APP_URL=https://parking-api.qbot.now
#   APP_KEY=      # docker compose run --rm backend php artisan key:generate --show
#   DB_PASSWORD=...
#   CAMERA_SDK_URL=http://camera-sdk:8090
#   CAMERA_PUSH_BASE_URL=https://parking-api.qbot.now/api/camera
#   VITE_API_URL=https://parking-api.qbot.now
#   QPARKING_LOCAL_SERVER_TOKEN=<pair to qparking-local>`,
      },
      {
        title: 'First build',
        cmd: `docker compose -f docker-compose.yml -f docker-compose.vps.yml build --no-cache
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec backend php artisan migrate --seed`,
      },
      COMMON_REVERSE_PROXY_STEP('parking-api.qbot.now', 'QPARKING_API', '127.0.0.1:8086'),
      COMMON_REVERSE_PROXY_STEP('parking.qbot.now', 'QPARKING_WEB', '127.0.0.1:8087'),
    ],
    dev: [
      {
        title: 'Local dev stack',
        cmd: `git clone https://github.com/seancreative/qparking.git
cd qparking
cp .env.example .env      # edit APP_URL=http://localhost:8000
docker compose up -d
# Backend: http://localhost:8000
# Frontend: http://localhost:3000
# The camera-sdk sidecar is stubbed in dev — no real camera required.`,
      },
    ],
    prod: [
      {
        title: 'Automatic — push to main',
        cmd: `git push origin main
# Watch: https://github.com/seancreative/qparking/actions`,
      },
      {
        title: 'Manual redeploy',
        cmd: `cd /opt/qparking
git fetch --all --prune && git reset --hard origin/main
docker compose -f docker-compose.yml -f docker-compose.vps.yml build --no-cache
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --force-recreate --remove-orphans`,
      },
    ],
    maintenance: [
      {
        title: 'Tail logs',
        cmd: `cd /opt/qparking
docker compose -f docker-compose.yml -f docker-compose.vps.yml logs --tail 200 -f backend frontend`,
      },
      {
        title: 'Camera SDK not responding',
        cmd: `docker compose -f docker-compose.yml -f docker-compose.vps.yml logs --tail 200 camera-sdk
docker compose -f docker-compose.yml -f docker-compose.vps.yml restart camera-sdk`,
      },
      {
        title: 'qparking-local can\'t reach cloud',
        body: 'The on-prem qparking-local client authenticates with QPARKING_LOCAL_SERVER_TOKEN. If auth fails, check the token matches on both sides.',
        cmd: `cd /opt/qparking
grep LOCAL_SERVER_TOKEN .env
# Compare with the token stored inside the qparking-local desktop app config`,
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // QPARKING-LOCAL (Electron desktop app, not VPS-deployed)
  // ---------------------------------------------------------------------------
  {
    slug: 'qparking-local',
    name: 'qparking-local',
    repo: 'https://github.com/craveasiadev/qparking-local.git',
    blurb: 'On-prem parking controller (Electron desktop app for Windows). Handles LPR camera ingest, ECPI payment-terminal driver, parking-session state machine, and rate sync from the qparking cloud. Distributed as an installer — no VPS deploy.',
    domains: ['(installed on on-prem PCs at each parking site)'],
    start: [
      {
        title: 'Clone + install',
        cmd: `git clone https://github.com/craveasiadev/qparking-local.git
cd qparking-local/app
npm install
# electron-builder will auto-run install-app-deps (native modules for the correct Electron ABI)`,
      },
      {
        title: 'Point at your qparking cloud instance',
        body: 'The renderer reads config from the local SQLite DB on first launch. On first boot, enter:',
        cmd: `# Server URL:       https://parking-api.qbot.now
# Site auth token:  <the QPARKING_LOCAL_SERVER_TOKEN from qparking cloud>
# LPR camera IP:    <the on-prem LPR camera>
# ECPI terminal IP: <the payment terminal>`,
      },
    ],
    dev: [
      {
        title: 'Run in dev mode (Vite + Electron with HMR)',
        cmd: `cd app
npm run dev
# Opens the Electron window, Vite HMR at :5173, main-process TypeScript watches for changes.`,
      },
      {
        title: 'Rebuild native modules (only if better-sqlite3 crashes)',
        cmd: `npm run rebuild
# rebuilds better-sqlite3 against the current Electron ABI`,
      },
    ],
    prod: [
      {
        title: 'Build the Windows installer (NSIS + portable)',
        cmd: `cd app
npm run package
# Output: app/release/<version>/QParking-Local-Setup-<ver>.exe
#         app/release/<version>/QParking-Local-<ver>-portable.exe`,
      },
      {
        title: 'Ship a new version to the auto-updater',
        cmd: `# Combined build + publish:
npm run ship
# Or just publish an already-built version:
npm run publish:cloud
# See scripts/publish.mjs for the target (typically a signed release bucket)`,
      },
      {
        title: 'Manual install on the on-prem PC',
        body: '1. Copy the .exe to the site PC via USB or the site VPN.\n2. Run as Administrator (needed for the ECPI COM-port driver).\n3. On first launch, paste server URL + token + camera IPs.\n4. The auto-updater takes over from there — subsequent versions install silently.',
      },
    ],
    maintenance: [
      {
        title: 'LPR camera not sending plates',
        cmd: `# On the site PC — open the app's Diagnostics panel:
#   Sidebar → Settings → Diagnostics → LPR camera
# Or check the local log:
#   %APPDATA%\\QParking Local Server\\logs\\lpr.log`,
      },
      {
        title: 'ECPI terminal shows "no connection"',
        cmd: `# ECPI is TCP — first confirm the terminal is reachable:
ping <terminal-ip>
telnet <terminal-ip> <ECPI-port>       # or Test-NetConnection on PowerShell

# Then check the app's ecpi.log:
#   %APPDATA%\\QParking Local Server\\logs\\ecpi.log

# Rate table out of sync — force a fresh pull from cloud:
#   Sidebar → Settings → Sync rates → Force refresh`,
      },
      {
        title: 'SQLite DB corrupted',
        body: 'The database lives at %APPDATA%\\QParking Local Server\\qparking.sqlite. Back up before touching.',
        cmd: `# Stop the app, then in an admin PowerShell:
Stop-Process -Name "QParking Local Server" -Force
Copy-Item "$env:APPDATA\\QParking Local Server\\qparking.sqlite" "$env:APPDATA\\QParking Local Server\\qparking.sqlite.bak"
# Restart the app — it will re-sync from cloud if the local DB is missing.`,
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // FACE_AUTH (New HIK Vision Controller)
  // ---------------------------------------------------------------------------
  {
    slug: 'face_auth',
    name: 'face_auth (new HIK Vision controller)',
    repo: 'https://github.com/mhdFitriM/face_auth.git',
    blurb: 'Second-generation turnstile / face-auth controller — Go backend + Vue 3 admin UI. Two separate reverse-proxy hostnames: API + Admin UI. Auto-deploys on push to main.',
    domains: ['face.qbot.now', 'face-admin.qbot.now'],
    reverseProxyPort: 'api: 127.0.0.1:8084  |  admin: 127.0.0.1:8085',
    start: [
      COMMON_PUTTY_STEP,
      {
        title: 'Clone + .env',
        cmd: `cd /opt
git clone https://github.com/mhdFitriM/face_auth.git
cd face_auth
cp .env.example .env
vi .env
# Required:
#   PG_USER=faceauth      PG_PASSWORD=...       PG_DB=faceauth
#   MINIO_ROOT_USER=...   MINIO_ROOT_PASSWORD=...
#   API_PORT=8080         PUSH_PORT=7660        DEBUG_PORT=7661     TLS_PORT=7670
#   NO_AUTH_MODE=false
#   DEVICE_DEFAULT_PASSWORD=...
#   LOG_LEVEL=info
#   VITE_API_URL=https://face.qbot.now`,
      },
      {
        title: 'First build + DB init',
        cmd: `docker compose -f docker-compose.yml -f docker-compose.vps.yml build --no-cache
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d postgres redis minio
# Wait for postgres healthy, then start app services:
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d backend admin`,
      },
      COMMON_REVERSE_PROXY_STEP('face.qbot.now', 'FACEAUTH_API', '127.0.0.1:8084'),
      COMMON_REVERSE_PROXY_STEP('face-admin.qbot.now', 'FACEAUTH_ADMIN', '127.0.0.1:8085'),
      {
        title: 'Firewall — open the push port to on-prem Hikvision devices',
        body: 'The push port (default 7660) receives event pushes from Hikvision devices on the LAN. On a VPS with only 22/80/443 open, either open 7660 to specific device IPs OR run the "agent" mode inside a LAN, which tunnels events outbound over WebSocket to the VPS.',
        cmd: `# Open ONLY to trusted device IPs — never public:
ufw allow from <device-ip> to any port 7660 proto tcp
# Better: run the agent (see next section).`,
      },
    ],
    dev: [
      {
        title: 'Local dev stack',
        cmd: `git clone https://github.com/mhdFitriM/face_auth.git
cd face_auth
cp .env.example .env       # local defaults are fine

docker compose up -d postgres redis minio
docker compose up -d backend admin
# Backend API:    http://localhost:8080
# Admin UI:       http://localhost:5173  (Vue 3 + Vite HMR)
# MinIO console:  http://localhost:9001`,
      },
      {
        title: 'Run the LAN agent (WebSocket tunnel to cloud backend)',
        cmd: `# Only start when you're testing the agent flow:
docker compose --profile agent up -d agent`,
      },
    ],
    prod: [
      {
        title: 'Automatic — push to main',
        cmd: `git push origin main
# Watch: https://github.com/mhdFitriM/face_auth/actions`,
      },
      {
        title: 'Manual redeploy',
        cmd: `cd /opt/face_auth
git fetch --all --prune && git reset --hard origin/main
docker compose -f docker-compose.yml -f docker-compose.vps.yml build --no-cache
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --force-recreate --remove-orphans`,
      },
    ],
    maintenance: [
      {
        title: 'Tail logs',
        cmd: `cd /opt/face_auth
docker compose -f docker-compose.yml -f docker-compose.vps.yml logs --tail 200 -f backend admin`,
      },
      {
        title: 'PostgreSQL migrations failing',
        cmd: `docker compose -f docker-compose.yml -f docker-compose.vps.yml logs --tail 100 postgres
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec postgres psql -U faceauth -c "\\dt"`,
      },
      {
        title: 'Devices not registering on the push port',
        cmd: `# Check the port is listening:
docker compose -f docker-compose.yml -f docker-compose.vps.yml exec backend netstat -tlnp | grep 7660

# Check ufw allows the device IPs:
ufw status | grep 7660`,
      },
      {
        title: 'MinIO console asks for login again',
        body: 'MINIO_ROOT_USER / MINIO_ROOT_PASSWORD must match .env. Change → restart minio container.',
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // FACEAPP (Old Hikvision turnstile controller)
  // ---------------------------------------------------------------------------
  {
    slug: 'faceapp',
    name: 'faceapp (OLD Hikvision turnstile)',
    repo: 'https://github.com/mhdFitriM/faceapp.git',
    blurb: 'First-generation Hikvision turnstile controller — Laravel 11 API + Vue 3 SPA + C++ Hikvision SDK gateway sidecar. Legacy — kept running for sites not yet migrated to face_auth. Uses SQLite instead of Postgres.',
    domains: ['faceapp.qbot.now', 'faceapp-api.qbot.now'],
    reverseProxyPort: '127.0.0.1:8082 (single caddy proxies both hostnames internally)',
    start: [
      COMMON_PUTTY_STEP,
      {
        title: 'Clone + .env',
        cmd: `cd /opt
git clone https://github.com/mhdFitriM/faceapp.git
cd faceapp
cp .env.example .env
vi .env
# Required:
#   LARAVEL_APP_KEY=      # docker compose run --rm api php artisan key:generate --show
#   FACEAPP_DOMAIN=faceapp.qbot.now
#   FACEAPP_API_DOMAIN=faceapp-api.qbot.now
#   FACEAPP_API_ORIGIN=https://faceapp.qbot.now
#   GATEWAY_DEVICE_KEY=<from Hikvision cloud middleware>
#   GATEWAY_SECRET=<from Hikvision cloud middleware>
#   GATEWAY_TIMEOUT_SECONDS=30`,
      },
      {
        title: 'First build',
        cmd: `./deploy-vps.sh
# The script runs: git pull + docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build`,
      },
      COMMON_REVERSE_PROXY_STEP('faceapp.qbot.now', 'FACEAPP', '127.0.0.1:8082'),
      {
        title: 'Second Caddy block for the API subdomain (same upstream, path-split inside)',
        body: 'faceapp\'s internal Caddy already routes based on Host header. Both public hostnames go to the same upstream port — the internal Caddy dispatches.',
        cmd: `cat >> /opt/reverse-proxy/.env <<'EOF'
FACEAPP_API_DOMAIN=faceapp-api.qbot.now
FACEAPP_API_UPSTREAM=127.0.0.1:8082
EOF

cat >> /opt/reverse-proxy/Caddyfile <<'EOF'

{$FACEAPP_API_DOMAIN} {
  reverse_proxy {$FACEAPP_API_UPSTREAM}
}
EOF

cd /opt/reverse-proxy
docker compose up -d --force-recreate caddy`,
      },
    ],
    dev: [
      {
        title: 'Local dev stack',
        body: 'faceapp bundles its own Caddy (dev profile publishes 80/443). Use it as-is on your laptop — the Hikvision SDK gateway service will not have real device connectivity but the API + SPA render.',
        cmd: `git clone https://github.com/mhdFitriM/faceapp.git
cd faceapp
cp .env.example .env      # for local, set FACEAPP_DOMAIN=localhost
docker compose up -d
# Frontend: http://localhost
# API:      http://localhost/api`,
      },
    ],
    prod: [
      {
        title: 'Deploy',
        cmd: `cd /opt/faceapp
git fetch --all --prune && git reset --hard origin/main
./deploy-vps.sh`,
      },
      {
        title: 'What deploy-vps.sh does',
        body: 'faceapp\'s deploy-vps.sh is minimal (unlike qbotu\'s). It does: git pull --ff-only, docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build, then a Caddy validate.',
      },
    ],
    maintenance: [
      {
        title: 'Tail logs',
        cmd: `cd /opt/faceapp
docker compose -f docker-compose.yml -f docker-compose.vps.yml logs --tail 200 -f api gateway`,
      },
      {
        title: 'SQLite DB locked',
        body: 'SQLite doesn\'t handle concurrent writes well. If you see "database is locked", restart the api container to release the file handle.',
        cmd: `docker compose -f docker-compose.yml -f docker-compose.vps.yml restart api`,
      },
      {
        title: 'Gateway to Hikvision cloud middleware failing',
        cmd: `docker compose -f docker-compose.yml -f docker-compose.vps.yml logs --tail 200 gateway
# Check GATEWAY_DEVICE_KEY + GATEWAY_SECRET match Hikvision console
# Sanity check the ports 10010/10011 aren't firewalled outbound`,
      },
      {
        title: 'Migrating from faceapp → face_auth',
        body: 'The new face_auth is a rewrite (Go + Postgres), not a drop-in. Data export tooling lives in faceapp/scripts/export-devices.php. Contact the face_auth maintainer before starting a migration.',
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // AI-GENIUS (full new stack)
  // ---------------------------------------------------------------------------
  {
    slug: 'aigenius',
    name: 'aigenius-full',
    repo: 'https://github.com/craveasiadev/aigenius-full.git',
    blurb: 'AI-Genius one-shot Laravel + React deployment. Single docker-compose.yml — nginx + Laravel app + queue + scheduler + MySQL 8 + Redis. Ships with its own ./deploy.sh CLI (--init / --update / --status / --logs / --fresh / --nuke).',
    domains: ['aigenius.now', 'app.aigenius.now'],
    reverseProxyPort: '127.0.0.1:8090',
    start: [
      COMMON_PUTTY_STEP,
      {
        title: 'Clone + .env',
        cmd: `cd /opt
git clone https://github.com/craveasiadev/aigenius-full.git
cd aigenius-full
cp .env.example .env
vi .env
# Required (partial):
#   APP_NAME=Aigenius
#   APP_URL=https://aigenius.now
#   TRUSTED_PROXIES=*                 # essential — Caddy terminates TLS
#   HTTP_BIND=127.0.0.1               # bind only to loopback — reverse-proxy does public
#   HTTP_PORT=8090
#   DB_DATABASE=aigenius              DB_USERNAME=aigenius   DB_PASSWORD=...
#   DB_ROOT_PASSWORD=...
#   OPENAI_API_KEY=...
#   MAILERSEND_API_KEY=...            MAIL_FROM_ADDRESS=noreply@aigenius.now
#   FIUU_MERCHANT_ID=  FIUU_VERIFY_KEY=  FIUU_SECRET_KEY=  FIUU_PAYMENT_URL=
#   SUPABASE_URL=  SUPABASE_SERVICE_KEY=
#   ISMS_USERNAME=  ISMS_PASSWORD=  ISMS_SENDER_ID=`,
      },
      {
        title: 'First-time bootstrap',
        cmd: `./deploy.sh --init
# What it does:
#   1. docker compose build all services (~5 min)
#   2. docker compose up -d
#   3. Waits for MySQL healthy
#   4. Runs migrations + seeders
#   5. Warms Laravel caches (config/route/view)`,
      },
      COMMON_REVERSE_PROXY_STEP('aigenius.now', 'AIGENIUS', '127.0.0.1:8090'),
    ],
    dev: [
      {
        title: 'Local dev stack',
        cmd: `git clone https://github.com/craveasiadev/aigenius-full.git
cd aigenius-full
cp .env.example .env      # set APP_URL=http://localhost:8090
./deploy.sh --init        # same script works locally
# Or step-by-step:
docker compose up -d mysql redis
docker compose exec app php artisan migrate --seed
docker compose up -d
# Open http://localhost:8090`,
      },
      {
        title: 'Frontend dev (Vite HMR against a separate npm run dev)',
        cmd: `# In frontend workspace:
cd frontend
npm install
npm run dev
# Vite: http://localhost:5173
# Set VITE_API_URL=http://localhost:8090 in frontend/.env.local`,
      },
    ],
    prod: [
      COMMON_PUTTY_STEP,
      {
        title: 'Standard update',
        cmd: `cd /opt/aigenius-full
./deploy.sh --update
# git pull + docker compose build (only changed) + up -d + migrate + cache warm`,
      },
      {
        title: 'deploy.sh flags',
        cmd: `./deploy.sh --init                  # First-time bootstrap (init + migrate + seed)
./deploy.sh --update                # git pull + rebuild changed + up + migrate
./deploy.sh --status                # Show container states
./deploy.sh --logs [service]        # Tail logs — omit svc for all
./deploy.sh --build                 # Force rebuild (no pull)
./deploy.sh --pull                  # Just pull latest images
./deploy.sh --restart               # Restart the stack
./deploy.sh --down                  # Stop everything
./deploy.sh --migrate               # Just run migrations
./deploy.sh --seed                  # Just run seeders
./deploy.sh --cache                 # Warm Laravel caches
./deploy.sh --fresh                 # DESTRUCTIVE — wipe DB + reseed (prompts)
./deploy.sh --nuke                  # DESTRUCTIVE — wipe volumes + images (prompts)
./deploy.sh --only <service>        # Scope build/up to one service
./deploy.sh --no-build              # Skip build phase in --update
./deploy.sh --yes                   # Skip destructive-op confirmations`,
      },
    ],
    maintenance: [
      {
        title: 'Tail logs',
        cmd: `cd /opt/aigenius-full
./deploy.sh --logs                    # All services
./deploy.sh --logs app                # Laravel HTTP
./deploy.sh --logs queue              # Queue worker
./deploy.sh --logs scheduler          # Cron / scheduler
./deploy.sh --logs mysql              # DB`,
      },
      {
        title: 'MySQL port conflict',
        body: 'aigenius\'s MySQL is internal-only (no host port bind by default). If you see a conflict, another dev-mode compose is running MySQL on 3306.',
        cmd: `docker ps | grep 3306
# Stop that other stack — this one runs isolated on the internal aigenius-net network.`,
      },
      {
        title: 'OpenAI rate limits — queue backing up',
        cmd: `./deploy.sh --logs queue | grep -i "rate limit\\|429"
# Scale queue workers if bursts are common:
docker compose up -d --scale queue=3`,
      },
      {
        title: 'Reset admin password',
        cmd: `docker compose exec app php artisan tinker
>>> \\App\\Models\\User::where('email', 'admin@aigenius.now')->update(['password' => bcrypt('new-password')]);`,
      },
      {
        title: 'Fresh start (destroys DB!)',
        cmd: `./deploy.sh --fresh
# Prompts twice. Wipes MySQL volume, re-migrates, re-seeds.`,
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // AIGENIUS BACKEND (OLD) — Laravel-on-host, NO Docker
  // ---------------------------------------------------------------------------
  {
    slug: 'aigenius-backend-old',
    name: 'aigenius-backend (OLD) — no Docker',
    repo: 'https://github.com/craveasiadev/aigeniusBackend.git',
    blurb: 'Legacy Fiuu payment-gateway proxy for the React/Supabase frontend. Laravel 12 + SQLite — runs directly on host PHP-FPM (NO Docker). Only handles /payments/initiate, /payments/callback (Fiuu webhook), /payments/return, /payments/transaction/{id}, /health. All user/order state lives in Supabase — this backend is stateless except for a small payment_transactions table.',
    domains: ['api-old.aigenius.now'],
    reverseProxyPort: '127.0.0.1:8091 (php artisan serve)',
    start: [
      COMMON_SSH_NOTE,
      {
        title: 'Install PHP 8.2 + composer on the VPS (once)',
        body: 'This project runs directly on host PHP — no container. Install the runtime + composer if not already there.',
        cmd: `# PHP 8.2 (from Ondrej PPA on Ubuntu):
add-apt-repository -y ppa:ondrej/php
apt-get update
apt-get install -y php8.2-cli php8.2-fpm php8.2-mbstring php8.2-xml \\
                   php8.2-sqlite3 php8.2-curl php8.2-bcmath php8.2-zip \\
                   php8.2-tokenizer unzip

# Composer:
curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer
composer --version   # should print 2.x`,
      },
      {
        title: 'Clone + install',
        cmd: `cd /opt
git clone https://github.com/craveasiadev/aigeniusBackend.git aigenius-backend-old
cd aigenius-backend-old

composer install --no-dev --optimize-autoloader
cp .env.example .env
php artisan key:generate

# Create the SQLite DB file:
touch database/database.sqlite
chmod 664 database/database.sqlite

vi .env
# Required lines:
#   APP_URL=https://api-old.aigenius.now
#   FRONTEND_URL=https://aigenius.now
#   DB_CONNECTION=sqlite
#   DB_DATABASE=/opt/aigenius-backend-old/database/database.sqlite
#   FIUU_MERCHANT_ID=...
#   FIUU_VERIFY_KEY=...
#   FIUU_SECRET_KEY=...
#   SUPABASE_URL=...          SUPABASE_SERVICE_KEY=...
#   TRUSTED_PROXIES=*         # Caddy terminates TLS
#   APP_ENV=production        APP_DEBUG=false

php artisan migrate --force
php artisan storage:link
php artisan config:cache && php artisan route:cache && php artisan view:cache`,
      },
      {
        title: 'Fix filesystem perms (Laravel writes to storage/ + bootstrap/cache/)',
        cmd: `cd /opt/aigenius-backend-old
chown -R www-data:www-data storage bootstrap/cache database
chmod -R 775 storage bootstrap/cache
chmod 664 database/database.sqlite`,
      },
      {
        title: 'Serve — pick ONE (systemd + php-fpm behind Caddy is cleanest)',
        body: "Two options, both work. Option A is a lightweight systemd unit that runs `php artisan serve` on 127.0.0.1:8091 (simplest — no php-fpm pool needed since traffic is tiny). Option B is a real php-fpm pool + Caddy php_fastcgi — proper prod. Start with Option A.",
        cmd: `# ---- Option A: systemd unit around php artisan serve ----
cat > /etc/systemd/system/aigenius-backend-old.service <<'EOF'
[Unit]
Description=aigenius-backend-old (Laravel payment proxy)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/aigenius-backend-old
ExecStart=/usr/bin/php artisan serve --host=127.0.0.1 --port=8091 --env=production
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now aigenius-backend-old
systemctl status aigenius-backend-old

# ---- Option B (better for real prod): php-fpm pool + Caddy php_fastcgi ----
# See maintenance tab.`,
      },
      COMMON_REVERSE_PROXY_STEP('api-old.aigenius.now', 'AIGENIUS_OLD', '127.0.0.1:8091'),
    ],
    dev: [
      {
        title: 'Local dev (Windows / macOS / Linux)',
        cmd: `git clone https://github.com/craveasiadev/aigeniusBackend.git
cd aigeniusBackend

composer install
cp .env.example .env
php artisan key:generate

touch database/database.sqlite
php artisan migrate

# Run the built-in dev server:
php artisan serve
# → http://127.0.0.1:8000`,
      },
      {
        title: 'Test the payment flow locally against Fiuu sandbox',
        cmd: `# In .env set:
#   FIUU_PAYMENT_URL=https://sandbox.merchant.razer.com/RMS/pay/<merchant>/
#   FRONTEND_URL=http://localhost:5173
# Then from the aigenius-full React frontend, checkout hits POST /payments/initiate
# on http://localhost:8000 which redirects to Fiuu sandbox.`,
      },
    ],
    prod: [
      COMMON_SSH_NOTE,
      {
        title: 'Redeploy (git pull + composer + migrate + reload service)',
        cmd: `cd /opt/aigenius-backend-old
git fetch --all --prune
git reset --hard origin/main

composer install --no-dev --optimize-autoloader
php artisan migrate --force
php artisan config:cache && php artisan route:cache && php artisan view:cache

systemctl restart aigenius-backend-old
systemctl status aigenius-backend-old --no-pager`,
      },
      {
        title: 'Migration plan to aigenius-full',
        body: 'Long-term: point the React frontend at aigenius-full and retire this proxy. Payment history table is small — export via `php artisan tinker` + JSON dump before decommissioning.',
      },
    ],
    maintenance: [
      {
        title: 'Tail logs',
        cmd: `# Laravel log:
tail -f /opt/aigenius-backend-old/storage/logs/laravel.log

# systemd stdout:
journalctl -u aigenius-backend-old -f --tail 200`,
      },
      {
        title: 'SQLite "database is locked"',
        body: 'Concurrent writes to the payment_transactions table can lock the file briefly. Enable WAL mode for better concurrency.',
        cmd: `sqlite3 /opt/aigenius-backend-old/database/database.sqlite "PRAGMA journal_mode=WAL;"`,
      },
      {
        title: 'Switching to Option B — real php-fpm pool',
        cmd: `# 1. Create a dedicated fpm pool:
cat > /etc/php/8.2/fpm/pool.d/aigenius-old.conf <<'EOF'
[aigenius-old]
user = www-data
group = www-data
listen = /run/php/php8.2-fpm-aigenius-old.sock
listen.owner = www-data
listen.group = www-data
pm = dynamic
pm.max_children = 5
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 3
EOF
systemctl restart php8.2-fpm

# 2. In /opt/reverse-proxy/Caddyfile, replace the reverse_proxy block with:
{$AIGENIUS_OLD_DOMAIN} {
  root * /opt/aigenius-backend-old/public
  php_fastcgi unix//run/php/php8.2-fpm-aigenius-old.sock
  file_server
}

# 3. Disable the systemd unit (no longer serving):
systemctl disable --now aigenius-backend-old
cd /opt/reverse-proxy && docker compose up -d --force-recreate caddy`,
      },
      {
        title: 'Fiuu webhook signature mismatch',
        cmd: `# Verify VERIFY_KEY + SECRET_KEY match Fiuu merchant console:
grep FIUU /opt/aigenius-backend-old/.env
# Then check the callback log:
tail -100 storage/logs/laravel.log | grep -i "fiuu\\|payment"`,
      },
      {
        title: 'Clear + rewarm caches after config change',
        cmd: `cd /opt/aigenius-backend-old
php artisan optimize:clear
php artisan config:cache && php artisan route:cache && php artisan view:cache
systemctl restart aigenius-backend-old`,
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // QBOT-CHECKIN (FISB) — Laravel-on-host + Capacitor, NO Docker
  // ---------------------------------------------------------------------------
  {
    slug: 'qbot-checkin',
    name: 'qbot-checkin (FISB) — no Docker',
    repo: 'https://github.com/craveasiadev/qbot-checkin.git',
    blurb: 'FISB event check-in — Laravel 12 backend (Blade views) + Capacitor WebView Android shell. Runs directly on host PHP-FPM (NO Docker). The Android app is a thin WebView pointed at CAPACITOR_SERVER_URL — no offline bundling.',
    domains: ['checkin.fisb.qbot.now'],
    reverseProxyPort: '127.0.0.1:8092 (php artisan serve OR php-fpm socket)',
    start: [
      COMMON_SSH_NOTE,
      {
        title: 'Install PHP 8.2 + composer + node (once per VPS)',
        cmd: `add-apt-repository -y ppa:ondrej/php
apt-get update
apt-get install -y php8.2-cli php8.2-fpm php8.2-mbstring php8.2-xml \\
                   php8.2-mysql php8.2-sqlite3 php8.2-curl php8.2-bcmath \\
                   php8.2-zip php8.2-tokenizer unzip

curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

# Node 20 (Capacitor + Vite build):
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs`,
      },
      {
        title: 'Clone + install',
        cmd: `cd /opt
git clone https://github.com/craveasiadev/qbot-checkin.git
cd qbot-checkin

composer install --no-dev --optimize-autoloader
npm ci
npm run build   # compile Vite assets into public/build

cp .env.example .env
php artisan key:generate

vi .env
# Required lines:
#   APP_NAME="FISB Check-In"
#   APP_ENV=production          APP_DEBUG=false
#   APP_URL=https://checkin.fisb.qbot.now
#   API_BASE_URL=https://checkin.fisb.qbot.now
#   CAPACITOR_SERVER_URL=https://checkin.fisb.qbot.now
#   DB_CONNECTION=sqlite       # or mysql — see below
#   DB_DATABASE=/opt/qbot-checkin/database/database.sqlite

# If SQLite:
touch database/database.sqlite
chmod 664 database/database.sqlite

php artisan migrate --force
php artisan storage:link
php artisan config:cache && php artisan route:cache && php artisan view:cache`,
        note: 'For real events with lots of concurrent check-ins, switch DB_CONNECTION to mysql — SQLite locks under load. Install mysql-server + create db, then update .env accordingly.',
      },
      {
        title: 'Fix filesystem perms',
        cmd: `cd /opt/qbot-checkin
chown -R www-data:www-data storage bootstrap/cache database public/build
chmod -R 775 storage bootstrap/cache
chmod 664 database/database.sqlite 2>/dev/null || true`,
      },
      {
        title: 'Serve via systemd + php artisan serve',
        cmd: `cat > /etc/systemd/system/qbot-checkin.service <<'EOF'
[Unit]
Description=qbot-checkin (FISB Laravel)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/qbot-checkin
ExecStart=/usr/bin/php artisan serve --host=127.0.0.1 --port=8092 --env=production
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now qbot-checkin
systemctl status qbot-checkin --no-pager`,
        note: 'For real prod use php-fpm instead (see Maintenance tab). php artisan serve is fine for demos + small events.',
      },
      COMMON_REVERSE_PROXY_STEP('checkin.fisb.qbot.now', 'QBOT_CHECKIN', '127.0.0.1:8092'),
    ],
    dev: [
      {
        title: 'Backend dev (Windows / macOS / Linux)',
        cmd: `git clone https://github.com/craveasiadev/qbot-checkin.git
cd qbot-checkin

composer install
npm install
cp .env.example .env
php artisan key:generate

touch database/database.sqlite    # or configure MySQL + start it
php artisan migrate --seed

# Run backend + Vite HMR concurrently:
php artisan serve        # http://127.0.0.1:8000
# In another terminal:
npm run dev              # Vite HMR on :5173`,
      },
      {
        title: 'Android APK (Capacitor) — build for testing',
        cmd: `# Requires Android Studio + JDK 17 + Android SDK 34
# In capacitor.config.ts set CAPACITOR_SERVER_URL to your laptop's LAN IP:
#   server: { url: 'http://192.168.x.x:8000', cleartext: true }
# (cleartext ONLY for dev — remove before shipping)

npm run build:mobile          # separate vite.mobile.config.js output
npm run cap:add:android       # once, to generate android/ folder
npm run cap:sync              # every time JS changes
npm run cap:open:android      # opens Android Studio — build APK from there

# Or from the command line:
cd android
./gradlew assembleDebug
# APK: android/app/build/outputs/apk/debug/app-debug.apk`,
      },
    ],
    prod: [
      COMMON_SSH_NOTE,
      {
        title: 'Redeploy backend',
        cmd: `cd /opt/qbot-checkin
git fetch --all --prune
git reset --hard origin/main

composer install --no-dev --optimize-autoloader
npm ci
npm run build

php artisan migrate --force
php artisan config:cache && php artisan route:cache && php artisan view:cache
chown -R www-data:www-data storage bootstrap/cache public/build

systemctl restart qbot-checkin
systemctl status qbot-checkin --no-pager`,
      },
      {
        title: 'APK release build (on the Windows build box)',
        cmd: `# Ensure capacitor.config.ts server.url = https://checkin.fisb.qbot.now
# and cleartext is NOT set.

npm ci
npm run build:mobile
npx cap sync android

cd android
./gradlew assembleRelease
# Signed APK: android/app/build/outputs/apk/release/app-release.apk
# Distribute via mobile-dist/ folder or a signed release upload.`,
      },
    ],
    maintenance: [
      {
        title: 'Tail logs',
        cmd: `tail -f /opt/qbot-checkin/storage/logs/laravel.log
journalctl -u qbot-checkin -f --tail 200`,
      },
      {
        title: 'Switching to php-fpm for real load (recommended before events)',
        cmd: `cat > /etc/php/8.2/fpm/pool.d/qbot-checkin.conf <<'EOF'
[qbot-checkin]
user = www-data
group = www-data
listen = /run/php/php8.2-fpm-qbot-checkin.sock
listen.owner = www-data
pm = dynamic
pm.max_children = 20
pm.start_servers = 4
pm.min_spare_servers = 2
pm.max_spare_servers = 8
EOF
systemctl restart php8.2-fpm

# Update /opt/reverse-proxy/Caddyfile:
{$QBOT_CHECKIN_DOMAIN} {
  root * /opt/qbot-checkin/public
  php_fastcgi unix//run/php/php8.2-fpm-qbot-checkin.sock
  file_server
}

systemctl disable --now qbot-checkin
cd /opt/reverse-proxy && docker compose up -d --force-recreate caddy`,
      },
      {
        title: 'Mobile app shows "Webpage not available"',
        cmd: `# 1. Verify DNS + TLS:
curl -I https://checkin.fisb.qbot.now

# 2. Verify Capacitor server URL:
grep -A2 server /opt/qbot-checkin/capacitor.config.ts

# 3. Android WebView blocks cleartext HTTP by default — the URL MUST be HTTPS.`,
      },
      {
        title: 'Event-day DB slowness (SQLite locking)',
        body: 'SQLite serializes writes. During a large event this becomes the bottleneck. Two options:',
        cmd: `# --- Option A: enable WAL (a big improvement, no schema change) ---
sqlite3 /opt/qbot-checkin/database/database.sqlite "PRAGMA journal_mode=WAL;"

# --- Option B: migrate to MySQL before the event ---
apt-get install -y mysql-server
mysql -e "CREATE DATABASE qbot_checkin; CREATE USER 'checkin'@'localhost' IDENTIFIED BY '...'; GRANT ALL ON qbot_checkin.* TO 'checkin'@'localhost';"
# Update .env: DB_CONNECTION=mysql etc.
php artisan migrate --fresh --force   # DESTRUCTIVE — export SQLite first!`,
      },
      {
        title: 'Clear caches after .env / config change',
        cmd: `cd /opt/qbot-checkin
php artisan optimize:clear
php artisan config:cache && php artisan route:cache && php artisan view:cache
systemctl restart qbot-checkin  # or: systemctl reload php8.2-fpm`,
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // WONDERSTAR (WonderStars) — static Vite + React + Supabase, NO Docker
  // ---------------------------------------------------------------------------
  {
    slug: 'wonderstar',
    name: 'Wonderstar app — static SPA',
    repo: 'https://github.com/seancreative/app_wonderstar.git',
    blurb: 'Wonderpark family membership + rewards app. Pure Vite + React + TypeScript SPA — all backend logic (auth, orders, wallet, missions, workshops, mystery boxes, RLS) lives in Supabase. NO backend, NO Docker. Builds to a static dist/ folder served by Caddy as a file_server. Fiuu payments go through the aigenius-backend-old proxy.',
    domains: ['wonderstar.qbot.now'],
    reverseProxyPort: 'static file_server (no upstream port)',
    start: [
      COMMON_SSH_NOTE,
      {
        title: 'Install Node 20 on the VPS (once)',
        cmd: `curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version   # v20.x
npm --version`,
      },
      {
        title: 'Clone + env',
        cmd: `cd /opt
git clone https://github.com/seancreative/app_wonderstar.git wonderstar
cd wonderstar

npm ci

# Vite reads VITE_* from .env at BUILD time (baked into the bundle):
cat > .env <<'EOF'
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-public-key>
VITE_PAYMENT_API_URL=https://api-old.aigenius.now
VITE_FRONTEND_URL=https://wonderstar.qbot.now
EOF`,
        note: 'The anon key is safe to embed — Supabase RLS enforces per-row access on the server. Never put the service_role key in a VITE_ var — that bypasses RLS.',
      },
      {
        title: 'Build the static bundle',
        cmd: `cd /opt/wonderstar
npm run build
# Output: /opt/wonderstar/dist/
ls -la dist/`,
      },
      {
        title: 'Wire the dist/ folder into /opt/reverse-proxy as a static site',
        body: 'No upstream port — Caddy serves dist/ directly as a file_server with SPA fallback (all unknown routes → index.html so React Router works).',
        cmd: `cat >> /opt/reverse-proxy/.env <<'EOF'
WONDERSTAR_DOMAIN=wonderstar.qbot.now
WONDERSTAR_ROOT=/opt/wonderstar/dist
EOF

cat >> /opt/reverse-proxy/Caddyfile <<'EOF'

{$WONDERSTAR_DOMAIN} {
  root * {$WONDERSTAR_ROOT}
  encode zstd gzip
  try_files {path} /index.html
  file_server
  header /assets/* Cache-Control "public, max-age=31536000, immutable"
  header /index.html Cache-Control "no-cache"
}
EOF

# Mount /opt/wonderstar into the caddy container. Edit /opt/reverse-proxy/docker-compose.yml
# and add under caddy.volumes:
#   - /opt/wonderstar/dist:/opt/wonderstar/dist:ro

cd /opt/reverse-proxy
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile
docker compose up -d --force-recreate caddy`,
        note: 'Static assets get 1-year cache (they have hashed filenames from Vite so browsers refetch after a new build); index.html stays uncached so a new deploy is picked up on the next reload.',
      },
    ],
    dev: [
      {
        title: 'Local dev with Vite HMR',
        cmd: `git clone https://github.com/seancreative/app_wonderstar.git
cd app_wonderstar
npm install

# Copy .env for local:
cat > .env <<'EOF'
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
VITE_PAYMENT_API_URL=http://localhost:8000
VITE_FRONTEND_URL=http://localhost:5173
EOF

npm run dev
# → http://localhost:5173`,
      },
      {
        title: 'Type-check + lint',
        cmd: `npm run typecheck
npm run lint`,
      },
      {
        title: 'Preview the production bundle locally',
        cmd: `npm run build
npm run preview
# → http://localhost:4173 (serves ./dist same way Caddy will)`,
      },
    ],
    prod: [
      COMMON_SSH_NOTE,
      {
        title: 'Redeploy (git pull + build)',
        body: 'Because it\'s a static bundle, "deploy" is just rebuild + Caddy picks it up on the next request (no restart needed — file_server reads from disk).',
        cmd: `cd /opt/wonderstar
git fetch --all --prune
git reset --hard origin/main

npm ci
npm run build

# Optional: purge Cloudflare / CDN cache if one sits in front.
# No systemctl restart needed — Caddy serves dist/ from disk.`,
      },
      {
        title: 'Deploy via CI (optional) — GitHub Actions rsync',
        body: 'For hands-free deploy, add .github/workflows/deploy.yml that runs npm ci + npm run build, then rsyncs dist/ to /opt/wonderstar/dist on the VPS over SSH. Same pattern qrpos/qparking use.',
      },
      {
        title: 'Rollback',
        cmd: `# Roll back the source, rebuild, done:
cd /opt/wonderstar
git log --oneline -20
git reset --hard <previous-good-sha>
npm ci && npm run build`,
      },
    ],
    maintenance: [
      {
        title: 'Build failed / dist/ is stale after deploy',
        cmd: `cd /opt/wonderstar
rm -rf node_modules dist
npm ci
npm run build 2>&1 | tail -40
# If TypeScript errors: npm run typecheck for details`,
      },
      {
        title: 'Users see the old version after deploy',
        body: 'index.html is served with no-cache; browsers should always fetch it fresh. If they don\'t, a CDN (Cloudflare / etc.) is caching too aggressively.',
        cmd: `# Verify Caddy is sending no-cache on index.html:
curl -I https://wonderstar.qbot.now/ | grep -i cache-control
# Expect:  Cache-Control: no-cache

# If cache-control is wrong, re-check the Caddyfile block for the header directive.`,
      },
      {
        title: 'Blank page in the browser',
        cmd: `# Open browser devtools → Console tab.
# Common causes:
#   - Wrong VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (bakes into bundle at build time)
#   - Rebuild after changing .env — Vite vars are BUILD-TIME, not runtime
cd /opt/wonderstar && npm run build`,
      },
      {
        title: 'Supabase RLS denying reads',
        body: 'The frontend uses the anon key. RLS policies must allow the anon or authenticated role for every table it reads/writes.',
        cmd: `# In the Supabase dashboard:
#   → SQL editor → run: SELECT * FROM pg_policies WHERE tablename = '<table>';
# Or check the browser Network tab — 401/403 responses reveal the failing policy.`,
      },
      {
        title: 'Payment redirect fails',
        body: 'wonderstar calls VITE_PAYMENT_API_URL (aigenius-backend-old) for /payments/initiate. If checkout hangs, verify that backend is up.',
        cmd: `curl -I https://api-old.aigenius.now/health
# Should return 200. If not, check the aigenius-backend-old docs.`,
      },
    ],
  },

  // ---------------------------------------------------------------------------
  // GATE-ADMIN (Electron Turnstile admin — desktop app)
  // ---------------------------------------------------------------------------
  {
    slug: 'gate-admin',
    name: 'gate-admin (Turnstile controller — desktop)',
    repo: 'https://github.com/craveasiadev/gate-admin.git',
    blurb: 'Electron desktop app for on-prem turnstile administration. Runs an Express server locally to talk to the turnstile hardware over the LAN (SQLite-backed). No VPS deploy — installer distributed to site PCs.',
    domains: ['(on-prem desktop only)'],
    start: [
      {
        title: 'Clone + install',
        cmd: `git clone https://github.com/craveasiadev/gate-admin.git
cd gate-admin
npm install
# electron-builder runs install-app-deps to rebuild sqlite3 against the current Electron ABI`,
      },
      {
        title: 'First launch config',
        body: 'On first boot, the app opens the Setup panel and prompts for:',
        cmd: `# - LAN gateway API endpoint
# - Turnstile device IPs (one per lane)
# - Local admin password
# Config written to %APPDATA%\\gate-admin\\config.json`,
      },
    ],
    dev: [
      {
        title: 'Run in Electron dev mode',
        cmd: `cd gate-admin
npm start
# Opens the Electron window with DevTools attached. Hot-reload via manual refresh.`,
      },
      {
        title: 'Rebuild native modules if sqlite3 crashes',
        cmd: `npm run rebuild`,
      },
    ],
    prod: [
      {
        title: 'Build installer',
        cmd: `# Windows:
npm run build:win
# macOS:
npm run build:mac
# Linux (AppImage):
npm run build:linux

# Output in dist/ — copy to the site PC and run as Administrator (COM-port + firewall exceptions).`,
      },
    ],
    maintenance: [
      {
        title: 'sqlite3 native module mismatch (Electron upgrade)',
        cmd: `npm run rebuild
# rebuilds sqlite3 for the current Electron ABI`,
      },
      {
        title: 'Turnstile device unreachable',
        cmd: `# From the site PC:
ping <turnstile-ip>
Test-NetConnection <turnstile-ip> -Port <turnstile-port>

# App log:
#   %APPDATA%\\gate-admin\\logs\\gate.log`,
      },
      {
        title: 'Reset local DB',
        cmd: `# Stop the app, then:
Remove-Item "$env:APPDATA\\gate-admin\\gate.sqlite" -Force
# Restart the app — a fresh DB is created on next launch (loses local state).`,
      },
    ],
  },
];

// -----------------------------------------------------------------------------
// UI COMPONENTS
// -----------------------------------------------------------------------------

export function DocsIndex() {
  return (
    <div className="p-5 sm:p-8 max-w-5xl">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Docs</h1>
        <p className="mt-1 text-sm text-gray-500">
          Deployment + operations notes for every project on this VPS. Each entry has four tabs:
          <span className="mx-1 font-semibold text-gray-700">Start Fresh</span>,
          <span className="mx-1 font-semibold text-gray-700">Dev Mode</span>,
          <span className="mx-1 font-semibold text-gray-700">Prod Mode</span>, and
          <span className="mx-1 font-semibold text-gray-700">Maintenance</span>.
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
            {d.reverseProxyPort && (
              <div className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-mono text-[10px] border border-emerald-200">
                <Server size={10} strokeWidth={2.5} />
                {d.reverseProxyPort}
              </div>
            )}
            {d.repo && (
              <div className="mt-2 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-gray-900 text-white font-mono text-[10px]">
                <Github size={10} strokeWidth={2.5} />
                repo
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}

type TabKey = 'start' | 'dev' | 'prod' | 'maintenance' | 'vpsKnowledge';

const TAB_META: { key: TabKey; label: string; icon: typeof TerminalIcon }[] = [
  { key: 'start', label: 'Start Fresh', icon: Rocket },
  { key: 'dev', label: 'Dev Mode', icon: Code },
  { key: 'prod', label: 'Prod Mode', icon: Server },
  { key: 'maintenance', label: 'Maintenance', icon: Wrench },
  { key: 'vpsKnowledge', label: 'VPS Knowledge', icon: Cpu },
];

export function DocsProject() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const doc = useMemo(() => PROJECT_DOCS.find((d) => d.slug === slug), [slug]);
  const [tab, setTab] = useState<TabKey>('start');

  useEffect(() => { setTab('start'); }, [slug]);

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

  const steps: Step[] = (doc[tab] as Step[] | undefined) ?? [];
  const visibleTabs = TAB_META.filter(
    (t) => t.key !== 'vpsKnowledge' || (doc.vpsKnowledge && doc.vpsKnowledge.length > 0),
  );

  return (
    <div className="p-5 sm:p-8 max-w-4xl">
      <button onClick={() => navigate('/docs')} className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900">
        <ArrowLeft size={14} strokeWidth={2.5} /> Docs
      </button>
      <h1 className="mt-3 text-2xl font-bold tracking-tight text-gray-900 font-mono">{doc.name}</h1>
      <p className="mt-1 text-sm text-gray-600 leading-relaxed">{doc.blurb}</p>

      <div className="mt-3 flex flex-wrap gap-2 items-center">
        {doc.domains.map((dom) => (
          <span key={dom} className="inline-flex items-center px-2 py-0.5 rounded bg-gray-100 text-gray-700 font-mono text-[10px]">{dom}</span>
        ))}
        {doc.reverseProxyPort && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-mono text-[10px] border border-emerald-200">
            <Server size={10} strokeWidth={2.5} />
            {doc.reverseProxyPort}
          </span>
        )}
        {doc.repo && (
          <a
            href={doc.repo}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-gray-900 text-white hover:bg-gray-700 font-mono text-[10px] transition-colors"
          >
            <Github size={10} strokeWidth={2.5} />
            {doc.repo.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')}
            <ExternalLink size={9} strokeWidth={2.5} />
          </a>
        )}
      </div>

      <div className="mt-5 inline-flex bg-gray-100 rounded-lg p-1 gap-1 flex-wrap">
        {visibleTabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-xs font-bold uppercase tracking-wide transition-colors ${
              tab === key ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Icon size={12} strokeWidth={2.5} />
            {label}
          </button>
        ))}
      </div>

      {steps.length === 0 ? (
        <p className="mt-6 text-sm text-gray-500 italic">Nothing documented yet for this tab. Add steps to <code className="font-mono">Docs.tsx</code>.</p>
      ) : (
        <ol className="mt-5 space-y-4">
          {steps.map((s, i) => (
            <li key={i} className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              <div className="px-4 sm:px-5 py-3 border-b border-gray-100 flex items-center gap-3">
                <div className="w-6 h-6 rounded-full bg-gray-900 text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0 tabular-nums">{i + 1}</div>
                <h3 className="text-sm font-semibold text-gray-900">{s.title}</h3>
              </div>
              <div className="p-4 sm:p-5 space-y-3">
                {s.body && <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">{s.body}</p>}
                {s.cmd && <TerminalBlock cmd={s.cmd} />}
                {s.images && s.images.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {s.images.map((img, j) => (
                      <DocImage key={j} src={img.src} alt={img.alt} caption={img.caption} />
                    ))}
                  </div>
                )}
                {s.note && <p className="text-xs text-gray-500 italic leading-relaxed">{s.note}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function DocImage({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const [errored, setErrored] = useState(false);
  return (
    <figure className="rounded-xl border border-gray-200 bg-white overflow-hidden">
      {errored ? (
        <div className="aspect-video bg-gray-50 border-b border-gray-200 flex flex-col items-center justify-center p-4 text-center">
          <div className="w-10 h-10 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center mb-2">
            <BookOpen size={18} strokeWidth={2.25} />
          </div>
          <p className="text-[11px] font-semibold text-gray-600">Screenshot pending</p>
          <p className="text-[10px] text-gray-500 mt-1 leading-snug">{alt}</p>
          <code className="mt-2 text-[10px] text-gray-400 font-mono break-all">qcontrol/web/public{src}</code>
        </div>
      ) : (
        <img
          src={src}
          alt={alt}
          onError={() => setErrored(true)}
          className="w-full aspect-video object-cover bg-gray-100 border-b border-gray-200"
          loading="lazy"
        />
      )}
      {caption && (
        <figcaption className="px-3 py-2 text-[11px] text-gray-700 leading-snug">{caption}</figcaption>
      )}
    </figure>
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
