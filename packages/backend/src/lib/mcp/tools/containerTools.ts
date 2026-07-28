/**
 * Container-level MCP tools (#2384 extraction): the container inventory and
 * the scoped in-container exec.
 */
import { z } from 'zod';
import { getContainers } from '@/lib/store/repository';
import { AgentExecutor } from '@/lib/agent/executor';
import { shellQuote } from '@/lib/util/shellQuote';
import { redactLogText } from '../redact';
import { nodeParam, resolveNode, textResult, errorResult, type ToolRegistration } from './context';

export function registerContainerTools({ server }: ToolRegistration) {
  // --- List Containers ---
  server.tool('list_containers', 'List running containers with image, state, ports. Container names follow `<service>-<app>` (e.g. `media-jellyfin`); use the resolved name with get_logs(source="container").', { node: nodeParam }, async ({ node }) => {
    const nodeName = await resolveNode(node);
    return textResult(getContainers(nodeName));
  });

  // #1872 — argv-based container exec. NOT in DESTRUCTIVE_TOOLS: it is a
  // scoped container exec (not the host escape hatch), so it never fires
  // snapshotBeforeMutation.
  server.tool(
    'container_exec',
    'LAST RESORT for in-container commands — run a command inside a named container via `podman exec`, passing an argv array (no host shell string). Prefer a read tool FIRST; only use container_exec when NO dedicated/read tool covers the task. Read-alternatives map: image / revision / state → list_containers (labels org.opencontainers.image.revision, org.opencontainers.image.version); container logs → get_logs(source="container"), service/unit logs → get_logs(source="service"); CPU / RAM / disk / uptime → get_system_info; read a file → read_file, a service\'s files → get_service_files; list services / containers → list_services / list_containers. Scoped to one container (not the host); the container name is validated and args pass as a list so the host shell never parses them.',
    {
      container: z.string().regex(/^[a-zA-Z0-9_.-]+$/, 'invalid container name').describe('Container name or id (e.g. media-jellyfin).'),
      args: z.array(z.string()).min(1).describe('Command + arguments as an argv array, e.g. ["cat", "/etc/os-release"]. Passed verbatim — no shell interpolation.'),
      node: nodeParam,
    },
    async ({ container, args, node }) => {
      const nodeName = await resolveNode(node);
      try {
        const exec = new AgentExecutor(nodeName);
        // argv form end-to-end via safe_exec: the agent runs `podman exec
        // <name> <args…>` without a host shell, so a metacharacter in args can
        // never start a new host command (the container name is also
        // regex-validated by the schema). Kept on execSafe (not execArgv) so
        // the argv is never shell-parsed end-to-end (the legacy `exec` trace
        // wrapper that swallowed the command was fixed in #1877).
        // `podman` is on the agent SAFE_EXEC_ALLOWLIST.
        const argv = ['podman', 'exec', container, ...args];
        const res = await exec.execSafe(argv);
        return textResult({
          container,
          command: argv.map(shellQuote).join(' '),
          exitCode: res.code,
          stdout: redactLogText(res.stdout ?? ''),
          stderr: redactLogText(res.stderr ?? ''),
        });
      } catch (err) {
        return errorResult(`Error running container command: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
