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
import type { ServiceBundle, ServiceViewModel, StackManifest } from '@servicebay/api-client';

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

// ---------------------------------------------------------------------------
// Stack grouping (#2081)
// ---------------------------------------------------------------------------
//
// The /services overview groups its lean per-service rows under the stack that
// owns them. Stack membership is derived from each stack manifest's `templates`
// list (from GET /api/system/stacks): a service whose base name (sans
// `.service`) matches a template name belongs to that stack. Services with no
// owning stack (gateways, external links, ad-hoc Quadlets) fall into the
// synthetic "ungrouped" bucket so nothing is dropped from the view.

/** Summary entry returned by GET /api/system/stacks (manifest may be null for
 *  README-only stacks; we only group on manifests that name templates). */
export interface StackSummaryLite {
  name: string;
  manifest: StackManifest | null;
}

/** Synthetic bucket id for services not owned by any stack. */
export const UNGROUPED_STACK_ID = '__ungrouped__';

/** A stack and the services rendered beneath its header. */
export interface ServiceStackGroup {
  /** Stack name (matches the wipe endpoint path segment), or UNGROUPED_STACK_ID. */
  id: string;
  /** Display label — manifest.label when present, else the stack name. */
  label: string;
  /** Manifest for the owning stack, or null for the ungrouped bucket. */
  manifest: StackManifest | null;
  /** Whether this group can be wiped via the scoped per-stack wipe endpoint.
   *  False for the ungrouped bucket and for core / atomic-wipe stacks. */
  wipeable: boolean;
  services: ServiceViewModel[];
}

/** Normalise a service or template name to a comparable base (drop `.service`). */
export function baseUnitName(name: string): string {
  return name.replace(/\.service$/, '');
}

/**
 * Group services under their owning stack.
 *
 * Pure: takes the live service list + the stack summaries, returns ordered
 * groups (core stacks first — they sort ahead in the API response, preserved
 * here — then feature stacks, then the ungrouped bucket last). Empty stacks
 * (no installed services) are omitted so the overview only shows headers that
 * actually have rows under them.
 */
export function groupServicesByStack(
  services: ServiceViewModel[],
  stacks: StackSummaryLite[],
): ServiceStackGroup[] {
  // template base name -> owning stack manifest. First writer wins; the API
  // already de-dupes stack names, and a template should belong to one stack.
  const templateToStack = new Map<string, StackSummaryLite>();
  for (const stack of stacks) {
    for (const template of stack.manifest?.templates ?? []) {
      const key = baseUnitName(template);
      if (!templateToStack.has(key)) templateToStack.set(key, stack);
    }
  }

  const groups = new Map<string, ServiceStackGroup>();
  const order: string[] = [];

  const ensureGroup = (stack: StackSummaryLite | null): ServiceStackGroup => {
    const id = stack ? stack.name : UNGROUPED_STACK_ID;
    let group = groups.get(id);
    if (!group) {
      const manifest = stack?.manifest ?? null;
      group = {
        id,
        label: manifest?.label || (stack ? stack.name : 'Ungrouped'),
        manifest,
        // Only feature stacks with a wipeable lifecycle expose the wipe action.
        // Core stacks and atomic-wipe stacks are blocked at the UI (and the
        // backend hard-refuses them anyway). The ungrouped bucket is never
        // wipeable — it has no single stack to scope a wipe to.
        wipeable: Boolean(manifest) && manifest!.lifecycle === 'wipeable' && manifest!.tier !== 'core',
        services: [],
      };
      groups.set(id, group);
      order.push(id);
    }
    return group;
  };

  for (const service of services) {
    const owner = templateToStack.get(baseUnitName(service.name)) ?? null;
    ensureGroup(owner).services.push(service);
  }

  // Stack groups in the API-provided order (core first), ungrouped always last.
  return order
    .filter(id => id !== UNGROUPED_STACK_ID)
    .map(id => groups.get(id)!)
    .concat(groups.has(UNGROUPED_STACK_ID) ? [groups.get(UNGROUPED_STACK_ID)!] : []);
}
