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

/** Synthetic group id for the infrastructure / core services (#2094):
 *  the gateway, the reverse proxy, the ServiceBay system service, and any
 *  core-tier (atomic-wipe) stack. These have no wipe button and used to fall
 *  into the Ungrouped bucket; they belong together under "Core services". */
export const CORE_STACK_ID = '__core__';

/** Is this an infrastructure / core service that belongs in the Core group?
 *  Detected from the view-model shape the backend already computes:
 *   - the gateway is `type === 'gateway'`;
 *   - the reverse proxy carries `labels['servicebay.role'] === 'reverse-proxy'`;
 *   - the ServiceBay system service carries `labels['servicebay.role'] === 'system'`.
 *  (See serviceViewModel.ts — `isReverseProxy` / `isServiceBay`.) */
export function isCoreInfraService(service: ServiceViewModel): boolean {
  if (service.type === 'gateway') return true;
  const role = service.labels?.['servicebay.role'];
  return role === 'reverse-proxy' || role === 'system';
}

/** Is this stack a core / atomic-wipe stack (e.g. basic/auth)? Its services
 *  fold into the Core group rather than rendering their own wipeable section. */
function isCoreStack(stack: StackSummaryLite | null): boolean {
  const manifest = stack?.manifest;
  if (!manifest) return false;
  return manifest.tier === 'core' || manifest.lifecycle === 'atomic-wipe';
}

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

/** Order the built groups: `firstId` group first, `lastId` group last, the rest
 *  in insertion order. Shared by the service + container groupers so both views
 *  read with the same Core-first / bucket-last optic. */
function orderGroups<G>(
  groups: Map<string, G>,
  order: string[],
  firstId: string,
  lastId: string,
): G[] {
  const first = groups.has(firstId) ? [groups.get(firstId)!] : [];
  const middle = order.filter(id => id !== firstId && id !== lastId).map(id => groups.get(id)!);
  const last = groups.has(lastId) ? [groups.get(lastId)!] : [];
  return first.concat(middle, last);
}

/** Build the template-base-name → owning-stack map. First writer wins; the API
 *  already de-dupes stack names, and a template should belong to one stack. */
function buildTemplateToStack(stacks: StackSummaryLite[]): Map<string, StackSummaryLite> {
  const map = new Map<string, StackSummaryLite>();
  for (const stack of stacks) {
    for (const template of stack.manifest?.templates ?? []) {
      const key = baseUnitName(template);
      if (!map.has(key)) map.set(key, stack);
    }
  }
  return map;
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
  const templateToStack = buildTemplateToStack(stacks);

  const groups = new Map<string, ServiceStackGroup>();
  const order: string[] = [];

  const ensureCoreGroup = (): ServiceStackGroup => {
    let group = groups.get(CORE_STACK_ID);
    if (!group) {
      group = {
        id: CORE_STACK_ID,
        label: 'Core services',
        manifest: null,
        // The Core group bundles the gateway, reverse proxy, system service and
        // the atomic-wipe core stacks — none of which expose a per-stack wipe.
        wipeable: false,
        services: [],
      };
      groups.set(CORE_STACK_ID, group);
      order.push(CORE_STACK_ID);
    }
    return group;
  };

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
    // Core services (#2094): the gateway / reverse proxy / system service, plus
    // any service owned by a core (atomic-wipe) stack, fold into one "Core
    // services" group instead of leaking into the Ungrouped bucket or rendering
    // a wipeless single-stack section.
    if (isCoreInfraService(service) || isCoreStack(owner)) {
      ensureCoreGroup().services.push(service);
      continue;
    }
    ensureGroup(owner).services.push(service);
  }

  // Core services first, stack groups in API order, ungrouped bucket last.
  return orderGroups(groups, order, CORE_STACK_ID, UNGROUPED_STACK_ID);
}

// ---------------------------------------------------------------------------
// Container grouping (#2095)
// ---------------------------------------------------------------------------
//
// Status→Containers used to be a flat table while /services is stack-grouped,
// so the two views read inconsistently. We bring containers into the SAME
// grouping language by reusing the template→stack map: each container resolves
// to its owning service (the parent service name from the twin), that service
// resolves to its stack, and the container lands in the matching stack group.
// Group names + ordering mirror groupServicesByStack (Core first, feature
// stacks next, an "Other containers" bucket last) so the optic lines up.

/** Generic shape the container grouper needs from a container row. */
export interface GroupableContainer {
  /** Base name of the owning service (`.service` stripped), if known. */
  serviceName?: string | null;
  /** Infrastructure / system container (pause/sidecar) — routes to Core. */
  isInfra?: boolean;
}

/** A stack group of containers, mirroring ServiceStackGroup's identity. */
export interface ContainerStackGroup<C> {
  id: string;
  label: string;
  containers: C[];
}

/** Synthetic group id for containers with no resolvable owning stack. */
export const OTHER_CONTAINERS_ID = '__other_containers__';

/**
 * Group containers under the same stack identity the /services view uses.
 *
 * Pure: takes the container list, an accessor for each container's groupable
 * fields, and the stack summaries. Returns ordered groups (Core first, feature
 * stacks in API order, the "Other containers" bucket last). Empty groups are
 * omitted. Infra containers and services owned by a core stack fold into the
 * Core group so the membership matches groupServicesByStack.
 */
/** Resolve the {id,label} group target for one container's groupable fields. */
function containerGroupTarget(
  { serviceName, isInfra }: GroupableContainer,
  templateToStack: Map<string, StackSummaryLite>,
): { id: string; label: string } {
  const owner = serviceName ? templateToStack.get(baseUnitName(serviceName)) ?? null : null;
  if (isInfra || isCoreStack(owner)) return { id: CORE_STACK_ID, label: 'Core services' };
  if (owner) return { id: owner.name, label: owner.manifest?.label || owner.name };
  // Owned by a service with no stack manifest — key on the service name so each
  // service still reads as its own labelled section.
  if (serviceName) return { id: `svc:${serviceName}`, label: serviceName };
  return { id: OTHER_CONTAINERS_ID, label: 'Other containers' };
}

export function groupContainersByStack<C>(
  containers: C[],
  accessor: (container: C) => GroupableContainer,
  stacks: StackSummaryLite[],
): ContainerStackGroup<C>[] {
  const templateToStack = buildTemplateToStack(stacks);

  const groups = new Map<string, ContainerStackGroup<C>>();
  const order: string[] = [];

  const ensure = (id: string, label: string): ContainerStackGroup<C> => {
    let group = groups.get(id);
    if (!group) {
      group = { id, label, containers: [] };
      groups.set(id, group);
      order.push(id);
    }
    return group;
  };

  for (const container of containers) {
    const { id, label } = containerGroupTarget(accessor(container), templateToStack);
    ensure(id, label).containers.push(container);
  }

  // Core services first, stack groups in order, "Other containers" bucket last.
  return orderGroups(groups, order, CORE_STACK_ID, OTHER_CONTAINERS_ID);
}
