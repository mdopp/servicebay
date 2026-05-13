'use client';

/**
 * Auto-update window — Settings → System.
 *
 * Pure form over PUT /api/system/update-window. ServiceBay manages
 * three independent restart sources (Zincati OS reboots,
 * podman-auto-update for container images, the ServiceBay app
 * updater). Until the operator opts into a window, every source is
 * locked: see lib/updateWindow.ts:applyLocks. Saving an enabled
 * window unlocks whichever sources `applyTo` opts in to; the rest
 * stay locked so a half-configured window can't fire half the
 * restarts at random times.
 *
 * Times are UTC throughout — that matches Zincati's config format
 * and systemd OnCalendar=, and we surface the timezone in the label
 * so operators don't get surprised by "03:00 UTC" at local-time
 * noon.
 */

import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Loader2, Lock } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

type Day = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

interface ApplyTo {
  os: boolean;
  containers: boolean;
  servicebay: boolean;
}

interface WindowConfig {
  enabled: boolean;
  days: Day[];
  startTime: string;
  lengthMinutes: number;
  applyTo: ApplyTo;
}

const ORDERED_DAYS: Day[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const DEFAULT_WINDOW: WindowConfig = {
  enabled: false,
  days: ['Sat', 'Sun'],
  startTime: '03:00',
  lengthMinutes: 120,
  applyTo: { os: true, containers: true, servicebay: false },
};

function lengthHumanised(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (remainder === 0) return `${hours} h`;
  return `${hours} h ${remainder} min`;
}

interface ApplyToCheckboxProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}

function ApplyToCheckbox({ label, description, checked, onChange, disabled }: ApplyToCheckboxProps) {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer select-none p-2 rounded-md hover:bg-gray-50 dark:hover:bg-gray-900/40">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-amber-600 focus:ring-amber-500"
      />
      <span className="text-sm text-gray-700 dark:text-gray-200">
        {label}
        <span className="block text-xs text-gray-500 dark:text-gray-400 leading-snug">{description}</span>
      </span>
    </label>
  );
}

