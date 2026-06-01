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
import type { ServiceBundle } from '@servicebay/api-client';

/** External-link form state shared by the create + edit flows. */
export type LinkFormState = {
  name: string;
  url: string;
  description: string;
  monitor: boolean;
  ipTargetsText?: string;
};

/** Border-color tailwind classes per bundle severity. The card body
 *  reuses these so a row's outline matches its severity icon. */
export const bundleSeverityClasses: Record<ServiceBundle['severity'], string> = {
  critical: 'border-red-200 dark:border-red-800',
  warning: 'border-amber-200 dark:border-amber-800',
  info: 'border-gray-200 dark:border-gray-800',
};

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
