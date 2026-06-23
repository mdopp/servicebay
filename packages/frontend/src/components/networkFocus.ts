/**
 * Network-map focus link helpers (#2108).
 *
 * The Services list (ServiceRow / ServiceCard) gets a per-service "focus"
 * affordance that jumps to the Network Map with that service highlighted /
 * centred. This module is the single source of truth for:
 *   - the href the list button navigates to (`networkFocusHref`), and
 *   - how the dashboard turns the `?focus=` param back into a graph node id
 *     (`matchesFocusParam`).
 *
 * The network graph keys service nodes on `service-<unit-name>`, optionally
 * prefixed with `<node>:` for remote managed hosts (see
 * packages/backend/src/lib/network/service.ts `prefix(\`service-${name}\`)`).
 * The list only knows the canonical unit name (`ServiceViewModel.name`, e.g.
 * "immich.service"), so we pass that bare and let the dashboard resolve it
 * against the rendered nodes — which transparently handles the remote-host
 * prefix without the list having to reconstruct it.
 */

/** The query-param key the Network Map reads to focus a node. */
export const NETWORK_FOCUS_PARAM = 'focus';

/** Href to the Network Map focused on this service, keyed on the canonical
 *  unit name. Returns the bare `/network` route when there is no name to
 *  focus (defensive — a real service always has one). */
export function networkFocusHref(serviceName: string | undefined | null): string {
  const name = serviceName?.trim();
  if (!name) return '/network';
  return `/network?${NETWORK_FOCUS_PARAM}=${encodeURIComponent(name)}`;
}

/**
 * True when `nodeId` is the graph node for the service named `focus`.
 * Matches both the local form (`service-immich.service`) and the remote
 * form (`box2:service-immich.service`) so a remote service focuses too.
 */
export function matchesFocusParam(nodeId: string, focus: string): boolean {
  if (!focus) return false;
  const wanted = `service-${focus}`;
  return nodeId === wanted || nodeId.endsWith(`:${wanted}`);
}

/**
 * Resolve the focus param to a concrete graph node id present in `nodeIds`,
 * or null when nothing matches (stale link / service gone). Prefers an exact
 * local match, then any remote-prefixed match.
 */
export function resolveFocusNodeId(
  nodeIds: readonly string[],
  focus: string | null | undefined,
): string | null {
  if (!focus) return null;
  return nodeIds.find((id) => matchesFocusParam(id, focus)) ?? null;
}

/**
 * Decide how the Network Map should react to the `?focus=` deep-link for a
 * freshly-laid-out graph (#2108). Keeps the once-per-param-value semantics out
 * of the dashboard's already-dense layout effect:
 *  - `nodeId`        — the resolved node to focus (apply to layout + state), or null.
 *  - `appliedParam`  — the param value to record as applied once committed, or null.
 *  - `clearApplied`  — true when there is no param, so the guard ref resets and a
 *                      later return to the same service re-applies.
 */
export function planDeepLinkFocus(
  nodeIds: readonly string[],
  focus: string | null | undefined,
  alreadyApplied: string | null,
): { nodeId: string | null; appliedParam: string | null; clearApplied: boolean } {
  if (!focus) return { nodeId: null, appliedParam: null, clearApplied: true };
  if (focus === alreadyApplied) return { nodeId: null, appliedParam: null, clearApplied: false };
  const nodeId = resolveFocusNodeId(nodeIds, focus);
  return { nodeId, appliedParam: nodeId ? focus : null, clearApplied: false };
}