export default function UpdateWindowSection() {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [window, setWindow] = useState<WindowConfig>(DEFAULT_WINDOW);
  const [error, setError] = useState<string | null>(null);
  const [serverHasValue, setServerHasValue] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/system/update-window');
        if (!res.ok) return;
        const data = await res.json() as { window: Partial<WindowConfig> | null };
        if (cancelled) return;
        if (data.window) {
          setServerHasValue(true);
          setWindow({
            ...DEFAULT_WINDOW,
            ...data.window,
            applyTo: { ...DEFAULT_WINDOW.applyTo, ...(data.window.applyTo ?? {}) },
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const sortedDays = useMemo(
    () => [...window.days].sort((a, b) => ORDERED_DAYS.indexOf(a) - ORDERED_DAYS.indexOf(b)),
    [window.days],
  );

  const toggleDay = (day: Day) => {
    setWindow(w => ({
      ...w,
      days: w.days.includes(day) ? w.days.filter(d => d !== day) : [...w.days, day],
    }));
  };

  const setApplyTo = (key: keyof ApplyTo, next: boolean) => {
    setWindow(w => ({ ...w, applyTo: { ...w.applyTo, [key]: next } }));
  };

  const handleSave = async () => {
    if (window.enabled && window.days.length === 0) {
      setError('Pick at least one day for the maintenance window.');
      return;
    }
    if (window.enabled && !window.applyTo.os && !window.applyTo.containers && !window.applyTo.servicebay) {
      setError('Pick at least one source to apply the window to (OS, containers, or ServiceBay).');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/system/update-window', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...window, days: sortedDays }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (data as { error?: string }).error || `HTTP ${res.status}`;
        setError(msg);
        addToast('error', 'Save failed', msg);
        return;
      }
      setServerHasValue(true);
      addToast('success', 'Update window saved', window.enabled
        ? `${sortedDays.join(', ')} ${window.startTime} UTC (+${lengthHumanised(window.lengthMinutes)})`
        : 'Auto-updates locked — nothing will restart on its own.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Network error';
      setError(msg);
      addToast('error', 'Save failed', msg);
    } finally {
      setSaving(false);
    }
  };

  const lockedNotice = !serverHasValue || !window.enabled;
  const groupDisabled = saving || !window.enabled;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-amber-100 dark:bg-amber-900/30 rounded-lg text-amber-600 dark:text-amber-400">
          <CalendarClock size={20} />
        </div>
        <div className="min-w-0">
          <h3 className="font-bold text-gray-900 dark:text-white">Auto-update window</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Decide when ServiceBay applies OS updates, container image refreshes, and its own updates. Until you save an enabled window, all auto-updates are locked.
          </p>
        </div>
      </div>

      <div className="p-6 space-y-5">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
            <Loader2 size={14} className="animate-spin" /> Loading current setting…
          </div>
        ) : (
          <>
            {lockedNotice && (
              <div className="p-3 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-900/20 flex items-start gap-2.5">
                <Lock size={16} className="mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
                <div className="text-xs text-amber-800 dark:text-amber-200 leading-snug">
                  <strong>Auto-updates are currently locked.</strong>{' '}
                  Fedora CoreOS will not reboot for OS updates and container images will not auto-refresh until you save an enabled window below. Manual updates (Settings → Updates → Check now) are unaffected.
                </div>
              </div>
            )}

            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={window.enabled}
                onChange={e => setWindow(w => ({ ...w, enabled: e.target.checked }))}
                disabled={saving}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-amber-600 focus:ring-amber-500"
              />
              <span className="text-sm text-gray-700 dark:text-gray-200">
                Allow auto-updates inside a maintenance window
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  When off, every auto-update source stays locked.
                </span>
              </span>
            </label>

            <div className={`space-y-4 ${groupDisabled ? 'opacity-50 pointer-events-none' : ''}`}>
              <div>
                <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1.5">Days (UTC)</span>
                <div className="flex flex-wrap gap-2">
                  {ORDERED_DAYS.map(day => {
                    const on = window.days.includes(day);
                    return (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleDay(day)}
                        disabled={saving}
                        className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
                          on
                            ? 'bg-amber-100 dark:bg-amber-900/30 border-amber-500 text-amber-800 dark:text-amber-200'
                            : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
                        }`}
                      >
                        {day}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className="block">
                  <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1.5">Start (UTC)</span>
                  <input
                    type="time"
                    step={300}
                    value={window.startTime}
                    onChange={e => setWindow(w => ({ ...w, startTime: e.target.value }))}
                    disabled={saving}
                    className="w-full p-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-amber-500 outline-none text-sm"
                  />
                </label>
                <label className="block">
                  <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1.5">
                    Length: <span className="font-mono">{lengthHumanised(window.lengthMinutes)}</span>
                  </span>
                  <input
                    type="range"
                    min={30}
                    max={480}
                    step={30}
                    value={window.lengthMinutes}
                    onChange={e => setWindow(w => ({ ...w, lengthMinutes: parseInt(e.target.value, 10) }))}
                    disabled={saving}
                    className="w-full accent-amber-600"
                  />
                  <div className="flex justify-between text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                    <span>30 min</span>
                    <span>8 h</span>
                  </div>
                </label>
              </div>

              <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1.5">Apply window to</span>
                <div className="space-y-0.5">
                  <ApplyToCheckbox
                    label="Fedora CoreOS reboots (Zincati)"
                    description="Holds the host reboot until inside the window. Image download still happens any time."
                    checked={window.applyTo.os}
                    onChange={v => setApplyTo('os', v)}
                    disabled={saving}
                  />
                  <ApplyToCheckbox
                    label="Container image updates (podman-auto-update)"
                    description="Constrains the daily timer that refreshes each service's container image."
                    checked={window.applyTo.containers}
                    onChange={v => setApplyTo('containers', v)}
                    disabled={saving}
                  />
                  <ApplyToCheckbox
                    label="ServiceBay app updates"
                    description="Reserved for future auto-apply. Today ServiceBay only notifies; you still apply manually from Settings → Updates."
                    checked={window.applyTo.servicebay}
                    onChange={v => setApplyTo('servicebay', v)}
                    disabled={saving}
                  />
                </div>
              </div>
            </div>

            {error && (
              <div className="p-2 rounded-md bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-900 text-xs text-rose-700 dark:text-rose-200">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {window.enabled
                  ? sortedDays.length > 0
                    ? <>Window: <span className="font-mono">{sortedDays.join(', ')}</span> at <span className="font-mono">{window.startTime} UTC</span> ({lengthHumanised(window.lengthMinutes)}).</>
                    : <>Pick at least one day to enable the window.</>
                  : <>Auto-updates locked. Manual updates still work.</>}
              </p>
              <button
                onClick={handleSave}
                disabled={saving || loading || (window.enabled && window.days.length === 0)}
                className="shrink-0 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors text-sm font-medium inline-flex items-center gap-2"
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                {saving ? 'Saving…' : 'Save & apply'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
