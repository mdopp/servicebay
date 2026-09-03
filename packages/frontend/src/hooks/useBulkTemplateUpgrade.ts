'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchNodes } from '@servicebay/api-client';
import { useStackInstall, type UseStackInstallReturn } from '@/hooks/useStackInstall';

/**
 * State machine behind the collective template upgrade (#2602):
 * `select` (which services are behind) → `preview` (what a run would do) →
 * `running` (one install job, reported by the shared install-progress surface).
 *
 * It lives apart from the component for one reason worth stating: the step the
 * bug hides in is the handoff from *plan* to *run*. `startConfigure` resolves
 * the manifest and returns it; the controller's own `items` are still the
 * pre-configure state in that same tick. Starting the job off the controller
 * would post an empty item list and produce a job that finishes having deployed
 * nothing — the failure shape #2601 was filed for. `run()` therefore hands the
 * RESOLVED manifest straight to `runInstall`.
 */

export interface UpgradeSummary {
  name: string;
  installedVersion: number;
  currentVersion: number;
  hasBreakingChange: boolean;
  sectionHeaders: string[];
}

interface PlannedMigration {
  filename: string;
  fromVersion: number;
  toVersion: number;
}

export interface PlanEntry extends UpgradeSummary {
  dependencies: string[];
  tier: string;
  migrations: PlannedMigration[];
  excludedReason?: string;
}

export interface BulkUpgradePlan {
  order: PlanEntry[];
  excluded: PlanEntry[];
  satisfiers: string[];
  hasBreakingChange: boolean;
}

type BulkUpgradeStep = 'select' | 'preview' | 'running';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The list of services behind their shipped template version, and the
 *  operator's selection over it. */
function usePendingUpgrades(onError: (msg: string) => void) {
  const [pending, setPending] = useState<UpgradeSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/system/templates/upgrades-pending');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { pending?: UpgradeSummary[] };
      const list = data.pending ?? [];
      setPending(list);
      // Breaking upgrades start UNchecked. A bulk action must not opt anybody
      // into a breaking migration by being the convenient button; the operator
      // can still select them deliberately.
      setSelected(new Set(list.filter(p => !p.hasBreakingChange).map(p => p.name)));
    } catch (e) {
      setPending([]);
      onError(`Could not read pending template upgrades: ${message(e)}`);
    }
  }, [onError]);

  const toggle = useCallback((name: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  return { pending, selected, setSelected, reload, toggle };
}

/** The preview: what a run over `names` would deploy, in what order. */
function useUpgradePlan(onError: (msg: string) => void) {
  const [plan, setPlan] = useState<BulkUpgradePlan | null>(null);
  const [planning, setPlanning] = useState(false);

  const build = useCallback(async (names: string[]): Promise<boolean> => {
    setPlanning(true);
    try {
      const res = await fetch('/api/system/templates/bulk-upgrade-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ names }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPlan(await res.json() as BulkUpgradePlan);
      return true;
    } catch (e) {
      onError(`Could not build the upgrade plan: ${message(e)}`);
      return false;
    } finally {
      setPlanning(false);
    }
  }, [onError]);

  return { plan, planning, build, clear: useCallback(() => setPlan(null), []) };
}

/** The node to deploy to, when the box has exactly one — same rule the
 *  installer modal uses. Multi-node boxes fall through to the runner's
 *  default. */
function useSingleNode(): string | undefined {
  const [node, setNode] = useState<string | undefined>(undefined);
  useEffect(() => {
    fetchNodes().then(ns => { if (ns.length === 1) setNode(ns[0].Name); }).catch(() => undefined);
  }, []);
  return node;
}

export interface BulkTemplateUpgradeState {
  controller: UseStackInstallReturn;
  step: BulkUpgradeStep;
  error: string | null;
  pending: UpgradeSummary[] | null;
  selected: Set<string>;
  plan: BulkUpgradePlan | null;
  planning: boolean;
  acknowledged: boolean;
  setAcknowledged: (v: boolean) => void;
  toggle: (name: string) => void;
  selectAll: () => void;
  selectNone: () => void;
  preview: () => void;
  backToSelect: () => void;
  restart: () => void;
  run: () => void;
}

export function useBulkTemplateUpgrade(): BulkTemplateUpgradeState {
  const controller = useStackInstall({ templateSource: '', source: 'bulk-upgrade' });
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<BulkUpgradeStep>('select');
  const [acknowledged, setAcknowledged] = useState(false);
  const onError = useCallback((msg: string) => setError(msg), []);
  const list = usePendingUpgrades(onError);
  const planner = useUpgradePlan(onError);
  const node = useSingleNode();

  useEffect(() => {
    void list.reload();
  }, [list.reload]);  // eslint-disable-line react-hooks/exhaustive-deps

  const preview = useCallback(() => {
    setError(null);
    setAcknowledged(false);
    void planner.build([...list.selected]).then(ok => { if (ok) setStep('preview'); });
  }, [planner, list.selected]);

  const run = useCallback(() => {
    const plan = planner.plan;
    if (!plan) return;
    setStep('running');
    void (async () => {
      const items = [
        ...plan.order.map(e => ({ name: e.name, checked: true })),
        ...plan.satisfiers.map(name => ({ name, checked: false, alreadyInstalled: true })),
      ];
      const resolved = await controller.startConfigure(items, {}, { node });
      if (resolved.items.length === 0) return; // startConfigure surfaced its own error
      await controller.runInstall({ node, items: resolved.items, variables: resolved.variables });
    })();
  }, [planner.plan, controller, node]);

  const restart = useCallback(() => {
    controller.reset();
    planner.clear();
    setStep('select');
    void list.reload();
  }, [controller, planner, list]);

  return {
    controller, step, error, planning: planner.planning, plan: planner.plan,
    pending: list.pending, selected: list.selected, toggle: list.toggle,
    acknowledged, setAcknowledged,
    selectAll: () => list.setSelected(new Set((list.pending ?? []).map(p => p.name))),
    selectNone: () => list.setSelected(new Set()),
    preview, run, restart,
    backToSelect: () => setStep('select'),
  };
}
