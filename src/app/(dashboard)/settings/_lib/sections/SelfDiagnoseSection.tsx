'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, Stethoscope } from 'lucide-react';
import DiagnoseProbeList, {
  type DiagnoseProbe,
  type ProbeStatus,
} from '@/components/DiagnoseProbeList';
import { useSocket } from '@/hooks/useSocket';

interface DiagnoseResult {
  node: string;
  probes: DiagnoseProbe[];
}

const STATUS_META: Record<ProbeStatus, { color: string; bg: string; Icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  ok: { color: 'text-emerald-700 dark:text-emerald-300', bg: 'bg-emerald-50 dark:bg-emerald-900/20', Icon: CheckCircle2 },
  warn: { color: 'text-amber-700 dark:text-amber-300', bg: 'bg-amber-50 dark:bg-amber-900/20', Icon: AlertTriangle },
  fail: { color: 'text-red-700 dark:text-red-300', bg: 'bg-red-50 dark:bg-red-900/20', Icon: AlertCircle },
  info: { color: 'text-blue-700 dark:text-blue-300', bg: 'bg-blue-50 dark:bg-blue-900/20', Icon: Info },
};

export default function SelfDiagnoseSection() {
  const [result, setResult] = useState<DiagnoseResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { socket } = useSocket();
  // Keep `result` accessible to the socket-driven auto-refresh effect
  // without re-binding it on every state change (which would tear down
  // and re-establish the socket listener each render).
  const hasResultRef = useRef(false);
  hasResultRef.current = result !== null;

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/system/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setResult(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, []);

  // Phase 3a (#484): live-update the diagnose panel when underlying
  // health-check results change. The server emits `health:update`
  // every time a check ticks; we debounce 1 s so a burst (e.g. boot
  // when many checks fire at once) coalesces into a single re-run.
  // No-op until the operator has clicked "Run self-test" at least
  // once — there's no point eagerly running the suite for someone
  // who isn't looking at it.
  useEffect(() => {
    if (!socket) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = () => {
      if (!hasResultRef.current) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void run(); }, 1000);
    };
    socket.on('health:update', onUpdate);
    return () => {
      socket.off('health:update', onUpdate);
      if (timer) clearTimeout(timer);
    };
  }, [socket, run]);

  const counts = result ? result.probes.reduce<Record<ProbeStatus, number>>(
    (a, p) => ({ ...a, [p.status]: (a[p.status] || 0) + 1 }),
    { ok: 0, warn: 0, fail: 0, info: 0 },
  ) : null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-violet-100 dark:bg-violet-900/30 rounded-lg text-violet-600 dark:text-violet-400">
          <Stethoscope size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-gray-900 dark:text-white">Self-Test</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Runs a battery of probes on the local node and reports container engine, pods, failed units, USB sticks, storage, and first-boot status.
          </p>
        </div>
        <button
          onClick={run}
          disabled={running}
          className="shrink-0 inline-flex items-center gap-2 px-4 py-2 bg-violet-600 text-white text-sm font-medium rounded-lg hover:bg-violet-700 disabled:opacity-50 transition-colors"
        >
          {running ? <Loader2 size={16} className="animate-spin" /> : <Stethoscope size={16} />}
          {running ? 'Running…' : result ? 'Run again' : 'Run self-test'}
        </button>
      </div>

      <div className="p-6 space-y-3">
        {error && (
          <div className="p-3 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-sm text-red-800 dark:text-red-200">
            {error}
          </div>
        )}

        {!result && !error && !running && (
          <p className="text-sm text-gray-500 dark:text-gray-400 italic">
            Click &quot;Run self-test&quot; to probe this node. Useful when something doesn&apos;t behave as expected — surfaces the most common gotchas (agent not reachable, pod failing, /mnt/data not mounted, USB stick not detected).
          </p>
        )}

        {counts && (
          <div className="flex items-center gap-3 text-sm">
            {(['ok', 'warn', 'fail', 'info'] as ProbeStatus[]).map(s => {
              const meta = STATUS_META[s];
              const n = counts[s];
              if (!n) return null;
              const Icon = meta.Icon;
              return (
                <span key={s} className={`inline-flex items-center gap-1 px-2 py-1 rounded ${meta.bg} ${meta.color} font-medium`}>
                  <Icon size={14} /> {n} {s}
                </span>
              );
            })}
            <span className="text-xs text-gray-500 dark:text-gray-400 ml-auto">node: {result?.node}</span>
          </div>
        )}

        {result && (
          <DiagnoseProbeList
            probes={result.probes}
            node={result.node}
            onRefresh={run}
            parentRunning={running}
          />
        )}
      </div>
    </div>
  );
}
