import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Play, RefreshCw, Square, Hammer, ScrollText, Trash2, AlertTriangle, Terminal, Download } from 'lucide-react';
import { api } from '../lib/api';
import { ConfirmActionModal } from '../components/ConfirmActionModal';

interface Container { name: string; status: string; state: string; ports: string; image: string; }
interface ContainersResp { data: Container[]; running: boolean; total: number; runningCount: number; }

type OutputTab = 'output' | 'logs';

interface PendingAction {
  label: string;
  path: string;
  icon: any;
  danger?: boolean;
  needsGit?: boolean;
}

const ACTIONS: PendingAction[] = [
  { label: 'Restart',         path: 'restart',          icon: RefreshCw },
  { label: 'Up',              path: 'up',               icon: Play },
  { label: 'Rebuild',         path: 'rebuild',          icon: Hammer },
  { label: 'Pull + Rebuild',  path: 'pull-and-rebuild', icon: Download, needsGit: true },
  { label: 'Down',            path: 'down',             icon: Square, danger: true },
];

export function ProjectDetail() {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const [containers, setContainers] = useState<Container[]>([]);
  const [stats, setStats] = useState<{ running: boolean; total: number; runningCount: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<string>('');
  const [logs, setLogs] = useState<string>('');
  const [logsLoading, setLogsLoading] = useState(false);
  const [outputTab, setOutputTab] = useState<OutputTab>('output');
  const [loading, setLoading] = useState(true);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const outputRef = useRef<HTMLPreElement>(null);

  async function loadContainers() {
    setLoading(true);
    try {
      const r = await api.get<ContainersResp>(`/projects/${encodeURIComponent(name)}/containers`);
      setContainers(r.data);
      setStats({ running: r.running, total: r.total, runningCount: r.runningCount });
      if (r.total > 0 && r.runningCount < r.total) {
        void loadLogs();
        setOutputTab('logs');
      }
    } catch (e: any) { setOutput(String(e.message || e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadContainers(); }, [name]);

  /**
   * Stream an action's output from the server as it's produced. Uses fetch's
   * ReadableStream so each chunk of stdout/stderr appears in the terminal
   * pane immediately — no waiting for the whole command to finish.
   */
  async function runAction(a: PendingAction) {
    setBusy(a.label);
    setOutput('');
    setOutputTab('output');
    try {
      const res = await fetch(`/api${`/projects/${encodeURIComponent(name)}/${a.path}`}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (res.status === 401) { location.href = '/login'; return; }
      if (!res.body) {
        setOutput('(no response stream — server may be unreachable)');
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setOutput((cur) => cur + chunk);
        // Autoscroll to bottom as new output arrives.
        requestAnimationFrame(() => {
          if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
        });
      }
    } catch (e: any) {
      setOutput((cur) => cur + '\n[qcontrol] ✗ stream failed: ' + (e.message || String(e)) + '\n');
    } finally {
      setBusy(null);
      void loadContainers();
    }
  }

  async function loadLogs() {
    setLogsLoading(true);
    try {
      const text = await api.text(`/projects/${encodeURIComponent(name)}/logs?tail=200`);
      setLogs(text || '(no logs)');
    } catch (e: any) {
      setLogs('✗ ' + (e?.body?.message || e.message || String(e)));
    } finally { setLogsLoading(false); }
  }

  return (
    <div className="p-5 sm:p-8 max-w-5xl">
      <Link to="/projects" className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900 transition-colors">
        <ArrowLeft size={14} strokeWidth={2.5} /> Projects
      </Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">{name}</h1>
        <StatusBadge loading={loading && !stats} stats={stats} />
      </div>
      <p className="mt-1 text-sm text-gray-500">Path: <code className="text-xs">/opt/{name}</code></p>

      <div className="mt-5 grid grid-cols-2 sm:grid-cols-5 gap-2">
        {ACTIONS.map((a) => (
          <ActionButton
            key={a.path}
            onClick={() => setPending(a)}
            busy={busy === a.label}
            disabled={!!busy && busy !== a.label}
            icon={a.icon}
            label={a.label}
            danger={a.danger}
          />
        ))}
      </div>

      <section className="mt-6">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-900">Containers</h2>
          {loading && <Loader2 size={14} className="animate-spin text-gray-400" />}
        </div>
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Name</th>
                <th className="px-3 py-2 text-left font-semibold">Status</th>
                <th className="px-3 py-2 text-left font-semibold">Ports</th>
                <th className="px-3 py-2 text-left font-semibold">Image</th>
              </tr>
            </thead>
            <tbody>
              {containers.length === 0 && !loading && (
                <tr><td colSpan={4} className="px-3 py-4 text-xs text-gray-500 text-center">No containers (project is down or never started)</td></tr>
              )}
              {containers.map((c) => (
                <tr key={c.name} className="border-t border-gray-100">
                  <td className="px-3 py-2 font-mono text-xs text-gray-900">{c.name}</td>
                  <td className="px-3 py-2 text-xs text-gray-600">{c.status}</td>
                  <td className="px-3 py-2 text-xs text-gray-600 font-mono">{c.ports}</td>
                  <td className="px-3 py-2 text-xs text-gray-600 font-mono truncate">{c.image}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div className="inline-flex bg-gray-100 rounded-lg p-1 gap-1">
            <TabButton active={outputTab === 'output'} onClick={() => setOutputTab('output')} icon={Terminal} label="Action output" />
            <TabButton active={outputTab === 'logs'} onClick={() => { setOutputTab('logs'); if (!logs && !logsLoading) void loadLogs(); }} icon={ScrollText} label={`Container logs${stats && stats.runningCount < stats.total ? ' ⚠' : ''}`} />
          </div>
          {outputTab === 'logs' && (
            <button
              onClick={loadLogs}
              disabled={logsLoading}
              className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900 transition-colors disabled:opacity-50"
            >
              {logsLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} strokeWidth={2.5} />}
              Refresh logs
            </button>
          )}
        </div>
        {outputTab === 'output' ? (
          <pre
            ref={outputRef}
            className="rounded-xl border border-gray-200 bg-gray-900 text-green-200 p-4 text-xs leading-snug font-mono whitespace-pre-wrap break-all max-h-96 overflow-y-auto"
          >
            {output || '(no output yet — pick an action above)'}
          </pre>
        ) : (
          <pre className="rounded-xl border border-gray-200 bg-gray-900 text-green-200 p-4 text-xs leading-snug font-mono whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
            {logsLoading && !logs ? 'Loading logs…' : (logs || '(no logs loaded — click Refresh)')}
          </pre>
        )}
        {stats && stats.total > 0 && stats.runningCount < stats.total && outputTab === 'logs' && (
          <p className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
            ⚠ {stats.total - stats.runningCount} of {stats.total} containers are not running — logs auto-loaded so you can see why.
          </p>
        )}
      </section>

      {/* Danger zone — separated visually so it doesn't sit next to routine actions. */}
      <section className="mt-8">
        <h2 className="text-xs font-bold uppercase tracking-widest text-red-700 mb-2">Danger zone</h2>
        <div className="rounded-xl border border-red-200 bg-red-50/50 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-xs text-red-900">
            <div className="font-semibold">Remove this project</div>
            <div className="mt-0.5 text-red-700">
              Stops containers, deletes <code className="font-mono">/opt/{name}</code>, and removes its reverse-proxy entries. Cannot be undone.
            </div>
          </div>
          <button
            onClick={() => setRemoveOpen(true)}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold uppercase tracking-wide transition-colors flex-shrink-0"
          >
            <Trash2 size={14} strokeWidth={2.5} />
            Remove project
          </button>
        </div>
      </section>

      {removeOpen && (
        <RemoveProjectModal
          project={name}
          onClose={() => setRemoveOpen(false)}
          onRemoved={() => navigate('/projects', { replace: true })}
        />
      )}

      {pending && (
        <ConfirmActionModal
          title={`${pending.label} — ${name}`}
          description={`Review the plan below, then type "confirm" to execute.`}
          project={name}
          needsGit={pending.needsGit}
          danger={pending.danger}
          confirmLabel={pending.label}
          onClose={() => setPending(null)}
          onConfirm={() => {
            const action = pending;
            setPending(null);
            void runAction(action);
          }}
        />
      )}
    </div>
  );
}

function RemoveProjectModal({
  project, onClose, onRemoved,
}: { project: string; onClose: () => void; onRemoved: () => void }) {
  const [confirm, setConfirm] = useState('');
  const [removeReverseProxy, setRemoveReverseProxy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; log: string; warning?: string } | null>(null);

  async function destroy() {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.text(`/projects/${encodeURIComponent(project)}`);
      // Use fetch directly because our `api` helper doesn't expose DELETE.
      void r;
    } catch {}
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(project)}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm, removeReverseProxy }),
      });
      const body = await r.json();
      if (r.ok && body.ok) {
        setResult({ ok: true, log: body.log || '', warning: body.warning });
        // Auto-close + redirect after a beat so the user sees the log.
        setTimeout(onRemoved, 1200);
      } else {
        setResult({ ok: false, log: body.log || body.message || body.error || 'Remove failed' });
      }
    } catch (e: any) {
      setResult({ ok: false, log: e.message || String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-4 border-b border-gray-200 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-red-600 text-white flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={18} strokeWidth={2.5} />
          </div>
          <div>
            <h2 className="text-base font-bold tracking-tight text-gray-900">Remove <span className="font-mono text-sm">{project}</span></h2>
            <p className="text-xs text-gray-500">This is permanent. Type the project name to confirm.</p>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {!result && (
            <>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-700 mb-1">
                  Type <span className="font-mono">{project}</span> to confirm
                </label>
                <input
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoFocus
                  spellCheck={false}
                  className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:border-red-600"
                />
              </div>

              <label className="flex items-start gap-2 text-xs text-gray-700">
                <input
                  type="checkbox"
                  checked={removeReverseProxy}
                  onChange={(e) => setRemoveReverseProxy(e.target.checked)}
                  className="accent-red-600 mt-0.5"
                />
                <span>
                  Also remove this project's <code className="font-mono">*_DOMAIN</code> / <code className="font-mono">*_UPSTREAM</code> entries from <code className="font-mono">/opt/reverse-proxy/.env</code> and its block from the Caddyfile, then safely recreate Caddy.
                </span>
              </label>

              <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5 text-[11px] text-gray-600 space-y-1">
                <div><strong>This will:</strong></div>
                <div>1. <code className="font-mono">docker compose down -v --remove-orphans</code> in <code className="font-mono">/opt/{project}</code></div>
                <div>2. <code className="font-mono">rm -rf /opt/{project}</code> (deletes all source code, .env, data)</div>
                {removeReverseProxy && <div>3. Strip <code className="font-mono">/opt/reverse-proxy/.env</code> + Caddyfile entries</div>}
                {removeReverseProxy && <div>4. Pre-validate + recreate Caddy (no downtime if config is clean)</div>}
              </div>
            </>
          )}

          {result && (
            <div className="space-y-3">
              <div className={`rounded-lg border px-3 py-2.5 text-xs ${
                result.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-red-200 bg-red-50 text-red-900'
              }`}>
                <strong>{result.ok ? '✓ Removed' : '✗ Failed'}</strong>
                {result.warning && <div className="mt-1">{result.warning}</div>}
                {result.ok && !result.warning && <div className="mt-1">Returning to project list…</div>}
              </div>
              <pre className="rounded-xl border border-gray-200 bg-gray-900 text-green-200 p-3 text-[11px] leading-snug font-mono whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                {result.log}
              </pre>
            </div>
          )}
        </div>

        {!result && (
          <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
            <button onClick={onClose} className="text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900 px-3 py-2">
              Cancel
            </button>
            <button
              onClick={destroy}
              disabled={busy || confirm !== project}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold uppercase tracking-wide transition-colors disabled:opacity-40"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} strokeWidth={2.5} />}
              Remove permanently
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active, onClick, icon: Icon, label,
}: { active: boolean; onClick: () => void; icon: any; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-md text-xs font-bold uppercase tracking-wide transition-colors ${
        active ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
      }`}
    >
      <Icon size={12} strokeWidth={2.5} />
      {label}
    </button>
  );
}

function StatusBadge({
  loading, stats,
}: { loading: boolean; stats: { running: boolean; total: number; runningCount: number } | null }) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-gray-100 text-gray-500 text-[11px] font-semibold uppercase tracking-wide">
        <Loader2 size={11} className="animate-spin" />
        Checking
      </span>
    );
  }
  if (!stats || stats.total === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-gray-100 text-gray-600 text-[11px] font-semibold uppercase tracking-wide">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-400" />
        Not started
      </span>
    );
  }
  const allUp = stats.runningCount === stats.total;
  const noneUp = stats.runningCount === 0;
  if (allUp) {
    return (
      <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-[11px] font-semibold uppercase tracking-wide">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        Running · {stats.runningCount}/{stats.total}
      </span>
    );
  }
  if (noneUp) {
    return (
      <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-red-50 border border-red-200 text-red-800 text-[11px] font-semibold uppercase tracking-wide">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        Stopped · 0/{stats.total}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-amber-50 border border-amber-200 text-amber-900 text-[11px] font-semibold uppercase tracking-wide">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
      Partial · {stats.runningCount}/{stats.total}
    </span>
  );
}

function ActionButton({
  onClick, busy, disabled, icon: Icon, label, danger,
}: { onClick: () => void; busy: boolean; disabled?: boolean; icon: any; label: string; danger?: boolean }) {
  const base = 'inline-flex items-center justify-center gap-1.5 h-10 rounded-lg text-xs font-semibold uppercase tracking-wide transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const cls = danger
    ? 'border border-red-200 bg-white hover:bg-red-50 text-red-700'
    : 'border border-gray-200 bg-white hover:border-gray-900 text-gray-700 hover:text-gray-900';
  return (
    <button onClick={onClick} disabled={busy || disabled} className={`${base} ${cls}`}>
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} strokeWidth={2.5} />}
      {label}
    </button>
  );
}
