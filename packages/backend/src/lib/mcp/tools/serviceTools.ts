/**
 * Service-level MCP tools (#2384 extraction): the systemd-unit lifecycle —
 * list / manage / read files / deploy / update / rename / soft-delete + trash,
 * plus the unmanaged-bundle scan that surfaces units ServiceBay doesn't own.
 */
import { z } from 'zod';
import { getServices, getUnmanagedBundles } from '@/lib/store/repository';
// #2452 — every identifier below is interpolated into a shell command string on
// the node (systemctl/mkdir/mv/rm in services/serviceLifecycle.ts). The MCP tool
// surface validates them with the SAME strict schemas the REST routes use
// (app/api/services/[name]/**), so a metacharacter or `../` payload is rejected
// by the tool schema before any handler — and therefore any exec — runs.
import { ServiceName, TrashId, QuadletFileName, HostFilePath } from '@/lib/api/schemas';
// #2533 — `yamlFileName` and `extraFiles[].path` are the privileged fields of a
// deploy (a Quadlet-dir write, and an unquoted `mkdir -p <dir>` whose write
// retries with sudo). #2503 closed them on `POST /api/services`; these tools are
// the second entry point to the same sink, so they reuse that boundary contract
// verbatim — the same shared schemas plus the same containment rule.
import { checkExtraFileScope, DEFAULT_TEMPLATE_DATA_DIR } from '@/lib/services/deployRequest';
import { getConfig } from '@/lib/config';
import { ServiceManager } from '@/lib/services/ServiceManager';
import { redactServiceFiles } from '../redact';
import { nodeParam, resolveNode, textResult, errorResult, type ToolRegistration } from './context';

