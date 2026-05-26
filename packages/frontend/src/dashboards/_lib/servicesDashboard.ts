/**
 * Type + helper extraction from ServicesDashboard.tsx (#961, step 1).
 *
 * Lifts the pure data shapes, constants, and stateless helpers out
 * of the 2,029-LOC monolith so the dashboard component itself drops
 * a little weight and the contract surface is reviewable in
 * isolation. The inner `ServiceCard` / `BundleCard` React components
 * and the form-modal state machines stay in-component for now — the
 * issue flags the high-risk render-cycle work and we don't take that
 * on without per-stage validation.
 */
import type { BundleValidation, ServiceBundle } from '@servicebay/api-client';

/**
 * Synthesized migration plan returned by `/api/system/bundles/[name]/plan` —
 * the dry-run output the merge wizard's Stack + Backup steps render
 * before the operator commits the merge.
 */
export interface MigrationPlan {
  filesToCreate: string[];
  filesToBackup: string[];
  servicesToStop: string[];
  targetName: string;
  backupDir: string;
  backupArchive?: string;
  stackPreview?: string;
  validations?: BundleValidation[];
  fileMappings?: Array<{ source: string; action: 'backup' | 'migrate'; target?: string }>;
}

/** External-link form state shared by the create + edit flows. */
export type LinkFormState = {
  name: string;
  url: string;
  description: string;
  monitor: boolean;
  ipTargetsText?: string;
};

/** Steps of the bundle-merge wizard. The order is the visual progression
 *  in the modal; the `key` is the controlled state value the
 *  dashboard's `bundleWizardStep` toggles between. */
export const bundleWizardSteps: Array<{
  key: 'assets' | 'stack' | 'backup';
  label: string;
  description: string;
  tooltip: string;
}> = [
  {
    key: 'assets',
    label: 'Assets',
    description: 'Review linked services, files, and containers',
    tooltip: 'Verify every unmanaged unit, container, and config before generating the managed stack. See the Merge Workflow guide for full context.',
  },
  {
    key: 'stack',
    label: 'Stack',
    description: 'Validate the generated pod stack',
    tooltip: 'Inspect the synthesized .kube unit, Pod YAML, and config references before dry-running the plan.',
  },
  {
    key: 'backup',
    label: 'Backup Plan',
    description: 'Confirm backups and execution plan',
    tooltip: 'Dry run podman kube play, review tar/gzip backups, and note rollback instructions prior to executing the merge.',
  },
];

/** Collapse duplicate validation entries — the bundle API can emit the
 *  same finding multiple times when several scopes pick it up. Stable
 *  on first-write so the rendered order matches API order. */
export function dedupeValidations(entries: BundleValidation[]): BundleValidation[] {
  const map = new Map<string, BundleValidation>();
  entries.forEach(entry => {
    const key = `${entry.level}-${entry.scope || 'global'}-${entry.message}`;
    if (!map.has(key)) {
      map.set(key, entry);
    }
  });
  return Array.from(map.values());
}

/** Border-color tailwind classes per bundle severity. The card body
 *  reuses these so a row's outline matches its severity icon. */
export const bundleSeverityClasses: Record<ServiceBundle['severity'], string> = {
  critical: 'border-red-200 dark:border-red-800',
  warning: 'border-amber-200 dark:border-amber-800',
  info: 'border-gray-200 dark:border-gray-800',
};

export const MERGE_HELP_ID = 'merge-wizard';

/** Raw shape the external-links API returns, before it's mapped into
 *  the `ServiceViewModel` the dashboard renders. Tolerant on every
 *  optional field — older entries pre-date some of the columns. */
export type ApiLinkPayload = {
  id?: string;
  name: string;
  nodeName?: string;
  description?: string;
  active?: boolean;
  status?: string;
  activeState?: string;
  subState?: string;
  kubePath?: string;
  yamlPath?: string | null;
  type?: string;
  ports?: RawLinkPort[];
  volumes?: RawLinkVolume[];
  monitor?: boolean;
  url?: string;
  labels?: Record<string, string>;
  verifiedDomains?: string[];
  ipTargets?: string[];
};

export type RawLinkPort = {
  host?: string | number;
  hostPort?: string | number;
  container?: string | number;
  containerPort?: string | number;
  hostIp?: string;
  protocol?: string;
  source?: string;
};

export type RawLinkVolume = {
  host?: string;
  container?: string;
};
