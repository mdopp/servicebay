'use client';

/**
 * OS Update Window — Settings → System.
 *
 * Pure form over POST /api/system/os-update-window. The backend
 * renders the chosen window into `/etc/zincati/config.d/55-…toml` and
 * restarts Zincati, so a successful save means the next OS update
 * will only reboot inside that window. Disabling falls back to
 * Zincati's `immediate` default (reboot whenever an update lands).
 *
 * Times are UTC throughout — that matches Zincati's config format,
 * and we surface the timezone in the label so operators don't get
 * surprised by an "03:00" reboot at local-time noon.
 */

import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Loader2 } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';

type Day = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

interface WindowConfig {
  enabled: boolean;
  days: Day[];
  startTime: string;
  lengthMinutes: number;
}

const ORDERED_DAYS: Day[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const DEFAULT_WINDOW: WindowConfig = {
  enabled: false,
  days: ['Sat', 'Sun'],
  startTime: '03:00',
  lengthMinutes: 120,
};

function lengthHumanised(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (remainder === 0) return `${hours} h`;
  return `${hours} h ${remainder} min`;
}

export default function OsUpdateWindowSection() {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [window, setWindow] = useState<WindowConfig>(DEFAULT_WINDOW);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/system/os-update-window');
        if (!res.ok) return;
        const data = await res.json() as { window: WindowConfig | null };
        if (!cancelled && data.window) setWindow(data.window);
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

  const handleSave = async () => {
    if (window.enabled && window.days.length === 0) {
      setError('Pick at least one day for the maintenance window.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch('/api/system/os-update-window', {
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
      addToast('success', 'OS update window saved', window.enabled
        ? `Reboots restricted to ${sortedDays.join(', ')} ${window.startTime} UTC (+${lengthHumanised(window.lengthMinutes)}).`
        : 'Window disabled — Zincati will reboot whenever updates land.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Network error';
      setError(msg);
      addToast('error', 'Save failed', msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden w-full">
      <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 flex items-center gap-3">
        <div className="p-2 bg-amber-100 dark:bg-amber-900/30 rounded-lg text-amber-600 dark:text-amber-400">
          <CalendarClock size={20} />
        </div>
        <div className="min-w-0">
          <h3 className="font-bold text-gray-900 dark:text-white">OS update window</h3>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Restrict when Fedora CoreOS reboots after an OS update. Image pulls still happen any time; only the reboot waits for this window. Times are UTC.
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
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={window.enabled}
                onChange={e => setWindow(w => ({ ...w, enabled: e.target.checked }))}
                disabled={saving}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 dark:border-gray-600 text-amber-600 focus:ring-amber-500"
              />
              <span className="text-sm text-gray-700 dark:text-gray-200">
                Restrict OS reboots to a maintenance window
                <span className="block text-xs text-gray-500 dark:text-gray-400">
                  When off, Zincati uses its default <code className="font-mono">immediate</code> strategy and may reboot any time an update lands.
                </span>
              </span>
            </label>

            <div className={`space-y-4 ${window.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
              <div>
                <span className="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1.5">Days</span>
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
                    ? <>Next reboot will wait for <span className="font-mono">{sortedDays.join(', ')}</span> at <span className="font-mono">{window.startTime} UTC</span> ({lengthHumanised(window.lengthMinutes)}).</>
                    : <>Pick at least one day to enable the window.</>
                  : <>Window disabled — reboots happen whenever the update lands.</>}
              </p>
              <button
                onClick={handleSave}
                disabled={saving || loading || (window.enabled && window.days.length === 0)}
                className="shrink-0 px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors text-sm font-medium inline-flex items-center gap-2"
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                {saving ? 'Saving…' : 'Save & restart Zincati'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
