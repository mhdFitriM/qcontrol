import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Loader2, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useEffect } from 'react';

export function Login() {
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyAuthed, setAlreadyAuthed] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<{ authed: boolean }>('/auth/whoami')
      .then((r) => setAlreadyAuthed(r.authed))
      .catch(() => {});
  }, []);

  if (alreadyAuthed) return <Navigate to="/" replace />;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/auth/login', { token });
      navigate('/', { replace: true });
    } catch (e: any) {
      setError(e?.body?.error || 'Invalid token');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4">
        <div className="text-center mb-6">
          <div className="w-12 h-12 mx-auto rounded-lg bg-gray-900 text-white flex items-center justify-center">
            <ShieldCheck size={22} strokeWidth={2.25} />
          </div>
          <h1 className="mt-4 text-xl font-bold tracking-tight text-gray-900">qcontrol</h1>
          <p className="mt-1 text-sm text-gray-500">Enter the admin token to continue.</p>
        </div>
        <div>
          <label htmlFor="token" className="block text-xs font-semibold uppercase tracking-wide text-gray-700 mb-1.5">
            Admin token
          </label>
          <input
            id="token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
            autoComplete="current-password"
            className="w-full h-11 px-3 bg-white border border-gray-300 rounded-lg text-sm focus:outline-none focus:border-gray-900 transition-colors"
            placeholder="Paste your QCONTROL_TOKEN"
          />
        </div>
        {error && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}
        <button
          type="submit"
          disabled={!token || submitting}
          className="w-full h-11 inline-flex items-center justify-center gap-2 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-sm font-semibold uppercase tracking-wide transition-colors disabled:opacity-50"
        >
          {submitting && <Loader2 size={16} className="animate-spin" />}
          Sign in
        </button>
      </form>
    </div>
  );
}
