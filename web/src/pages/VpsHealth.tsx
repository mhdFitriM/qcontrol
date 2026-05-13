import { useEffect, useRef, useState } from 'react';
import { Cpu, HardDrive, MemoryStick, RefreshCw, Server, Activity, Loader2 } from 'lucide-react';
import { api } from '../lib/api';

interface Health {
  hostname: string;
  os: string;
  uptimeSeconds: number;
  cpu: { count: number; usedPct: number | null; loadavg: number[] };
  memory: { totalBytes: number; usedBytes: number; availableBytes: number; usedPct: number };
  swap: { totalBytes: number; usedBytes: number; usedPct: number };
  disks: Array<{ mount: string; filesystem: string; sizeBytes: number; usedBytes: number; availBytes: number; usedPct: number }>;
  topProcesses: Array<{ pid: number; name: string; cmd: string; uid: number; state: string; rssBytes: number; cpuTicks: number }>;
}

interface ContainerStat { name: string; cpu: string; mem: string; memPct: string; netIO: string; blockIO: string; }

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function VpsHealth() {
  const [health, setHealth] = useState<Health | null>(null);
  const [stats, setStats] = useState<ContainerStat[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const timer = useRef<number | null>(null);

  async function load() {
    try {
      const [h, s] = await Promise.all([
        api.get<Health>('/vps/health'),
        api.get<{ data: ContainerStat[] }>('/vps/containers/stats').catch(() => ({ data: [] })),
      ]);
      setHealth(h);
      setStats(s.data);
      setErr(null);
    } catch (e: any) {
      setErr(e?.body?.message || e.message || 'Load failed');
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    timer.current = window.setInterval(() => { void load(); }, 5000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [autoRefresh]);

  return (
    <div className="p-5 sm:p-8 max-w-6xl">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">VPS health</h1>
          <p className="mt-1 text-sm text-gray-500">
            Live snapshot of host CPU, RAM, disk, and per-container resource usage.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <label className="inline-flex items-center gap-2 text-xs text-gray-600">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="accent-gray-900" />
            Auto-refresh (5s)
          </label>
          <button
            onClick={load}
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 bg-white text-xs font-semibold uppercase tracking-wide text-gray-700 hover:border-gray-900 transition-colors"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} strokeWidth={2.5} />}
            Refresh
          </button>
        </div>
      </header>

      {err && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 text-red-700 text-xs px-3 py-2">{err}</div>
      )}

      {!health && loading && (
        <div className="py-12 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-gray-400" /></div>
      )}

      {health && (
        <>
          {/* Host info strip */}
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
            <div className="inline-flex items-center gap-2 text-gray-700">
              <Server size={14} strokeWidth={2.25} className="text-gray-500" />
              <span className="font-mono font-semibold">{health.hostname || 'host'}</span>
            </div>
            {health.os && <div className="text-gray-500">{health.os}</div>}
            <div className="text-gray-500">Up <span className="text-gray-900 font-semibold">{fmtUptime(health.uptimeSeconds)}</span></div>
            <div className="text-gray-500">{health.cpu.count} CPU{health.cpu.count > 1 ? 's' : ''}</div>
          </div>

          {/* Stat tiles */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
            <StatTile
              icon={Cpu}
              label="CPU load"
              value={`${health.cpu.loadavg[0].toFixed(2)}`}
              sub={`1m / 5m / 15m: ${health.cpu.loadavg.map((n) => n.toFixed(2)).join(' / ')}`}
              pct={(health.cpu.loadavg[0] / Math.max(health.cpu.count, 1)) * 100}
            />
            <StatTile
              icon={MemoryStick}
              label="Memory"
              value={`${fmtBytes(health.memory.usedBytes)} / ${fmtBytes(health.memory.totalBytes)}`}
              sub={`${health.memory.usedPct.toFixed(1)}% used · ${fmtBytes(health.memory.availableBytes)} available`}
              pct={health.memory.usedPct}
            />
            <StatTile
              icon={Activity}
              label="Swap"
              value={health.swap.totalBytes ? `${fmtBytes(health.swap.usedBytes)} / ${fmtBytes(health.swap.totalBytes)}` : 'No swap'}
              sub={health.swap.totalBytes ? `${health.swap.usedPct.toFixed(1)}% used` : '—'}
              pct={health.swap.totalBytes ? health.swap.usedPct : 0}
            />
            <StatTile
              icon={HardDrive}
              label="Disk (/opt)"
              value={health.disks[0] ? `${fmtBytes(health.disks[0].usedBytes)} / ${fmtBytes(health.disks[0].sizeBytes)}` : 'N/A'}
              sub={health.disks[0] ? `${health.disks[0].usedPct}% used · ${fmtBytes(health.disks[0].availBytes)} free` : '—'}
              pct={health.disks[0]?.usedPct ?? 0}
            />
          </div>

          {/* Per-container stats */}
          <section className="mb-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-2">Containers ({stats.length})</h2>
            <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold">Name</th>
                      <th className="px-3 py-2 text-right font-semibold">CPU</th>
                      <th className="px-3 py-2 text-left font-semibold">Memory</th>
                      <th className="px-3 py-2 text-right font-semibold">Mem %</th>
                      <th className="px-3 py-2 text-left font-semibold hidden md:table-cell">Net I/O</th>
                      <th className="px-3 py-2 text-left font-semibold hidden md:table-cell">Block I/O</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-4 text-xs text-gray-500 text-center">No running containers</td></tr>
                    )}
                    {stats.map((c) => (
                      <tr key={c.name} className="border-t border-gray-100">
                        <td className="px-3 py-2 font-mono text-xs text-gray-900 truncate max-w-[200px]">{c.name}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-700 text-right tabular-nums">{c.cpu}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-700">{c.mem}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-700 text-right tabular-nums">{c.memPct}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-500 hidden md:table-cell">{c.netIO}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-500 hidden md:table-cell">{c.blockIO}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* Top host processes */}
          <section>
            <h2 className="text-sm font-semibold text-gray-900 mb-2">Top processes by memory</h2>
            <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[600px]">
                  <thead className="bg-gray-50 text-[10px] uppercase tracking-widest text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-right font-semibold w-16">PID</th>
                      <th className="px-3 py-2 text-left font-semibold w-40">Name</th>
                      <th className="px-3 py-2 text-right font-semibold w-24">RSS</th>
                      <th className="px-3 py-2 text-left font-semibold">Cmd</th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.topProcesses.length === 0 && (
                      <tr><td colSpan={4} className="px-3 py-4 text-xs text-gray-500 text-center">No process data (host /proc not mounted?)</td></tr>
                    )}
                    {health.topProcesses.map((p) => (
                      <tr key={p.pid} className="border-t border-gray-100">
                        <td className="px-3 py-2 font-mono text-xs text-gray-500 text-right tabular-nums">{p.pid}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-900 truncate">{p.name}</td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-700 text-right tabular-nums">{fmtBytes(p.rssBytes)}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-gray-500 truncate max-w-[400px]">{p.cmd}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function StatTile({
  icon: Icon, label, value, sub, pct,
}: { icon: any; label: string; value: string; sub: string; pct: number }) {
  const clampedPct = Math.max(0, Math.min(100, pct));
  const tone = clampedPct >= 90 ? 'bg-red-500' : clampedPct >= 75 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        <Icon size={13} strokeWidth={2.5} />
        {label}
      </div>
      <div className="mt-1.5 text-xl font-bold tracking-tight text-gray-900 font-mono tabular-nums">{value}</div>
      <div className="mt-0.5 text-[11px] text-gray-500">{sub}</div>
      <div className="mt-2.5 h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div className={`h-full ${tone} transition-all`} style={{ width: `${clampedPct}%` }} />
      </div>
    </div>
  );
}