// A register function is a flat LIST of tool declarations, not a unit of logic:
// its length just counts how many tools the group holds. The rule stays ON for the
// handlers inside it, which is where real logic (and real length) would show up.
// eslint-disable-next-line max-lines-per-function
export function registerServiceTools({ server }: ToolRegistration) {
  // --- List Services ---
  server.tool('list_services', 'List logical services (systemd units) on a node with status, ports, volumes. A service may bundle multiple containers (see `associatedContainerIds`); to target a specific app, resolve its `<service>-<app>` container via list_containers.', { node: nodeParam }, async ({ node }) => {
    const nodeName = await resolveNode(node);
    return textResult(getServices(nodeName));
  });

  // --- Manage Service (#2324) — one lifecycle-scoped tool with an `action`
  // discriminator. Replaces start_service / stop_service / restart_service.
  // Returns the post-action service status (same as the old tools).
  // #2397 added `force-update`: a restart never re-checks the registry, so a
  // freshly pushed `:latest` needed a manual `podman pull` + recreate dance
  // (assists/recipe-roll-new-image-to-running-service.md). That dance is now
  // this action, and it reports the digests so a no-op is visibly a no-op. ---
  server.tool(
    'manage_service',
    'Start, stop, restart, or force-update a service via `action`. start/stop/restart return the service status after the action (same shape the old start/stop/restart tools returned). `force-update` re-checks the registry, re-pulls each image the service declares, and force-recreates its containers so the unit cannot come back up on the cached image — use it instead of a `podman pull` + restart by hand, and note that a plain `restart` never re-checks the registry. It returns a JSON report with per-image before/registry/after digests; if `stale` is true the local image still is not the one the registry serves — retry with `fresh: true`, which deletes the local image before re-pulling.',
    {
      action: z.enum(['start', 'stop', 'restart', 'force-update']).describe('Lifecycle action to perform on the service.'),
      name: ServiceName.describe('Service name'),
      fresh: z
        .boolean()
        .optional()
        .describe('`force-update` only: delete the local image first and pull it from scratch. The fallback for a genuinely stuck image — a shared image another service is running is kept, not deleted.'),
      node: nodeParam,
    },
    async ({ action, name, fresh, node }) => {
      const nodeName = await resolveNode(node);
      if (action === 'force-update') {
        return textResult(await ServiceManager.forceUpdateService(nodeName, name, { fresh }));
      }
      if (action === 'start') await ServiceManager.startService(nodeName, name);
      else if (action === 'stop') await ServiceManager.stopService(nodeName, name);
      else await ServiceManager.restartService(nodeName, name);
      const status = await ServiceManager.getServiceStatus(nodeName, name);
      return textResult(status);
    },
  );

  // --- Get Service Files ---
  server.tool(
    'get_service_files',
    'Get the on-disk files for a service. Returns `kubeContent` = the systemd Quadlet unit, `yamlContent` = the Kubernetes Pod-spec `.yml` (apiVersion/kind/spec), and `quadletKind` = "kube" or "container". For a `.kube` service (quadletKind="kube"): `kubeContent` is the [Kube]/[Install] unit and `yamlContent` is the pod spec; these field names are REVERSED relative to update_service_yaml — to write back the pod spec, pass this tool\'s `yamlContent` into update_service_yaml (the Quadlet unit is regenerated on its own). For a single-container `.container` service (quadletKind="container", e.g. ollama after the GPU fixup): `kubeContent` is the whole `.container` unit ([Container] section) and `yamlContent` is empty — the unit file IS the artifact, so edit `kubeContent` and pass it straight into update_service_yaml.',
    { name: ServiceName.describe('Service name'), node: nodeParam },
    async ({ name, node }) => {
      const nodeName = await resolveNode(node);
      const files = await ServiceManager.getServiceFiles(nodeName, name);
      // Rendered kube YAML inlines templated `{{X_PASSWORD}}` values.
      // Redact env entries with sensitive names before returning to the
      // MCP client (#321). The dashboard's own service-file viewer
      // doesn't go through this path; it reads from the same source
      // files but is gated by the admin session.
      return textResult(redactServiceFiles(files));
    },
  );

  // --- Deploy Service ---
  server.tool(
    'deploy_service',
    'Deploy a new service or update an existing one from kube YAML. Pass extraFiles to seed companion config (e.g. authelia/configuration.yml).',
    {
      name: ServiceName.describe('Service name'),
      kubeContent: z.string().describe('Kubernetes/Podman kube YAML content'),
      yamlContent: z.string().optional().describe('Companion compose/config YAML content'),
      yamlFileName: QuadletFileName.optional().describe('Filename for the companion YAML. A basename only — it is written into the Quadlet directory, so separators and `..` are rejected.'),
      extraFiles: z
        .array(
          z.object({
            path: HostFilePath.describe('Absolute path on the node (e.g. /mnt/data/stacks/auth/authelia-config/configuration.yml). Must sit inside this deploy\'s own scope: a hostPath its manifest declares, or its own subdirectory of the template data dir.'),
            content: z.string().describe('File content (already mustache-rendered)'),
          }),
        )
        .max(500)
        .optional()
        .describe('Additional config files to write before the unit starts. Failures are fatal — the deploy aborts so the operator knows the service would have started misconfigured.'),
      node: nodeParam,
    },
    async ({ name, kubeContent, yamlFileName, extraFiles, node }) => {
      const nodeName = await resolveNode(node);
      // Companion files may only land inside this service's own storage —
      // identical rule and identical helper to POST /api/services (#2503).
      // Without it a well-formed path like /etc/cron.d/pwn is a root-owned
      // write, because writeExtraConfigFiles retries a failed unprivileged
      // write with sudo.
      if (extraFiles?.length) {
        const dataDir = (await getConfig()).templateSettings?.DATA_DIR || DEFAULT_TEMPLATE_DATA_DIR;
        const scope = checkExtraFileScope(extraFiles, kubeContent, dataDir, name);
        if (!scope.ok) {
          return errorResult(`Error deploying service: extraFiles outside the service scope — ${scope.detail}`);
        }
      }
      // `kubeContent` here is the Pod YAML (Kubernetes manifest). We generate
      // the systemd .kube unit internally — same pattern as the install runner
      // (src/lib/install/runner.ts:275-276). The parameter name is historical;
      // the MCP description says "kube YAML content" meaning the Pod YAML.
      // The schema still accepts `yamlContent` for backwards-compat with
      // MCP clients that pass it; the handler ignores it because the
      // companion YAML is derived from `kubeContent` + extraFiles, not a
      // separate top-level field. Drop the schema entry in a future API
      // surface review.
      const resolvedYamlFileName = yamlFileName ?? `${name}.yml`;
      const generatedKubeUnit = `[Kube]\nYaml=${resolvedYamlFileName}\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target`;
      await ServiceManager.deployKubeService(
        nodeName,
        name,
        generatedKubeUnit,
        kubeContent,
        resolvedYamlFileName,
        extraFiles,
      );
      return textResult(`Service "${name}" deployed successfully${extraFiles?.length ? ` (${extraFiles.length} extra file${extraFiles.length === 1 ? '' : 's'} written)` : ''}`);
    },
  );

  // --- Update Service YAML (edit then redeploy) ---
  server.tool(
    'update_service_yaml',
    'Replace a service\'s on-disk definition and redeploy it. Use `get_service_files` first, modify, then call this. For a `.kube` service (quadletKind="kube"): the content this tool wants (in `kubeContent`/`podSpecContent`) is the POD SPEC — i.e. the `yamlContent` returned by get_service_files (apiVersion/kind/spec), NOT its `kubeContent` (the `.kube` Quadlet unit, regenerated automatically). For a single-container `.container` service (quadletKind="container", e.g. ollama): there is no pod spec — pass the edited `.container` unit body (the `kubeContent` from get_service_files, with a [Container] section) and it is written straight back. Either way the file is written and `systemctl --user daemon-reload` + restart is triggered.',
    {
      name: ServiceName.describe('Service name'),
      kubeContent: z.string().min(1).optional().describe('The Pod-spec `.yml` content (the `yamlContent` from get_service_files, apiVersion/kind/spec) — NOT the `.kube` Quadlet unit. Historical name; prefer `podSpecContent`. One of kubeContent / podSpecContent is required.'),
      podSpecContent: z.string().min(1).optional().describe('Alias for kubeContent — the Pod-spec `.yml` content (apiVersion/kind/spec). Clearer name for the same field; takes precedence if both are given.'),
      yamlContent: z.string().optional().describe('Optional companion compose/config YAML'),
      yamlFileName: QuadletFileName.optional().describe('Filename for companion YAML (default: <name>.yml). A basename only — it is written into the Quadlet directory, so separators and `..` are rejected.'),
      node: nodeParam,
    },
    async ({ name, kubeContent, podSpecContent, yamlFileName, node }) => {
      const nodeName = await resolveNode(node);
      try {
        const podSpec = podSpecContent ?? kubeContent;
        if (!podSpec) {
          return errorResult('Error updating service: provide the Pod-spec `.yml` content via `podSpecContent` (or `kubeContent`).');
        }
        // #1778: a single-container `.container` Quadlet (the ollama GPU
        // fixup) has no separate pod spec — the unit file IS the deploy
        // artifact, so the read/update contract differs: the caller edits
        // the `.container` unit body (the `kubeContent` from
        // get_service_files) and we write it straight back. A `.container`
        // body is the only legitimate reason to pass a `[Container]`
        // section, so only then do we look the service up (avoids a per-call
        // agent round-trip on the common `.kube` pod-spec path); the lookup
        // confirms the on-disk unit really is a `.container` before writing.
        if (/^\s*\[Container\]/m.test(podSpec)) {
          const existing = await ServiceManager.getServiceFiles(nodeName, name).catch(() => null);
          if (existing?.quadletKind === 'container') {
            await ServiceManager.deployContainerQuadlet(nodeName, name, podSpec);
            return textResult(`Service "${name}" (.container Quadlet) updated and redeployed`);
          }
          // Not a .container service — fall through to the footgun guard,
          // which correctly rejects a Quadlet unit passed where a pod spec
          // is expected.
        }
        // Field-name footgun guard: get_service_files returns the `.kube`
        // Quadlet unit under `kubeContent`. If a caller round-trips that field
        // verbatim into here, the `[Kube]`/`[Unit]` systemd unit would be
        // written into the Pod-spec `.yml` and clobber the manifest. Reject it
        // with a pointer to the right field rather than silently swapping the
        // on-disk files (memory: reference_box_credential_rekey_mechanics).
        if (/^\s*\[(Unit|Kube|Install|Container|Service)\]/m.test(podSpec)) {
          return errorResult(
            'Error updating service: the content looks like a systemd `.kube` Quadlet unit (has a [Kube]/[Unit] section), not a Pod-spec `.yml`. ' +
            'update_service_yaml expects the POD SPEC — that is the `yamlContent` field from get_service_files (apiVersion/kind/spec), NOT its `kubeContent`. ' +
            'The Quadlet unit is regenerated automatically; pass the pod spec instead.',
          );
        }
        const resolvedYamlFileName = yamlFileName ?? `${name}.yml`;
        const generatedKubeUnit = `[Kube]\nYaml=${resolvedYamlFileName}\nAutoUpdate=registry\n\n[Install]\nWantedBy=default.target`;
        await ServiceManager.deployKubeService(
          nodeName,
          name,
          generatedKubeUnit,
          podSpec,
          resolvedYamlFileName,
        );
        return textResult(`Service "${name}" updated and redeployed`);
      } catch (err) {
        return errorResult(`Error updating service: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // --- Rename Service ---
  server.tool(
    'rename_service',
    'Rename a service',
    {
      oldName: ServiceName.describe('Current service name'),
      newName: ServiceName.describe('New service name'),
      node: nodeParam,
    },
    async ({ oldName, newName, node }) => {
      const nodeName = await resolveNode(node);
      await ServiceManager.renameService(nodeName, oldName, newName);
      return textResult(`Service renamed from "${oldName}" to "${newName}"`);
    },
  );

  // --- Delete Service (soft) ---
  server.tool(
    'delete_service',
    'Soft-delete a service: stops the unit, moves its files to the trash bucket, and removes its cross-service registrations (Authelia OIDC client, NPM proxy host, AdGuard rewrite, credentials entry, LAN-block firewall rule). Restorable via restore_trashed_service for 7 days — restore re-provisions those registrations. Then auto-purged; use purge_trashed_service to delete immediately.',
    { name: ServiceName.describe('Service name'), node: nodeParam },
    async ({ name, node }) => {
      const nodeName = await resolveNode(node);
      await ServiceManager.deleteService(nodeName, name);
      return textResult(`Service "${name}" moved to trash. Use list_trashed_services / restore_trashed_service to recover.`);
    },
  );

  // --- List Trashed Services ---
  server.tool(
    'list_trashed_services',
    'List soft-deleted services available to restore. Each entry has an `id` you can pass to restore_trashed_service or purge_trashed_service.',
    { node: nodeParam },
    async ({ node }) => {
      const nodeName = await resolveNode(node);
      const items = await ServiceManager.listTrashedServices(nodeName);
      return textResult(items);
    },
  );

  // --- Restore From Trash ---
  server.tool(
    'restore_trashed_service',
    'Restore a soft-deleted service from trash, re-provisioning the cross-service registrations the delete removed and starting its unit again. Use list_trashed_services to find the id. If the reply says the unit is still starting, poll list_services until it reports active — that is a converging pod, not a failure.',
    { id: TrashId.describe('Trash entry id'), node: nodeParam },
    async ({ id, node }) => {
      const nodeName = await resolveNode(node);
      const result = await ServiceManager.restoreTrashedService(nodeName, id);
      // A restore that came back without its OIDC client / proxy route must
      // say so here — the operator is mid-recovery and would otherwise find
      // out by failing to log in (#2541).
      const failed = result.capabilityFailures.length > 0
        ? ` ⚠️ Re-provisioning incomplete: ${result.capabilityFailures.map(f => `${f.handler}: ${f.message}`).join('; ')}`
        : '';
      // #2756 — restore now starts the unit, so say what systemd is actually
      // doing. `converging` is a poll-me answer, not a failure: a caller that
      // cannot tell it apart from a dead unit reports a restored-but-dead
      // service, which is exactly what this tool used to do.
      const startup = result.startup.state === 'active'
        ? ` ${result.startup.detail}`
        : result.startup.state === 'converging'
          ? ` ⏳ ${result.startup.detail} Poll list_services until it reports active.`
          : ` ⚠️ ${result.startup.detail}`;
      return textResult(`Service "${result.service}" restored from trash on ${nodeName}.${startup}${failed}`);
    },
  );

  // --- Purge Trash (permanent delete) ---
  server.tool(
    'purge_trashed_service',
    'Permanently delete a trash entry. Use list_trashed_services to find the id. Counts as a destructive op (snapshotted).',
    { id: TrashId.describe('Trash entry id'), node: nodeParam },
    async ({ id, node }) => {
      const nodeName = await resolveNode(node);
      const result = await ServiceManager.purgeTrash(nodeName, { trashId: id });
      return textResult(`Purged ${result.purged.length} trash entr${result.purged.length === 1 ? 'y' : 'ies'} on ${nodeName}.`);
    },
  );

  // --- Get Unmanaged Bundles (ARCH-14, #846) ---
  server.tool(
    'get_unmanaged_bundles',
    'List unmanaged service bundles detected on a node — clusters of legacy systemd/docker units that ServiceBay can merge into managed Quadlet stacks. Returns each bundle\'s id, displayName, severity, hints, and member services.',
    { node: nodeParam },
    async ({ node }) => {
      const nodeName = await resolveNode(node);
      const bundles = getUnmanagedBundles(nodeName);
      return textResult(bundles);
    },
  );
}
