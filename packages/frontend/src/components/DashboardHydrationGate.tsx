'use client';

import { useEffect, useMemo, useReducer, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

/**
 * Dashboard hydration progress (#737). The `containers` / `services`
 * pages previously sat on a single "Connecting to Agent…" spinner for
 * however long the digital-twin first-broadcast took (often 8–20 s on
 * a cold start). Operators couldn't tell whether the page was making
 * progress, wedged, or simply slow.
 *
 * This component renders the three phases of the load explicitly:
 *   1. Socket — the WebSocket transport is connecting / connected.
 *   2. Sync   — the agent's initial inventory broadcast.
 *   3. Render — first dataset received, page is about to swap to data.
 *
 * Plus the elapsed-seconds counter (so the operator can compare against
 * their expectation of "fast" vs "stuck") and an escalation hint once
 * the load takes > 10 s in the same phase. After 25 s we surface a
 * direct pointer to Settings → Nodes / diagnose instead of leaving the
 * operator to guess.
 *
 * The component is purely presentational — gating logic stays in the
 * dashboard so each page can choose which phase corresponds to its
 * own data prerequisites.
 */

export type HydrationPhase = 'socket' | 'sync' | 'render';

interface PhaseRow {
  id: HydrationPhase;
  label: string;
  description: string;
}

const PHASES: PhaseRow[] = [
  {
    id: 'socket',
    label: 'Connecting to ServiceBay',
    description: 'Opening the realtime channel that streams agent state.',
  },
  {
    id: 'sync',
    label: 'Synchronising agent state',
    description: 'The agent is enumerating containers, services and ports.',
  },
  {
    id: 'render',
    label: 'Rendering',
    description: 'Receiving the first dataset and laying out the page.',
  },
];

const SLOW_HINT_AFTER_MS = 10_000;
const TROUBLESHOOT_AFTER_MS = 25_000;
const TICK_INTERVAL_MS = 500;

export interface DashboardHydrationGateProps {
  /** Which phase is currently active. Done phases render with a check. */
  phase: HydrationPhase;
  /** Optional sub-message shown under the phase title. */
  subMessage?: string;
}

export default function DashboardHydrationGate({ phase, subMessage }: DashboardHydrationGateProps) {
  // Use a tick counter as the only React state. Multiply by interval to
  // derive elapsed-ms — no Date.now() during render. The phase-start
  // tick is captured in an effect so swapping phases resets the slow
  // hint without touching state mid-render.
  const [tick, bumpTick] = useReducer((t: number) => t + 1, 0);
  const [phaseStartTick, setPhaseStartTick] = useState(0);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- captures phase-start tick on phase swap (see #1921); intentional post-render sync
    setPhaseStartTick(tick);
    // Intentional: capture the tick we were on when this phase took
    // effect. Re-running this on `tick` changes would defeat the
    // reset — we only want it on `phase` swap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    const id = setInterval(bumpTick, TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const elapsedMs = (tick - phaseStartTick) * TICK_INTERVAL_MS;
  const elapsedSec = Math.floor(elapsedMs / 1000);
  const showSlowHint = elapsedMs >= SLOW_HINT_AFTER_MS;
  const showTroubleshoot = elapsedMs >= TROUBLESHOOT_AFTER_MS;

  const phaseIndex = useMemo(() => PHASES.findIndex(p => p.id === phase), [phase]);
  const current = PHASES[phaseIndex] ?? PHASES[0];

  return (
    <div className="flex-1 flex flex-col items-center justify-center text-gray-500 dark:text-gray-400 h-full min-h-[300px] px-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <Loader2 className="animate-spin inline-block mb-3 text-blue-500" size={28} />
          <p className="font-medium text-gray-700 dark:text-gray-200">
            {current.label}
            <span className="ml-2 text-sm font-normal text-gray-400 tabular-nums">{elapsedSec}s</span>
          </p>
          <p className="text-sm text-gray-400 mt-1">{subMessage ?? current.description}</p>
        </div>

        <ol className="space-y-2" aria-label="Hydration progress">
          {PHASES.map((p, idx) => {
            const done = idx < phaseIndex;
            const active = idx === phaseIndex;
            return (
              <li
                key={p.id}
                className={[
                  'flex items-start gap-3 p-2 rounded',
                  active ? 'bg-blue-50 dark:bg-blue-900/20' : '',
                ].join(' ')}
                aria-current={active ? 'step' : undefined}
              >
                <span
                  className={[
                    'mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold shrink-0',
                    done ? 'bg-green-500 text-white' : '',
                    active ? 'bg-blue-500 text-white' : '',
                    !done && !active ? 'bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400' : '',
                  ].join(' ')}
                >
                  {done ? <Check size={12} /> : idx + 1}
                </span>
                <span className="flex-1">
                  <span
                    className={[
                      'block text-sm',
                      active ? 'text-blue-700 dark:text-blue-300 font-medium' : '',
                      done ? 'text-gray-600 dark:text-gray-300' : '',
                      !done && !active ? 'text-gray-500 dark:text-gray-400' : '',
                    ].join(' ')}
                  >
                    {p.label}
                  </span>
                  {active && (
                    <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {p.description}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>

        {showSlowHint && !showTroubleshoot && (
          <p className="mt-4 text-xs text-gray-500 dark:text-gray-400 text-center">
            Taking a little longer than usual &mdash; first-time syncs on a cold cache can run 15&ndash;20 s.
          </p>
        )}
        {showTroubleshoot && (
          <div className="mt-4 text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 rounded p-3 text-center">
            Still on this phase after {elapsedSec}s. The agent may not have completed its first inventory pass &mdash;
            check <a href="/diagnose" className="underline">Diagnose</a> or
            restart the node from <a href="/settings/network-domain#nodes" className="underline">Settings &rarr; Nodes</a>.
          </div>
        )}
      </div>
    </div>
  );
}
