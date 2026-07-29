/**
 * Per-tool policy tables for the MCP surface (#2384).
 *
 * These four sets/maps are the *declarative* half of the safety layer:
 *   TOOL_SCOPES       — the scope a token must hold to call a tool
 *   MUTATING_TOOLS    — gated on `config.mcp.allowMutations`
 *   DESTRUCTIVE_TOOLS — pre-mutation snapshot + operator email
 *   DESTRUCTIVE_TOOL_ACTIONS — the same, for ONE action of a multi-action tool
 *   MCP_KERNEL_TOOLS  — the always-eager core advertised to Tool-Search clients
 *
 * They live here rather than in `server.ts` so a tool-group module (or the
 * request_token tool, which resolves a tool's tier) can read the tables without
 * importing `server.ts` and closing a dependency cycle. `server.ts` re-exports
 * the public names, so the module's external API is unchanged.
 */
import { type ApiScope, scopeSatisfiedBy } from '@/lib/auth/apiScope';

/**
 * Tools that mutate state. Calls are gated on `config.mcp.allowMutations`
 * (true | absent ⇒ allowed; false ⇒ blocked).
 */
export const MUTATING_TOOLS = new Set([
  'manage_service',
  'deploy_service', 'delete_service', 'rename_service', 'update_service_yaml',
  'restore_trashed_service', 'purge_trashed_service',
  'add_proxy_route', 'create_proxy_route', 'remove_proxy_route',
  'write_file', 'install_template',
  'file_access_request',
  'create_health_check', 'delete_health_check', 'run_check_now',
  'run_backup', 'restore_backup',
  'update_config', 'exec_command', 'container_exec', 'refresh_agent',
  'set_boot_next_usb', 'reboot_node', 'factory_reset',
  'set_channel',
  'propose_learning',
]);

/**
 * Per-tool required scope. Bearer-token auth refuses any tool whose scope
 * isn't in the token's set. Cookie auth has all scopes for back-compat.
 *
 *   read       lookups + diagnose + log readers
 *   lifecycle  start/stop/restart + force-update (re-pull the declared image
 *              and recreate the containers — the service's DATA is untouched,
 *              but the image it runs can move forward and a container is
 *              force-removed; #2419 keeps it here and covers it with the
 *              destructive-call safeguards instead, see
 *              DESTRUCTIVE_TOOL_ACTIONS) + run_check_now + refresh + run_backup
 *   mutate     create/update/add + config writes — additive changes
 *   reboot     reboot_node — transient, recoverable host restart (#1765),
 *              split off `destroy` so a token can operate+reboot without
 *              also granting irreversible delete/wipe. `destroy` implies it.
 *   destroy    delete/restore/purge/factory_reset — irreversible state edits
 *   exec       exec_command — split off from `destroy` (#591) so a token
 *              can grant config writes without shell access
 *   propose    propose_learning — an INDEPENDENT, low-privilege capability
 *              scope (#2326), NOT on the read<…<exec ladder. A `propose`-only
 *              token may submit knowledge proposals and nothing else; a
 *              read/mutate/destroy token does NOT implicitly get `propose`.
 */
