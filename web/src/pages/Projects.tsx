import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Copy, GitBranch, Loader2, Power } from 'lucide-react';
import { api } from '../lib/api';
import { CloneModal } from './CloneModal';

interface Project {
  name: string;
  path: string;
  hasVpsOverlay: boolean;
  branch: string | null;
  lastCommit: string | null;
  running: boolean;
}

export function Projects() {
  const [data, setData] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cloneSource, setCloneSource] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get<{ data: Project[] }>('/projects');
      setData(r.data);
    } catch (e: any) { setError(e.message || 'Failed to load'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="p-5 sm:p-8 max-w-5xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Projects</h1>
        <p className="mt-1 text-sm text-gray-500">Every docker-compose project under <code className="text-xs">/opt</code> on this VPS.</p>
      </header>

      {loading && (
        <div className="py-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-gray-400" /></div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 text-red-700 text-sm px-3 py-2">{error}</div>
      )}
      {!loading && !error && data.length === 0 && (
        <p className="text-sm text-gray-500">No projects detected under /opt.</p>
      )}

      <div className="space-y-2">
        {data.map((p) => (
          <div
            key={p.name}
            className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-4 hover:border-gray-900 transition-colors"
          >
            <Link
              to={`/projects/${encodeURIComponent(p.name)}`}
              className="flex items-center gap-3 min-w-0 flex-1"
            >
              <span
                className={`w-2 h-2 rounded-full flex-shrink-0 ${p.running ? 'bg-emerald-500' : 'bg-gray-300'}`}
                aria-label={p.running ? 'running' : 'stopped'}
              />
              <div className="min-w-0">
                <div className="font-semibold text-gray-900 text-sm truncate">{p.name}</div>
                <div className="text-xs text-gray-500 flex items-center gap-2 mt-0.5">
                  {p.branch && (
                    <span className="inline-flex items-center gap-1">
                      <GitBranch size={11} strokeWidth={2.5} />
                      {p.branch}
                    </span>
                  )}
                  {p.lastCommit && (
                    <span className="truncate font-mono">{p.lastCommit}</span>
                  )}
                </div>
              </div>
            </Link>
            <div className="flex items-center gap-2 flex-shrink-0">
              {p.hasVpsOverlay && (
                <span className="text-[10px] font-bold uppercase tracking-wide text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">vps</span>
              )}
              <span className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
                {p.running ? 'running' : <span className="inline-flex items-center gap-1"><Power size={10} strokeWidth={2.5} /> stopped</span>}
              </span>
              <button
                onClick={() => setCloneSource(p.name)}
                title={`Clone ${p.name} as a new instance`}
                aria-label={`Clone ${p.name}`}
                className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-gray-200 hover:border-gray-900 hover:bg-gray-50 text-[10px] font-bold uppercase tracking-wide text-gray-700 transition-colors"
              >
                <Copy size={12} strokeWidth={2.5} />
                Clone
              </button>
              <Link
                to={`/projects/${encodeURIComponent(p.name)}`}
                className="text-gray-400 hover:text-gray-900 transition-colors"
                aria-label={`Open ${p.name}`}
              >
                <ArrowRight size={16} strokeWidth={2.5} />
              </Link>
            </div>
          </div>
        ))}
      </div>

      {cloneSource && (
        <CloneModal source={cloneSource} onClose={() => { setCloneSource(null); void load(); }} />
      )}

      <button
        onClick={load}
        className="mt-4 text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900 transition-colors"
      >
        Refresh
      </button>
    </div>
  );
}
