/**
 * Lifecycle phase detection for the launcher TUI (#1231).
 *
 * Pure logic: it takes injected probes (is an ISO built? is the box up? is the
 * setup wizard finished?) and derives which phase the operator is in and which
 * menu actions are relevant. Keeping the network/fs probes out of here makes
 * the whole decision tree unit-testable. The real probes live in probes.ts.
 */

export type LifecyclePhase =
  | 'no-iso' // nothing built yet — start by baking an install ISO
  | 'iso-ready' // ISO built, box not reachable — boot the USB then watch
  | 'installing' // box reachable but setup/install still in progress
  | 'ready'; // box up and the setup wizard is complete

export interface BoxStatus {
  reachable: boolean;
  wizardDone: boolean;
}

export interface PhaseProbes {
  isoBuilt: () => Promise<boolean>;
  boxStatus: () => Promise<BoxStatus>;
}

export interface PhaseState {
  phase: LifecyclePhase;
  isoBuilt: boolean;
  boxReachable: boolean;
  wizardDone: boolean;
}

export async function detectPhase(probes: PhaseProbes): Promise<PhaseState> {
  const [isoBuilt, status] = await Promise.all([probes.isoBuilt(), probes.boxStatus()]);
  const { reachable, wizardDone } = status;
  const phase: LifecyclePhase = reachable
    ? wizardDone
      ? 'ready'
      : 'installing'
    : isoBuilt
      ? 'iso-ready'
      : 'no-iso';
  return { phase, isoBuilt, boxReachable: reachable, wizardDone };
}

export type MenuActionId = 'build-iso' | 'watch-install' | 'refresh' | 'quit';

export interface MenuAction {
  id: MenuActionId;
  label: string;
}

/** The actions offered for a given phase. Runtime actions (edit config, restore
 *  backups, install stacks) are deferred to later #1231 sub-issues — this shell
 *  only wraps the ISO build and the install-watch handoff. */
export function actionsForPhase(state: PhaseState): MenuAction[] {
  const actions: MenuAction[] = [];
  if (!state.boxReachable) {
    actions.push({
      id: 'build-iso',
      label: state.isoBuilt ? 'Rebuild install ISO + flash USB' : 'Build install ISO + flash USB',
    });
    if (state.isoBuilt) {
      actions.push({ id: 'watch-install', label: 'Boot the USB, then watch the install' });
    }
  } else if (state.phase === 'installing') {
    actions.push({ id: 'watch-install', label: 'Watch install progress' });
  } else {
    actions.push({ id: 'watch-install', label: 'Watch a reinstall' });
  }
  actions.push({ id: 'refresh', label: 'Refresh status' });
  actions.push({ id: 'quit', label: 'Quit' });
  return actions;
}

export function describePhase(state: PhaseState): string {
  switch (state.phase) {
    case 'no-iso':
      return 'No install ISO built yet — start by baking one.';
    case 'iso-ready':
      return 'Install ISO is ready. Boot the box from the USB, then watch the install.';
    case 'installing':
      return 'Box is reachable; an install or setup is still in progress.';
    case 'ready':
      return 'Box is up and the setup wizard is complete.';
  }
}
