import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Loader2, X, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';

interface SourceDomain { envKey: string; destKeySuffix: string; value: string; }

interface CloneInfo {
  source: string;
  gitRemote: string | null;
  branches: string[];
  suggestedDest: string;
  suggestedPort: number;
  usedPorts: number[];
  sourceDomains: SourceDomain[];
}

interface DomainMapping { destKeySuffix: string; sourceDomain: string; destDomain: string; }

interface CloneResult {
  ok: boolean;
  dest?: string;
  destDir?: string;
  port?: number;
  portMap?: Record<string, number>;
  proxy?: Array<{ domain: string; envKey: string; sourceDomain: string | null }>;
  log?: string;
}

export function CloneModal({ source, onClose }: { source: string; onClose: () => void }) {
  const [info, setInfo] = useState<CloneInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CloneResult | null>(null);

  // form state
  const [dest, setDest] = useState('');
  const [method, setMethod] = useState<'git' | 'copy'>('git');
  const [branch, setBranch] = useState('main');
  const [port, setPort] = useState('');
  const [reloadCaddy, setReloadCaddy] = useState(true);

  // domain mappings — one row per source domain we detected, plus a single
  // free-form row when the source has no detected reverse-proxy entries.
  const [mappings, setMappings] = useState<DomainMapping[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const r = await api.get<CloneInfo>(`/projects/${encodeURIComponent(source)}/clone-info`);
        setInfo(r);
        setDest(r.suggestedDest);
        setPort(String(r.suggestedPort));
        if (!r.gitRemote) setMethod('copy');
        if (r.branches.length > 0 && !r.branches.includes('main')) setBranch(r.branches[0]);

        // Seed mapping rows. If the source has detected domains, one row
        // per source domain, dest fields blank for the user to fill. Else
        // a single empty row for ad-hoc wiring.
        if (r.sourceDomains.length > 0) {
          setMappings(r.sourceDomains.map((d) => ({
            destKeySuffix: d.destKeySuffix,
            sourceDomain: d.value,
            destDomain: '',
          })));
        } else {
          setMappings([{ destKeySuffix: 'DOMAIN', sourceDomain: '', destDomain: '' }]);
        }
      } catch (e: any) {
        setLoadError(e.message || 'Failed to load source info');
      }
    })();
  }, [source]);

  const hasAnyDestDomain = useMemo(() => mappings.some((m) => m.destDomain.trim()), [mappings]);

  function updateMapping(i: number, patch: Partial<DomainMapping>) {
    setMappings((rows) => rows.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }
  function addMappingRow() {
    setMappings((rows) => [...rows, { destKeySuffix: `DOMAIN_${rows.length}`, sourceDomain: '', destDomain: '' }]);
  }
  function removeMappingRow(i: number) {
    setMappings((rows) => rows.filter((_, idx) => idx !== i));
  }

  async function submit() {
    setSubmitting(true);
    setResult(null);
    try {
      const cleaned = mappings
        .map((m) => ({ ...m, destDomain: m.destDomain.trim(), sourceDomain: m.sourceDomain.trim() }))
        .filter((m) => m.destDomain);
      const r = await api.post<CloneResult>('/projects/clone', {
        source,
        dest,
        method,
        branch,
        domainMappings: cleaned,
        port: port ? Number(port) : undefined,
        reloadCaddy,
      });
      setResult(r);
    } catch (e: any) {
      setResult({ ok: false, log: (e?.body?.log) || (e?.body?.message) || e.message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
      >
        <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-md bg-gray-900 text-white flex items-center justify-center">
              <Copy size={16} strokeWidth={2.5} />
            </div>
            <div>
              <h2 className="text-base font-bold tracking-tight text-gray-900">Clone <span className="font-mono text-sm">{source}</span></h2>
              <p className="text-xs text-gray-500">Copy this project as a new staging / dev instance.</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500">
            <X size={18} strokeWidth={2.25} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {loadError && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs px-3 py-2">{loadError}</div>
          )}

          {!info && !loadError && (
            <div className="py-10 flex items-center justify-center"><Loader2 size={20} className="animate-spin text-gray-400" /></div>
          )}

          {info && !result && (
            <div className="space-y-4">
              <Field label="Destination folder name" hint={`Will be created at /opt/${dest || 'destination'}`}>
                <input
                  value={dest}
                  onChange={(e) => setDest(e.target.value)}
                  spellCheck={false}
                  className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:border-gray-900"
                />
              </Field>

              <Field label="Copy method">
                <div className="flex bg-gray-100 rounded-lg p-1 gap-1">
                  {(['git', 'copy'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      disabled={m === 'git' && !info.gitRemote}
                      onClick={() => setMethod(m)}
                      className={`flex-1 h-9 rounded-md text-xs font-bold uppercase tracking-wide transition-colors disabled:opacity-40 ${
                        method === m ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {m === 'git' ? 'Fresh git clone' : 'Full directory copy'}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-gray-500 mt-1.5">
                  {method === 'git'
                    ? 'Fresh checkout from the source\'s git remote. .env is included if committed.'
                    : 'Recursive copy (rsync if available). Includes .env so qcontrol can rewrite it.'}
                </p>
              </Field>

              {method === 'git' && (
                <Field label="Branch">
                  <select
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className="w-full h-10 px-3 border border-gray-300 rounded-lg text-sm bg-white focus:outline-none focus:border-gray-900"
                  >
                    {info.branches.length === 0 && <option value="main">main</option>}
                    {info.branches.map((b) => <option key={b} value={b}>{b}</option>)}
                  </select>
                </Field>
              )}

              <Field label="Upstream port" hint={`Suggested: ${info.suggestedPort}. If the source's compose binds multiple ports, the others get auto-allocated starting from here.`}>
                <input
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
                  inputMode="numeric"
                  className="w-28 h-10 px-3 border border-gray-300 rounded-lg text-sm font-mono tabular-nums focus:outline-none focus:border-gray-900"
                />
              </Field>

              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-700">
                    Domain mappings {info.sourceDomains.length > 0 && <span className="text-gray-400 font-normal normal-case">(detected from source's reverse-proxy entries)</span>}
                  </label>
                  <button type="button" onClick={addMappingRow} className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900">
                    + Add row
                  </button>
                </div>
                <div className="space-y-2">
                  {mappings.map((m, i) => (
                    <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] gap-2 items-center">
                      <input
                        value={m.sourceDomain}
                        onChange={(e) => updateMapping(i, { sourceDomain: e.target.value })}
                        placeholder="hub.qbot.jp"
                        spellCheck={false}
                        title={`Source's env key: ${m.destKeySuffix}`}
                        className="h-9 px-2.5 border border-gray-300 rounded-lg text-xs font-mono bg-gray-50 focus:outline-none focus:border-gray-900"
                      />
                      <span className="text-xs text-gray-400">→</span>
                      <input
                        value={m.destDomain}
                        onChange={(e) => updateMapping(i, { destDomain: e.target.value })}
                        placeholder="staging-qbotu.qbot.now"
                        spellCheck={false}
                        className="h-9 px-2.5 border border-gray-300 rounded-lg text-xs font-mono focus:outline-none focus:border-gray-900"
                      />
                      <button
                        type="button"
                        onClick={() => removeMappingRow(i)}
                        aria-label="Remove row"
                        className="w-9 h-9 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 inline-flex items-center justify-center"
                      >
                        <X size={14} strokeWidth={2.5} />
                      </button>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-gray-500 mt-2 leading-relaxed">
                  Each mapped destination gets its own Caddy block, all pointing to a single shared upstream. qcontrol also substitutes every occurrence of the source domain in the cloned project's <code className="font-mono">.env</code> (catches <code className="font-mono">APP_DOMAIN</code>, <code className="font-mono">API_URL</code>, <code className="font-mono">VITE_API_BASE_URL</code>, etc. without naming each one). Leave all dest blank to skip reverse-proxy wiring.
                </p>
              </div>

              {hasAnyDestDomain && (
                <label className="flex items-center gap-2 text-xs text-gray-700">
                  <input type="checkbox" checked={reloadCaddy} onChange={(e) => setReloadCaddy(e.target.checked)} className="accent-gray-900" />
                  Pre-validate + recreate Caddy after wiring (recommended — picks up new env vars immediately, no downtime if config is clean)
                </label>
              )}

              <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2.5 text-[11px] text-gray-600">
                <strong>What happens:</strong> create <code className="font-mono">/opt/{dest}</code>, rewrite its <code className="font-mono">docker-compose.vps.yml</code> ports + <code className="font-mono">.env</code> ports/domains, then{hasAnyDestDomain ? ` append ${mappings.filter((m) => m.destDomain.trim()).length} block(s) to the reverse-proxy.` : ' skip reverse-proxy wiring.'} You still need to bring the stack up with <code className="font-mono">docker compose up -d</code> in the new folder.
              </div>
            </div>
          )}

          {result && (
            <div className="space-y-3">
              <div className={`rounded-lg border px-3 py-2.5 text-sm ${
                result.ok
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-red-200 bg-red-50 text-red-900'
              }`}>
                <div className="flex items-center gap-1.5 font-bold uppercase tracking-wide text-xs">
                  {result.ok ? <CheckCircle2 size={14} strokeWidth={2.5} /> : <AlertTriangle size={14} strokeWidth={2.5} />}
                  {result.ok ? 'Cloned' : 'Failed'}
                </div>
                {result.ok && (
                  <div className="mt-1 text-xs space-y-0.5">
                    <div>Destination: <code className="font-mono">{result.destDir}</code></div>
                    <div>Public upstream port: <span className="font-mono">{result.port}</span></div>
                    {result.proxy && result.proxy.length > 0 && (
                      <div>
                        Domains wired:
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {result.proxy.map((p) => (
                            <span key={p.envKey} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/60 border border-emerald-300 text-emerald-900 font-mono text-[11px]">
                              {p.domain}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    {result.portMap && Object.keys(result.portMap).length > 0 && (
                      <div>
                        Port remap (source → new):
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {Object.entries(result.portMap).map(([src, dst]) => (
                            <span key={src} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/60 border border-emerald-300 text-emerald-900 font-mono text-[11px]">
                              {src} → {dst}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <pre className="rounded-xl border border-gray-200 bg-gray-900 text-green-200 p-3 text-[11px] leading-snug font-mono whitespace-pre-wrap break-all max-h-72 overflow-y-auto">
                {result.log || '(no output)'}
              </pre>

              {result.ok && result.dest && (
                <div className="flex items-center gap-2 pt-1">
                  <Link
                    to={`/projects/${encodeURIComponent(result.dest)}`}
                    onClick={onClose}
                    className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-semibold uppercase tracking-wide"
                  >
                    Open {result.dest}
                  </Link>
                  <button onClick={onClose} className="text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900">
                    Close
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {info && !result && (
          <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
            <button onClick={onClose} className="text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900 px-3 py-2">
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={submitting || !dest}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-semibold uppercase tracking-wide transition-colors disabled:opacity-50"
            >
              {submitting ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} strokeWidth={2.5} />}
              Clone &amp; wire proxy
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-700 mb-1">{label}</label>
      {children}
      {hint && <p className="text-[11px] text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}