export const TOOL_SCOPES: Record<string, ApiScope> = {
  // read
  list_nodes: 'read', list_services: 'read', list_containers: 'read',
  get_logs: 'read', get_service_files: 'read',
  list_templates: 'read', get_template_artifact: 'read',
  list_assists: 'read', get_assist: 'read', get_service_standards: 'read',
  get_system_info: 'read', get_network_graph: 'read', get_health_checks: 'read',
  get_gateway_status: 'read', get_proxy_routes: 'read', get_config: 'read',
  list_system_services: 'read',
  list_backups: 'read', diagnose: 'read', verify_node_connection: 'read',
  verify_usb_boot: 'read',
  list_trashed_services: 'read',
  get_unmanaged_bundles: 'read',
  get_channel: 'read',
  get_access_request_status: 'read',
  // #2326 s3: admin reads of the learning-proposal review queue. `read`-scoped
  // (like list_requests / get_access_request_status) — these only SURFACE
  // pending proposals to an admin for review; approving/rejecting is an
  // admin-only action on the dashboard (NOT an MCP tool), so a `propose`-scoped
  // submitter can see nothing here and cannot approve their own proposal.
  list_learning_proposals: 'read', get_learning_proposal: 'read',
  // #2326 s5: drift-report — read-only view of landed local-assists that are
  // not yet promoted to the repo (assists/). Surfaces the promotion backlog.
  list_assist_drift: 'read',
  // Scoped-token request flow (#2139). A token *request* itself grants
  // nothing — it just files a pending item the admin must approve — so it
  // needs only the lowest scope (`read`). This is deliberate: a caller with
  // no token at all can't invoke MCP tools, but a caller holding even a
  // read-only token can ASK for a broader, short-lived grant that a human
  // signs off on. Making request_token require a high scope would defeat the
  // point (you'd need the very authority you're trying to request).
  request_token: 'read', poll_token_request: 'read', list_requests: 'read',
  // read-oriented file/disk tools (#1872) — jailed reads, no mutation
  read_file: 'read', list_dir: 'read', disk_usage: 'read',
  // install progress is a read-only poll of a job's state (#2141)
  get_install_progress: 'read',
  // lifecycle
  manage_service: 'lifecycle',
  run_check_now: 'lifecycle', refresh_agent: 'lifecycle',
  run_backup: 'lifecycle',
  set_channel: 'lifecycle',
  // mutate
  deploy_service: 'mutate', update_service_yaml: 'mutate', rename_service: 'mutate',
  add_proxy_route: 'mutate', create_health_check: 'mutate',
  // #2140 create_proxy_route (full NPM host: exposure + forward-auth + cert)
  // and #2141 install_template (assemble→start a wizard install) and #2142
  // write_file are all additive provisioning ops → `mutate`, NOT `destroy`.
  create_proxy_route: 'mutate', install_template: 'mutate', write_file: 'mutate',
  restore_trashed_service: 'mutate',
  file_access_request: 'mutate',
  // mutate (config writes, allow-listed to safe keys — see update_config tool)
  update_config: 'mutate',
  // destroy
  delete_service: 'destroy', delete_health_check: 'destroy',
  remove_proxy_route: 'destroy', restore_backup: 'destroy',
  purge_trashed_service: 'destroy',
  // set_boot_next_usb stays `destroy`: it can arm a USB-installer boot, a
  // reinstall path that risks data loss — higher-risk than a plain reboot.
  set_boot_next_usb: 'destroy',
  factory_reset: 'destroy',
  // reboot — transient, recoverable; split out of destroy (#1765)
  reboot_node: 'reboot',
  // exec (shell — own scope so tokens can grant config writes without it)
  exec_command: 'exec',
  // container_exec (#1872): runs a command inside a named container via an
  // argv array (no host shell). It executes code, so it requires the `exec`
  // scope like exec_command — but it's a scoped container exec, not the host
  // escape hatch, and is read-oriented per the issue, so it is deliberately
  // NOT in DESTRUCTIVE_TOOLS (no pre-mutation host snapshot).
  container_exec: 'exec',
  // propose (#2326): the Rückkanal ingest. Its own INDEPENDENT low-privilege
  // scope — a `propose`-only token sees + calls propose_learning and nothing
  // else; a read/mutate/destroy token does NOT implicitly see or call it.
  propose_learning: 'propose',
};

/**
 * Decide whether a token with `tokenScopes` may call a tool that
 * requires `required`. Encapsulates the back-compat rules:
 *   - tokens issued before the exec split (#591) — when `exec_command`
 *     was tagged `destroy` — still get exec via their `destroy` grant.
 *   - `destroy` implies `reboot` (#1765): the reboot tier was carved out
 *     of `destroy`, so a legacy `destroy` token can still reboot a node.
 *
 * Exported pure helper so the scope semantics are testable without
 * spinning up the whole MCP server.
 */
export function tokenHasScope(tokenScopes: readonly ApiScope[], required: ApiScope): boolean {
  // Single-sourced scope-implication ladder lives in apiScope.ts (#2048) so
  // the delegated-mint subset check and this MCP gate can't drift.
  return scopeSatisfiedBy(tokenScopes, required);
}

