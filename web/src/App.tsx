import { Navigate, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Boxes, Globe, LogOut, ServerCog } from 'lucide-react';
import { api } from './lib/api';
import { Login } from './pages/Login';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { ReverseProxy } from './pages/ReverseProxy';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Shell /></RequireAuth>}>
        <Route index element={<Navigate to="/projects" replace />} />
        <Route path="projects" element={<Projects />} />
        <Route path="projects/:name" element={<ProjectDetail />} />
        <Route path="revproxy" element={<ReverseProxy />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'loading' | 'ok' | 'denied'>('loading');
  useEffect(() => {
    api.get<{ authed: boolean }>('/auth/whoami')
      .then((r) => setState(r.authed ? 'ok' : 'denied'))
      .catch(() => setState('denied'));
  }, []);
  if (state === 'loading') return <div className="h-screen flex items-center justify-center text-sm text-gray-400">…</div>;
  if (state === 'denied') return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Shell() {
  const navigate = useNavigate();
  async function logout() {
    await api.post('/auth/logout').catch(() => {});
    navigate('/login', { replace: true });
  }
  return (
    <div className="min-h-screen flex">
      <aside className="hidden md:flex flex-col w-60 bg-gray-950 text-white">
        <div className="px-5 h-14 flex items-center gap-2.5 border-b border-white/10">
          <div className="w-8 h-8 rounded-md bg-white text-gray-900 flex items-center justify-center">
            <ServerCog size={18} strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-sm font-bold tracking-tight">qcontrol</div>
            <div className="text-[10px] text-white/40 uppercase tracking-widest">VPS panel</div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          <NavItem to="/projects" icon={Boxes} label="Projects" />
          <NavItem to="/revproxy" icon={Globe} label="Reverse proxy" />
        </nav>
        <div className="p-3 border-t border-white/10">
          <button
            onClick={logout}
            className="w-full flex items-center gap-3 px-3 h-10 rounded-lg text-sm font-medium text-white/60 hover:bg-white/5 hover:text-white transition-colors"
          >
            <LogOut size={16} strokeWidth={2.25} /> Log out
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 bg-gray-50">
        <Routed />
      </main>
    </div>
  );
}

function NavItem({ to, icon: Icon, label }: { to: string; icon: any; label: string }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 h-10 rounded-lg text-sm font-medium transition-colors ${
          isActive ? 'bg-white text-gray-900' : 'text-white/70 hover:bg-white/5 hover:text-white'
        }`
      }
    >
      <Icon size={16} strokeWidth={2.25} />
      {label}
    </NavLink>
  );
}

function Routed() {
  // Renders the child routes inside the Shell. The nested router fits
  // because RequireAuth is on the parent and the child routes do their
  // own content layout.
  return <Outlet />;
}
