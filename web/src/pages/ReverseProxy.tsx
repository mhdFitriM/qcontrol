import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck, AlertTriangle, RotateCw } from 'lucide-react';
import { api } from '../lib/api';

type Tab = 'env' | 'caddy';

export function ReverseProxy() {
  const [tab, setTab] = useState<Tab>('env');
  const [env, setEnv] = useState<string>('');
  const [caddy, setCaddy] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState<null | 'env' | 'caddy'>(null);
  const [validating, setValidating] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [recreating, setRecreating] = useState(false);
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
    setValidating(true);
    try {
      await api.post<{ ok: boolean; log: string }>('/revproxy/validate');
      flash('ok', 'Caddy config is valid');
    } catch (e: any) {
      flash('err', e?.body?.log || 'Caddy validation failed');
    } finally { setValidating(false); }
  }

  async function reload() {
    setReloading(true);
    try {
      await api.post<{ ok: boolean; log: string }>('/revproxy/reload');
      flash('ok', 'Caddy reloaded — new config is live');
    } catch (e: any) {
      flash('err', e?.body?.log || 'Reload failed (config kept previous version)');
    } finally { setReloading(false); }
  }

  async function recreate() {
    setRecreating(true);
    try {
      await api.post<{ ok: boolean; log: string }>('/revproxy/recreate');
      flash('ok', 'Caddy container recreated — new .env vars are now live');
    } catch (e: any) {
      flash('err', e?.body?.log || 'Recreate failed');
    } finally { setRecreating(false); }
  }

  if (!loaded) {
    return <div className="py-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-gray-400" /></div>;
  }

  return (
    <div className="p-5 sm:p-8 max-w-5xl">
      <header className="mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">Reverse proxy</h1>
        <p className="mt-1 text-sm text-gray-500">
          Edit <code className="text-xs">/opt/reverse-proxy/.env</code> and <code className="text-xs">Caddyfile</code>, validate, then reload Caddy in place.
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
            disabled={validating}
            title="Run `caddy validate` inside the running container — no side-effects."
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 bg-white text-xs font-semibold uppercase tracking-wide text-gray-700 hover:border-gray-900 transition-colors disabled:opacity-50"
          >
            {validating ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} strokeWidth={2.5} />}
            Validate
          </button>
          <button
            onClick={reload}
            disabled={reloading}
            title="Validate, then `caddy reload` — zero downtime, picks up Caddyfile edits."
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-semibold uppercase tracking-wide transition-colors disabled:opacity-50"
          >
            {reloading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} strokeWidth={2.5} />}
            Validate &amp; reload Caddy
          </button>
          <button
            onClick={recreate}
            disabled={recreating}
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
