/**
 * sessionStorage-backed persistence for OnboardingWizard.tsx (#978).
 *
 * The wizard checkpoints its state on every change so an accidental
 * tab-close or page reload doesn't lose the operator's progress
 * (host / user / email config / step history / selection).
 * Passwords are deliberately never persisted — see the wizard's
 * setState declarations for which fields are excluded.
 *
 * Extracted from OnboardingWizard.tsx in #978's first step. Pure
 * module — no React, no DOM beyond `window.sessionStorage`, so it
 * imports trivially from anywhere. The wizard re-exports the
 * types it cares about so existing call sites keep working.
 */

/** Top-level wizard step. Single source of truth for the step union;
 *  the wizard component imports this. */
export type WizardStep = 'welcome' | 'network' | 'email' | 'install-confirm' | 'stacks' | 'finish';

/** Stacks-step sub-stage. `select` and `services` are wizard-specific
 *  UIs (stack picker + per-service dependency resolution); the shared
 *  engine takes over from `flow` onwards. */
export type StackSubStep = 'select' | 'services' | 'flow';

/** History entry the wizard's Back button walks. The `subStep` field
 *  (#691) lets the back-walk restore both the outer step AND the
 *  inner stacks substep in one pop — drops the special-case
 *  substep-rewind logic that used to live in handleBack. */
export interface StepHistoryEntry {
  step: WizardStep;
  subStep: StackSubStep;
}

export interface PersistedWizardState {
  currentStep: WizardStep;
  /** Allow both shapes on load; we normalize to StepHistoryEntry[]
   *  before the React state ever sees it. Keep `unknown` here so
   *  historical sessions don't blow up the JSON.parse. */
  stepHistory: StepHistoryEntry[] | WizardStep[];
  subStep?: StackSubStep;
  selection: {
    gateway: boolean;
    ssh: boolean;
    updates: boolean;
    registries: boolean;
    email: boolean;
    stacks: boolean;
  };
  gwHost: string;
  gwUser: string;
  emailHost: string;
  emailPort: number;
  emailSecure: boolean;
  emailUser: string;
  emailFrom: string;
  emailRecipients: string;
}

export const WIZARD_STATE_KEY = 'sb.onboarding.v1';

/** Migrate legacy bare-WizardStep entries to {step, subStep:'select'}
 *  so a partially-completed wizard from a pre-#691 session keeps
 *  working. Worst-case the operator walks back into the picker
 *  instead of restoring a sub-state; that's strictly better than
 *  crashing when the back button is clicked. */
export function normalizeStepHistory(
  raw: PersistedWizardState['stepHistory'] | undefined,
): StepHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(entry => {
    if (typeof entry === 'string') {
      return { step: entry, subStep: 'select' };
    }
    return entry;
  });
}

export function loadPersistedWizardState(): PersistedWizardState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(WIZARD_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedWizardState;
  } catch {
    return null;
  }
}

export function clearPersistedWizardState(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(WIZARD_STATE_KEY);
  } catch { /* noop */ }
}

export function savePersistedWizardState(state: PersistedWizardState): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(WIZARD_STATE_KEY, JSON.stringify(state));
  } catch { /* quota — non-fatal, the wizard just loses checkpoint coverage */ }
}
