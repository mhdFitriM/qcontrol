import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Copy, KeyRound, Loader2, ShieldAlert, X } from 'lucide-react';
import { api } from '../lib/api';

interface SshPubKey { filename: string; content: string; }

function DeployKeyDisclosure() {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<SshPubKey[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function load() {
    try {
      const r = await api.get<{ data: SshPubKey[]; error?: string }>('/host/ssh-public-keys');
      if (r.error) setErr(r.error);
      setKeys(r.data);
    } catch (e: any) {
      setErr(e?.body?.message || e.message || 'Failed to load keys');
    }
  }

  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (next && !keys && !err) void load();
      return next;
    });
  }

  async function copyKey(content: string) {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(content);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* ignore */ }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={toggle}
        className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-amber-900 hover:text-amber-700 transition-colors"
      >
        <ChevronDown size={11} strokeWidth={2.5} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        Show this VPS's deploy public key
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {!keys && !err && (
            <div className="text-[11px] text-amber-800 inline-flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" /> Loading…
            </div>
          )}
          {err && <div className="text-[11px] text-red-700">{err}</div>}
          {keys && keys.length === 0 && (
            <div className="text-[11px] text-amber-800">
              No <code className="font-mono">.pub</code> files in <code className="font-mono">/root/.ssh</code> on this VPS. SSH into the host and run:
              <pre className="mt-1 bg-amber-100/60 rounded px-2 py-1.5 font-mono text-[10px]">ssh-keygen -t ed25519 -C "{`<vps-name>-deploy`}" -f ~/.ssh/id_ed25519 -N ""</pre>
            </div>
          )}
          {keys && keys.length > 0 && (
            <>
              <p className="text-[10px] text-amber-900">
                Paste this into GitHub: repo → Settings → Deploy keys → <strong>Add deploy key</strong>. Read access is enough for <code className="font-mono">git pull</code>.
              </p>
              {keys.map((k) => (
                <div key={k.filename} className="rounded-lg border border-amber-300 bg-white overflow-hidden">
                  <div className="flex items-center justify-between gap-2 px-2.5 py-1 border-b border-amber-100 bg-amber-50">
                    <span className="text-[10px] font-mono text-amber-900 truncate">{k.filename}</span>
                    <button
                      type="button"
                      onClick={() => copyKey(k.content)}
                      className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-amber-900 hover:text-amber-700 transition-colors"
                    >
                      {copied === k.content ? <Check size={10} strokeWidth={2.5} /> : <Copy size={10} strokeWidth={2.5} />}
                      {copied === k.content ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <pre className="px-2.5 py-2 font-mono text-[10px] text-gray-800 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
                    {k.content}
                  </pre>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Generic "type to confirm" gate for any destructive or non-trivial action.
 *
 * - Optionally pre-fetches a "plan" from `/api/projects/:name/plan` so we
 *   can show the user the exact compose files + project name + git remote
 *   that the action will operate on. Catches "you're about to push prod
 *   under the wrong project name" before it happens.
 * - Disables the confirm button until the user types "confirm" exactly.
 * - Optional `danger` flag flips the confirm button red.
 */
export interface ActionPlan {
  project: string;
  dir: string;
  composeFiles: string[];
  projectName: string | null;
  git: {
    hasGit: boolean;
    remoteUrl: string | null;
    isSshRemote: boolean;
    isPrivateLikely: boolean;
  };
}

export function ConfirmActionModal({
  title, description, project, fetchPlan, needsGit, danger, confirmLabel, onConfirm, onClose,
}: {
  title: string;
  description: string;
  project?: string;       // when set, the modal fetches /api/projects/:name/plan
  fetchPlan?: boolean;    // turns plan fetching on/off (defaults true if project is set)
  needsGit?: boolean;     // surface a stronger warning if the project has no git remote (pull won't work)
  danger?: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [planErr, setPlanErr] = useState<string | null>(null);
  const ready = typed.trim().toLowerCase() === 'confirm';
  const shouldFetch = (fetchPlan ?? true) && !!project;

  useEffect(() => {
    if (!shouldFetch) return;
    api.get<ActionPlan>(`/projects/${encodeURIComponent(project!)}/plan`)
      .then(setPlan)
      .catch((e) => setPlanErr(e?.body?.message || e.message || 'Plan fetch failed'));
  }, [project, shouldFetch]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-white rounded-2xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
      >
        <header className="px-5 py-4 border-b border-gray-200 flex items-center gap-3">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 text-white ${danger ? 'bg-red-600' : 'bg-gray-900'}`}>
            {danger ? <ShieldAlert size={18} strokeWidth={2.5} /> : <AlertTriangle size={18} strokeWidth={2.5} />}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold tracking-tight text-gray-900 truncate">{title}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{description}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500 flex-shrink-0">
            <X size={18} strokeWidth={2.25} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          {shouldFetch && !plan && !planErr && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500 inline-flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" /> Loading action plan…
            </div>
          )}
          {planErr && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{planErr}</div>
          )}

          {plan && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[11px] text-gray-700 space-y-1.5 font-mono">
              <div><span className="text-gray-500">project   </span><span className="text-gray-900 font-semibold">{plan.project}</span></div>
              <div><span className="text-gray-500">dir       </span>{plan.dir}</div>
              <div>
                <span className="text-gray-500">compose   </span>
                {plan.composeFiles.map((f, i) => (
                  <span key={i}>{i > 0 && ', '}<span className="text-gray-900">{f}</span></span>
                ))}
              </div>
              <div>
                <span className="text-gray-500">project_name </span>
                {plan.projectName
                  ? <span className="text-gray-900">{plan.projectName}</span>
                  : <span className="text-gray-400 italic">(auto from dir)</span>}
              </div>
              {plan.git.hasGit && (
                <div>
                  <span className="text-gray-500">git       </span>
                  <span className="text-gray-900">{plan.git.remoteUrl || '(no remote)'}</span>
                </div>
              )}
            </div>
          )}

          {plan && needsGit && plan.git.isPrivateLikely && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[11px] text-amber-900">
              <div className="flex gap-2">
                <KeyRound size={14} strokeWidth={2.5} className="flex-shrink-0 mt-0.5" />
                <div>
                  <strong>Private repo (SSH remote).</strong> qcontrol will use this VPS's SSH keys from <code className="font-mono">/root/.ssh</code>.
                  If <code className="font-mono">git pull</code> fails with <em>Permission denied</em>, you need to add this VPS's public key as a <strong>Deploy Key</strong> on the GitHub repo (Settings → Deploy keys → Add).
                </div>
              </div>
              <DeployKeyDisclosure />
            </div>
          )}

          {plan && needsGit && !plan.git.hasGit && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-[11px] text-red-800">
              <strong>No git repo found in this directory.</strong> The pull step will be skipped — the build will run against whatever is already on disk.
            </div>
          )}

          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-700 mb-1">
              Type <span className="font-mono">confirm</span> to proceed
            </label>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ready) onConfirm(); }}
              spellCheck={false}
              className={`w-full h-10 px-3 border rounded-lg text-sm font-mono focus:outline-none transition-colors ${
                ready ? 'border-emerald-500' : 'border-gray-300 focus:border-gray-900'
              }`}
            />
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-900 px-3 py-2">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!ready}
            className={`inline-flex items-center gap-2 h-10 px-4 rounded-lg text-white text-xs font-semibold uppercase tracking-wide transition-colors disabled:opacity-40 ${
              danger ? 'bg-red-600 hover:bg-red-700' : 'bg-gray-900 hover:bg-gray-800'
            }`}
          >
            {confirmLabel || 'Proceed'}
          </button>
        </footer>
      </div>
    </div>
  );
}