/**
 * `defer_loading` kernel set (#2325). A small always-on core that a client
 * using the Anthropic Tool Search Tool keeps eagerly loaded; every other tool
 * is a `defer_loading` candidate the client can lazy-load on demand. This is a
 * *hint surface* only — we don't force Tool Search (client-side decision), we
 * just designate + advertise the core so a client CAN lazy-load the rest
 * (schemas append, not swap → prompt cache stays intact). Kept read-only so the
 * core is safe to always advertise; it must stay a subset of the read tier so a
 * read-only token still sees the whole kernel.
 */
export const MCP_KERNEL_TOOLS: readonly string[] = [
  'list_services',
  'list_containers',
  'diagnose',
  'get_logs',
  'get_system_info',
];

/**
 * Whether a token holding `scopes` may SEE `toolName` in `tools/list` (#2325).
 * Visibility mirrors the scope gate: a tool is advertised only when the token
 * could actually call it — a read-only token must not see mutate/destroy/exec
 * tools. Enforcement is unchanged (`safeHandler` stays the authority); this only
 * changes *visibility*. No auth (cookie/operator/internal dispatch) ⇒ all tools
 * visible, matching the "cookie has all scopes" gate rule.
 */
export function isToolVisibleForScopes(
  toolName: string,
  scopes: readonly ApiScope[] | undefined,
): boolean {
  if (!scopes) return true;
  const required = TOOL_SCOPES[toolName] ?? 'read';
  return tokenHasScope(scopes, required);
}

/**
 * Subset of MUTATING_TOOLS that can lose data or change config in
 * non-trivially-reversible ways. These trigger an automatic
 * pre-mutation system snapshot so the operator always has a one-click
 * rewind point.
 *
 * Note: `delete_service` is now soft (moves to trash, recoverable for 7d
 * via restore_trashed_service), so it doesn't need an extra snapshot.
 * `purge_trashed_service`, by contrast, IS the irreversible step.
 */
export const DESTRUCTIVE_TOOLS = new Set([
  'deploy_service', 'rename_service', 'update_service_yaml',
  'purge_trashed_service',
  'remove_proxy_route', 'restore_backup',
  'update_config', 'exec_command',
  'set_boot_next_usb',
  'factory_reset',
]);

/**
 * Per-ACTION destructive calls (#2419). `DESTRUCTIVE_TOOLS` is keyed on the tool
 * name, but `manage_service` carries four actions with very different blast
 * radii: start/stop/restart are reversible in-place verbs, while `force-update`
 * re-pulls the image, force-removes the service's containers, and in `fresh`
 * mode deletes the local image first. Tagging the whole tool destructive would
 * snapshot + email on every routine restart; tagging none of it left the
 * heaviest action with no rewind point and no operator notice.
 *
 * So the safeguard is resolved per CALL: `<tool>` → the set of `args.action`
 * values that get the destructive treatment. The tool's SCOPE is unchanged —
 * `manage_service` stays `lifecycle` by the architect's decision on #2419
 * (lifecycle-only tokens and the companion app must keep force-update), and the
 * safeguards are what make that tier honest.
 */
export const DESTRUCTIVE_TOOL_ACTIONS: Record<string, readonly string[]> = {
  manage_service: ['force-update'],
};

/**
 * Label this specific call if it deserves the destructive-op safeguards
 * (pre-mutation snapshot + operator email), else `null`.
 *
 * Returns a label rather than a boolean so both safeguards name the ACTION and
 * not just the tool: the snapshot lands as `pre-mutation:manage_service:force-update(…)`
 * and the email/coalescing key is per-action, so an operator can tell a
 * force-update apart from the tool's reversible verbs at a glance.
 */
export function destructiveCallLabel(
  toolName: string,
  args?: Record<string, unknown>,
): string | null {
  if (DESTRUCTIVE_TOOLS.has(toolName)) return toolName;
  const action = args?.action;
  if (typeof action === 'string' && DESTRUCTIVE_TOOL_ACTIONS[toolName]?.includes(action)) {
    return `${toolName}:${action}`;
  }
  return null;
}

/**
 * `destroy`-tier tools (delete/purge/restore/factory_reset/set_boot_next_usb)
 * are the ones a token caller may *propose* but not *execute* without a human
 * confirm (#1766). Derived from TOOL_SCOPES so the gate predicate stays in
 * lockstep with the scope map — adding a tool at the `destroy` tier
 * automatically routes it through the approval gate.
 */
export function isDestroyTierTool(toolName: string): boolean {
  return TOOL_SCOPES[toolName] === 'destroy';
}
