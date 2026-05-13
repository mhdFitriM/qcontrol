import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Play, RefreshCw, Square, Hammer, ScrollText } from 'lucide-react';
import { api } from '../lib/api';

interface Container { name: string; status: string; ports: string; image: string; }

export function ProjectDetail() {
  const { name = '' } = useParams();
  const [containers, setContainers] = useState<Container[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [output, setOutput] = useState<string>('');
  const [loading, setLoading] = useState(true);

  async function loadContainers() {
    setLoading(true);
    try {
      const r = await api.get<{ data: Container[] }>(`/projects/${encodeURIComponent(name)}/containers`);
      setContainers(r.data);
    } catch (e: any) { setOutput(String(e.message || e)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void loadContainers(); }, [name]);

  async function action(label: string, path: string) {
    setBusy(label);
    setOutput(`> ${label}…\n`);
    try {
      const r = await api.post<{ ok: boolean; log: string }>(`/projects/${encodeURIComponent(name)}/${path}`);
      setOutput((cur) => cur + (r.log || '(no output)') + '\n\n✓ done');
    } catch (e: any) {
      setOutput((cur) => cur + '\n✗ ' + (e?.body?.message || e.message || String(e)));
    } finally {
      setBusy(null);
      void loadContainers();
    }
  }

  async function tailLogs() {
    setBusy('logs');
    try {
      const text = await api.text(`/projects/${encodeURIComponent(name)}/logs?tail=200`);
      setOutput(text);
    } catch (e: any) {
      setOutput(String(e.message || e));
    } finally { setBusy(null); }
  }

  return (
    <div className="p-5 sm:p-8 max-w-5xl">
      <Link to="/projects" className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900 transition-colors">
        <ArrowLeft size={14} strokeWidth={2.5} /> Projects
      </Link>
      <h1 className="mt-3 text-2xl font-bold tracking-tight text-gray-900">{name}</h1>
      <p className="mt-1 text-sm text-gray-500">Path: <code className="text-xs">/opt/{name}</code></p>

      <div className="mt-5 grid grid-cols-2 sm:grid-cols-5 gap-2">
        <ActionButton onClick={() => action('Restart', 'restart')} busy={busy === 'Restart'} icon={RefreshCw} label="Restart" />
        <ActionButton onClick={() => action('Up', 'up')} busy={busy === 'Up'} icon={Play} label="Up" />
        <ActionButton onClick={() => action('Rebuild', 'rebuild')} busy={busy === 'Rebuild'} icon={Hammer} label="Rebuild" />
        <ActionButton onClick={() => action('Pull + Rebuild', 'pull-and-rebuild')} busy={busy === 'Pull + Rebuild'} icon={Hammer} label="Pull + rebuild" />
        <ActionButton onClick={() => action('Down', 'down')} busy={busy === 'Down'} icon={Square} label="Down" danger />
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
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-900">Output</h2>
          <button
            onClick={tailLogs}
            disabled={busy === 'logs'}
            className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900 transition-colors disabled:opacity-50"
          >
            {busy === 'logs' ? <Loader2 size={12} className="animate-spin" /> : <ScrollText size={12} strokeWidth={2.5} />}
            Tail logs
          </button>
        </div>
        <pre className="rounded-xl border border-gray-200 bg-gray-900 text-green-200 p-4 text-xs leading-snug font-mono whitespace-pre-wrap break-all max-h-96 overflow-y-auto">
          {output || '(no output yet — pick an action above or tail logs)'}
        </pre>
      </section>
    </div>
  );
}

function ActionButton({
  onClick, busy, icon: Icon, label, danger,
}: { onClick: () => void; busy: boolean; icon: any; label: string; danger?: boolean }) {
  const base = 'inline-flex items-center justify-center gap-1.5 h-10 rounded-lg text-xs font-semibold uppercase tracking-wide transition-colors disabled:opacity-50';
  const cls = danger
    ? 'border border-red-200 bg-white hover:bg-red-50 text-red-700'
    : 'border border-gray-200 bg-white hover:border-gray-900 text-gray-700 hover:text-gray-900';
  return (
    <button onClick={onClick} disabled={busy} className={`${base} ${cls}`}>
      {busy ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} strokeWidth={2.5} />}
      {label}
    </button>
  );
}
