import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck, AlertTriangle, RotateCw, ShieldAlert, X, Square } from 'lucide-react';
import { api } from '../lib/api';

type Tab = 'env' | 'caddy';

/**
 * The reverse-proxy is the ONE piece of infra that, if misconfigured or
 * bounced at the wrong moment, takes every domain on the VPS offline
 * simultaneously. Every side-effect button on this page therefore routes
 * through a "type confirm" modal — same pattern ProjectDetail uses for
 * Pull + Rebuild / Down.
 *
 * Save writes to disk only (no confirmation needed — nothing is applied
 * until you hit one of the apply buttons).
 */

type ApplyAction =
  | { kind: 'reload'; label: 'Validate & reload Caddy' }
  | { kind: 'recreate'; label: 'Apply .env changes (recreate Caddy)' }
  | { kind: 'stop'; label: 'Stop Caddy (takes ALL sites offline)' };

export function ReverseProxy() {
  const [tab, setTab] = useState<Tab>('env');
  const [env, setEnv] = useState<string>('');
  const [caddy, setCaddy] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState<null | 'env' | 'caddy'>(null);
  const [validating, setValidating] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [recreating, setRecreating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [pending, setPending] = useState<ApplyAction | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setEnv(await api.text('/revproxy/env'));
        setCaddy(await api.text('/revproxy/caddyfile'));
      } catch (e: any) {
        setToast({ kind: 'err', text: e.message || 'Load failed' });
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  function flash(kind: 'ok' | 'err', text: string) {
    setToast({ kind, text });
    setTimeout(() => setToast(null), 5000);
  }

  async function save(which: 'env' | 'caddy') {
    setSaving(which);
    try {
      const path = which === 'env' ? '/revproxy/env' : '/revproxy/caddyfile';
      await api.put(path, { content: which === 'env' ? env : caddy });
      flash('ok', which === 'env' ? '.env saved' : 'Caddyfile saved');
    } catch (e: any) {
      flash('err', e?.body?.message || e.message || 'Save failed');
    } finally { setSaving(null); }
  }

  async function validate() {
    // Validation is read-only — no confirmation needed.
    setValidating(true);
    try {
      await api.post<{ ok: boolean; log: string }>('/revproxy/validate');
      flash('ok', 'Caddy config is valid');
    } catch (e: any) {
      flash('err', e?.body?.log || 'Caddy validation failed');
    } finally { setValidating(false); }
  }

  async function runReload() {
    setReloading(true);
    try {
      await api.post<{ ok: boolean; log: string }>('/revproxy/reload');
      flash('ok', 'Caddy reloaded — new config is live');
    } catch (e: any) {
      flash('err', e?.body?.log || 'Reload failed (config kept previous version)');
    } finally { setReloading(false); setPending(null); }
  }

  async function runRecreate() {
    setRecreating(true);
    try {
      await api.post<{ ok: boolean; log: string }>('/revproxy/recreate');
      flash('ok', 'Caddy container recreated — new .env vars are now live');
    } catch (e: any) {
      flash('err', e?.body?.log || 'Recreate failed');
    } finally { setRecreating(false); setPending(null); }
  }

  async function runStop() {
    setStopping(true);
    try {
      await api.post<{ ok: boolean; log: string }>('/revproxy/stop');
      flash('ok', 'Caddy stopped — every domain on this VPS is offline until you bring it back up.');
    } catch (e: any) {
      flash('err', e?.body?.log || 'Stop failed');
    } finally { setStopping(false); setPending(null); }
  }

  function confirm(action: ApplyAction) {
    if (action.kind === 'reload') void runReload();
    else if (action.kind === 'recreate') void runRecreate();
    else if (action.kind === 'stop') void runStop();
  }

  if (!loaded) {
    return <div className="py-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-gray-400" /></div>;
  }

  const anyBusy = reloading || recreating || stopping || validating;

  return (
    <div className="p-5 sm:p-8 max-w-5xl">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Reverse proxy</h1>
        <p className="mt-1 text-sm text-gray-500">
          Edit <code className="text-xs">/opt/reverse-proxy/.env</code> and <code className="text-xs">Caddyfile</code>, validate, then reload Caddy in place.
        </p>
        <p className="mt-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 inline-flex items-start gap-2 max-w-3xl">
          <AlertTriangle size={13} strokeWidth={2.5} className="flex-shrink-0 mt-0.5" />
          <span>
            This one container fronts <strong>every domain on this VPS</strong>. A broken Caddyfile or a mistimed
            recreate takes every site down at once. Save first, validate, then apply — never skip validate.
          </span>
        </p>
      </header>

      <div className="flex items-center gap-2 mb-4">
        <div className="inline-flex bg-gray-100 rounded-lg p-1 gap-1">
          {([['env', '.env'], ['caddy', 'Caddyfile']] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k as Tab)}
              className={`h-9 px-3 rounded-md text-xs font-bold uppercase tracking-wide transition-colors ${
                tab === k ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <button
            onClick={validate}
            disabled={anyBusy}
            title="Run `caddy validate` inside the running container — no side-effects."
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 bg-white text-xs font-semibold uppercase tracking-wide text-gray-700 hover:border-gray-900 transition-colors disabled:opacity-50"
          >
            {validating ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} strokeWidth={2.5} />}
            Validate
          </button>
          <button
            onClick={() => setPending({ kind: 'reload', label: 'Validate & reload Caddy' })}
            disabled={anyBusy}
            title="Validate, then `caddy reload` — zero downtime, picks up Caddyfile edits."
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-semibold uppercase tracking-wide transition-colors disabled:opacity-50"
          >
            {reloading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} strokeWidth={2.5} />}
            Validate &amp; reload Caddy
          </button>
          <button
            onClick={() => setPending({ kind: 'recreate', label: 'Apply .env changes (recreate Caddy)' })}
            disabled={anyBusy}
            title="Recreate the Caddy container so new .env vars take effect. ~1s of downtime. Required after adding new *_DOMAIN / *_UPSTREAM pairs."
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border-2 border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-semibold uppercase tracking-wide transition-colors disabled:opacity-50"
          >
            {recreating ? <Loader2 size={13} className="animate-spin" /> : <RotateCw size={13} strokeWidth={2.5} />}
            Apply .env changes (recreate Caddy)
          </button>
        </div>
      </div>

      {toast && (
        <div className={`mb-3 rounded-lg border px-3 py-2 text-xs whitespace-pre-wrap font-mono ${
          toast.kind === 'ok'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : 'border-red-200 bg-red-50 text-red-700'
        }`}>
          <span className="inline-flex items-center gap-1.5 font-bold uppercase tracking-wide not-italic">
            {toast.kind === 'ok' ? <CheckCircle2 size={12} strokeWidth={2.5} /> : <AlertTriangle size={12} strokeWidth={2.5} />}
            {toast.kind === 'ok' ? 'Success' : 'Error'}
          </span>
          <div className="mt-1">{toast.text}</div>
        </div>
      )}

      {tab === 'env' ? (
        <Editor
          value={env}
          onChange={setEnv}
          onSave={() => save('env')}
          saving={saving === 'env'}
          placeholder="MYAPP_DOMAIN=myapp.example.com&#10;MYAPP_UPSTREAM=127.0.0.1:8086"
        />
      ) : (
        <Editor
          value={caddy}
          onChange={setCaddy}
          onSave={() => save('caddy')}
          saving={saving === 'caddy'}
          placeholder=":80, {$MYAPP_DOMAIN} { reverse_proxy {$MYAPP_UPSTREAM} }"
        />
      )}

      {/* Danger zone — same visual treatment as ProjectDetail's Remove-project block. */}
      <section className="mt-8">
        <h2 className="text-xs font-bold uppercase tracking-widest text-red-700 mb-2">Danger zone</h2>
        <div className="rounded-xl border border-red-200 bg-red-50/50 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-xs text-red-900">
            <div className="font-semibold">Stop the Caddy container</div>
            <div className="mt-0.5 text-red-700">
              Kills the reverse-proxy — <strong>every domain on this VPS returns 502 immediately</strong>. Only useful
              during a hardware migration or when you need to free 80/443 for a one-off test. Bring it back with
              <code className="mx-1 font-mono">cd /opt/reverse-proxy &amp;&amp; docker compose up -d</code> on the host.
            </div>
          </div>
          <button
            onClick={() => setPending({ kind: 'stop', label: 'Stop Caddy (takes ALL sites offline)' })}
            disabled={anyBusy}
            className="inline-flex items-center gap-1.5 h-10 px-4 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold uppercase tracking-wide transition-colors flex-shrink-0 disabled:opacity-50"
          >
            <Square size={14} strokeWidth={2.5} fill="currentColor" />
            Stop Caddy
          </button>
        </div>
      </section>

      {pending && (
        <RevproxyConfirmModal
          action={pending}
          onClose={() => setPending(null)}
          onConfirm={() => confirm(pending)}
        />
      )}
    </div>
  );
}

/**
 * Reverse-proxy specific confirmation modal — modeled on the project-level
 * ConfirmActionModal but tailored to Caddy actions (no per-project git plan
 * fetch; instead an inline explanation of what each action does + risk).
 */
function RevproxyConfirmModal({
  action, onClose, onConfirm,
}: {
  action: ApplyAction;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const ready = typed.trim().toLowerCase() === 'confirm';
  const danger = action.kind === 'stop';

  const summary = action.kind === 'reload'
    ? {
        heading: 'Zero-downtime reload',
        blurb: 'Runs `caddy validate` first, then `caddy reload`. Existing connections stay open; only picks up Caddyfile edits (not new .env vars).',
        risks: [
          'If validation fails, the OLD config keeps serving — safe.',
          'A syntactically valid but semantically broken block (wrong upstream, typo\'d domain) will drop traffic for that ONE site until you fix it.',
        ],
      }
    : action.kind === 'recreate'
    ? {
        heading: '~1 second of downtime, then live',
        blurb: 'Stops the Caddy container and re-creates it so new *_DOMAIN / *_UPSTREAM env vars are picked up. Required after adding a new project.',
        risks: [
          'ALL domains 502 for ~1 second while the container restarts.',
          'If .env has a syntax error, the container may fail to start — every site stays down until fixed.',
          'Certificates persist (Caddy stores them in the caddy_data volume), so no re-issue.',
        ],
      }
    : {
        heading: 'DESTRUCTIVE — takes every site offline',
        blurb: 'Runs `docker compose stop caddy`. Caddy stops accepting connections; every domain on this VPS returns 502 until you bring the container back with `docker compose up -d`.',
        risks: [
          '100% of traffic to every domain on this VPS is refused.',
          'Certificates are safe (stored in the caddy_data volume) — they will not need re-issuance on restart.',
          'You cannot bring Caddy back from qcontrol\'s UI — SSH in and run docker compose up -d.',
        ],
      };

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
            <h2 className="text-base font-bold tracking-tight text-gray-900 truncate">{action.label}</h2>
            <p className="text-xs text-gray-500 mt-0.5">Reverse proxy — {summary.heading}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-lg hover:bg-gray-100 inline-flex items-center justify-center text-gray-500 flex-shrink-0">
            <X size={18} strokeWidth={2.25} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <p className="text-xs text-gray-700 leading-relaxed">{summary.blurb}</p>

          <div className={`rounded-lg border px-3 py-2.5 ${danger ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
            <div className={`text-[11px] font-bold uppercase tracking-wide ${danger ? 'text-red-900' : 'text-amber-900'} mb-1.5`}>
              What can go wrong
            </div>
            <ul className={`text-[11px] leading-relaxed space-y-1 list-disc list-inside ${danger ? 'text-red-800' : 'text-amber-900'}`}>
              {summary.risks.map((r) => <li key={r}>{r}</li>)}
            </ul>
          </div>

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
            {action.label}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Editor({
  value, onChange, onSave, saving, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  saving: boolean;
  placeholder: string;
}) {
  return (
    <div className="space-y-3">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        placeholder={placeholder}
        className="w-full h-[60vh] min-h-[400px] p-4 rounded-xl border border-gray-300 bg-gray-900 text-green-200 font-mono text-xs leading-snug focus:outline-none focus:border-gray-900"
      />
      <button
        onClick={onSave}
        disabled={saving}
        className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-semibold uppercase tracking-wide transition-colors disabled:opacity-50"
      >
        {saving && <Loader2 size={14} className="animate-spin" />}
        Save (no reload)
      </button>
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Save writes to disk only. Then apply with one of the buttons above —
        <strong> Validate &amp; reload Caddy</strong> for Caddyfile-only edits (zero downtime),
        or <strong>Apply .env changes (recreate Caddy)</strong> when you've added a new <code>*_DOMAIN</code> / <code>*_UPSTREAM</code> pair (~1s of downtime — required because Caddy reads <code>{`{$VAR}`}</code> env references only at container startup).
      </p>
    </div>
  );
}
