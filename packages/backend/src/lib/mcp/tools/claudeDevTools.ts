/**
 * ONE tool for the claude-dev projects on the dev box (#2714).
 *
 * The operator asked for "a tool for creating/deleting/restarting projects —
 * ONE tool, not 3". The parenthesis is the requirement, not a preference: the
 * tool catalogue is context every session loads on every connect, so three
 * tools for one subject cost three descriptions, three selection decisions and
 * three places the same permission logic can drift apart. `manage_service`
 * already established the shape — one tool, one `action` discriminator — and
 * this follows it.
 *
 * The handler is deliberately thin. Everything that decides an outcome lives in
 * the container's own mechanics (`templates/claude-dev/config-ui/server.mjs`),
 * which the configuration UI calls through the same routes: name validation,
 * the unmanaged-checkout guard (#2713), the `=`-anchored tmux target that keeps
 * a stop off a neighbouring window, and the ask-tmux-afterwards rule that keeps
 * a restart from reporting a success the session did not have (#2682). This
 * module maps arguments onto that call and reports what came back.
 *
 * Scope is split by REVERSIBILITY, not by convenience (docs/SCOPE_AUDIT.md):
 * `create` and `restart` are `lifecycle`; `delete` is `destroy`, because it
 * revokes a delegated token and ends a running session. That split is declared
 * in `toolPolicy.ts` (`TOOL_ACTION_SCOPES`) and enforced per CALL, so a
 * lifecycle-only token can start and restart projects but a removal goes
 * through the destroy tier — including the human-approval gate.
 */
import { z } from 'zod';
import { callClaudeDevProject, checkProjectArgs } from '@/lib/claudeDev/projects';
import { textResult, errorResult, type ToolRegistration } from './context';

export function registerClaudeDevTools({ server, caller }: ToolRegistration) {
  server.tool(
    'manage_claude_dev_project',
    'Create, restart or delete a Claude project on the claude-dev box via `action`. '
    + 'A "project" is one git checkout in the dev container\'s workspace, with its own delegated read-only ServiceBay token, its own MCP entry and its own Claude session (a tmux window). '
    + '`create` clones `gitUrl` (or adopts a checkout already on the box when only `name` is given), delegates that project a token, wires its MCP entry and starts its session. '
    + '`restart` stops and starts exactly that one session, then re-asks tmux whether it really came back — a restart that does not come back is an error, never a warning. '
    + '`delete` revokes that project\'s token, drops its MCP entry and stops its session; nothing on disk is deleted. A checkout this page did not add is refused until you repeat the call with `acknowledgeUnmanaged: true`, which stops the session and marks it, revokes nothing and drops no entry. '
    + 'Sibling projects are never touched. Returns the mechanics\' own report, including `warnings` — read them: a create can succeed with no session, and that is said out loud rather than hidden.',
    {
      action: z.enum(['create', 'delete', 'restart']).describe('What to do with the project.'),
      name: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('Project name = the checkout directory = the tmux window name. Required for `delete` and `restart`; on `create` it defaults to the last segment of `gitUrl`.'),
      gitUrl: z
        .string()
        .max(512)
        .optional()
        .describe('`create` only: the remote to clone (https://, http://, ssh:// or git@host:path). Omit it — and pass `name` — to adopt a checkout that is already in the workspace.'),
      acknowledgeUnmanaged: z
        .boolean()
        .optional()
        .describe('`delete` only: acknowledge that this checkout was not added through the configuration UI, so there is no token of ours to revoke and no MCP entry of ours to drop. Without it such a removal is refused.'),
    },
    async ({ action, name, gitUrl, acknowledgeUnmanaged }) => {
      const input = { action, name, gitUrl, acknowledgeUnmanaged, caller };
      // Arguments the action does not use are refused, not ignored: a caller
      // that passes a clone URL to a restart believes something untrue about
      // what is about to happen.
      const argError = checkProjectArgs(input);
      if (argError) return errorResult(`Error: ${argError}`);
      const outcome = await callClaudeDevProject(input);
      if (!outcome.ok) {
        return errorResult(
          `Error: claude-dev refused to ${action} project "${name ?? gitUrl ?? ''}" (HTTP ${outcome.status}): `
          + `${outcome.error}${outcome.detail ? ` — ${outcome.detail}` : ''}`,
        );
      }
      return textResult(outcome.result);
    },
  );
}
