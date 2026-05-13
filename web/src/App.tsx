import { Navigate, NavLink, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { Activity, BookOpen, Boxes, Globe, LogOut, Menu, ServerCog, X } from 'lucide-react';
import { api } from './lib/api';
import { Login } from './pages/Login';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { ReverseProxy } from './pages/ReverseProxy';
import { VpsHealth } from './pages/VpsHealth';
import { DocsIndex, DocsProject } from './pages/Docs';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Shell /></RequireAuth>}>
        <Route index element={<Navigate to="/projects" replace />} />
        <Route path="vps" element={<VpsHealth />} />
        <Route path="projects" element={<Projects />} />
        <Route path="projects/:name" element={<ProjectDetail />} />
        <Route path="revproxy" element={<ReverseProxy />} />
        <Route path="docs" element={<DocsIndex />} />
        <Route path="docs/:slug" element={<DocsProject />} />
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

/**
 * Responsive shell:
 *   - desktop (md+): persistent left sidebar (60px / w-60), main content fills the rest
 *   - mobile (<md):  sticky top bar with hamburger + brand; tapping hamburger
 *                    opens a left-side drawer with the same nav. Drawer auto-
 *                    closes when the user navigates, so they don't have to
 *                    fish for the X button after every tap.
 */
function Shell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close drawer whenever the route changes (NavLink tap, browser back, etc).
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

  async function logout() {
    await api.post('/auth/logout').catch(() => {});
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen flex bg-gray-50">
      {/* Mobile top bar — sticky, only visible <md */}
      <header className="md:hidden fixed top-0 left-0 right-0 z-30 h-14 bg-gray-950 text-white flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),0rem)]">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className="w-10 h-10 inline-flex items-center justify-center rounded-lg hover:bg-white/10"
        >
          <Menu size={20} strokeWidth={2.25} />
        </button>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-white text-gray-900 flex items-center justify-center">
            <ServerCog size={16} strokeWidth={2.5} />
          </div>
          <span className="text-sm font-bold tracking-tight">qcontrol</span>
        </div>
        <div className="w-10" aria-hidden />
      </header>

      {/* Desktop sidebar — persistent, only visible md+ */}
      <aside className="hidden md:flex flex-col w-60 bg-gray-950 text-white flex-shrink-0">
        <SidebarBrand />
        <SidebarNav onLogout={logout} />
      </aside>

      {/* Mobile drawer — slides in from the left when drawerOpen */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-40 flex">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <aside className="relative w-72 max-w-[85vw] h-full bg-gray-950 text-white flex flex-col shadow-2xl pt-[max(env(safe-area-inset-top),0rem)]">
            <div className="flex items-center justify-between pr-2">
              <SidebarBrand />
              <button
                onClick={() => setDrawerOpen(false)}
                aria-label="Close menu"
                className="w-10 h-10 inline-flex items-center justify-center rounded-lg hover:bg-white/10 text-white/80"
              >
                <X size={18} strokeWidth={2.25} />
              </button>
            </div>
            <SidebarNav onLogout={logout} />
          </aside>
        </div>
      )}

      {/* Main content — top padding on mobile to clear the sticky header */}
      <main className="flex-1 min-w-0 bg-gray-50 pt-14 md:pt-0 pb-[max(env(safe-area-inset-bottom),0rem)]">
        <Outlet />
      </main>
    </div>
  );
}

function SidebarBrand() {
  return (
    <div className="px-5 h-14 flex items-center gap-2.5 border-b border-white/10 flex-shrink-0">
      <div className="w-8 h-8 rounded-md bg-white text-gray-900 flex items-center justify-center">
        <ServerCog size={18} strokeWidth={2.5} />
      </div>
      <div>
        <div className="text-sm font-bold tracking-tight">qcontrol</div>
        <div className="text-[10px] text-white/40 uppercase tracking-widest">VPS panel</div>
      </div>
    </div>
  );
}

function SidebarNav({ onLogout }: { onLogout: () => void }) {
  return (
    <>
      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        <NavItem to="/vps" icon={Activity} label="VPS health" />
        <NavItem to="/projects" icon={Boxes} label="Projects" />
        <NavItem to="/revproxy" icon={Globe} label="Reverse proxy" />
        <NavItem to="/docs" icon={BookOpen} label="Docs" />
      </nav>
      <div className="p-3 border-t border-white/10 flex-shrink-0 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
        <button
          onClick={onLogout}
          className="w-full flex items-center gap-3 px-3 h-10 rounded-lg text-sm font-medium text-white/60 hover:bg-white/5 hover:text-white transition-colors"
        >
          <LogOut size={16} strokeWidth={2.25} /> Log out
        </button>
      </div>
    </>
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
