/**
 * Host boot / power / reset MCP tools (#2384 extraction): UEFI BootNext
 * arming (#930), the read-only reinstall-readiness check (#1236), a plain
 * node reboot (#1235), and the factory reset (#1237).
 */
import { z } from 'zod';
import { agentManager } from '@/lib/agent/manager';
import { performStackReset, StackResetError } from '@/lib/install/performStackReset';
import { parseEfibootmgr, assessUsbBootReadiness } from '../efibootmgr';
import { nodeParam, resolveNode, textResult, errorResult, type ToolRegistration } from './context';

// A register function is a flat LIST of tool declarations, not a unit of logic:
// its length just counts how many tools the group holds. The rule stays ON for the
// handlers inside it, which is where real logic (and real length) would show up.
// eslint-disable-next-line max-lines-per-function
export function registerBootTools({ server }: ToolRegistration) {
  // --- Set Boot Next USB (#930) ---
  // Gated under 'destroy' scope. Sets BootNext to a USB UEFI entry and optionally reboots.
  server.tool(
    'set_boot_next_usb',
    'Configure UEFI BootNext one-shot target to boot from the installation USB next reboot, or clear current settings.',
    {
      action: z.enum(['list', 'set', 'clear']).optional().default('set').describe('Action: list candidates, set boot next, or clear active boot next'),
      bootNum: z.string().regex(/^[0-9A-Fa-f]{4}$/, 'Must be a 4-digit hex number').optional().describe('4-digit hex boot number (required for set if auto-detect not desired)'),
      reboot: z.boolean().optional().default(false).describe('Whether to reboot the system immediately after setting'),
      node: nodeParam,
    },
    async ({ action, bootNum, reboot, node }) => {
      const nodeName = await resolveNode(node);
      try {
        const agent = agentManager.getAgent(nodeName);

        if (action === 'clear') {
          const res = await agent.sendCommand('exec', { command: 'sudo -n efibootmgr -N' }) as { code?: number; stderr?: string };
          if (res.code !== 0) {
            return errorResult(`Failed to clear BootNext: ${res.stderr}`);
          }
          return textResult({ success: true, message: 'UEFI BootNext cleared successfully.' });
        }

        if (action === 'list') {
          const res = await agent.sendCommand('exec', { command: 'sudo -n efibootmgr -v' }) as { code?: number; stdout?: string };
          if (res.code !== 0) {
            return errorResult('Failed to query efibootmgr');
          }
          return textResult(parseEfibootmgr(res.stdout ?? ''));
        }

        // action === 'set'
        let targetBootNum = bootNum;
        if (!targetBootNum) {
          const res = await agent.sendCommand('exec', { command: 'sudo -n efibootmgr -v' }) as { code?: number; stdout?: string };
          if (res.code === 0) {
            const stdout = res.stdout ?? '';
            const lines = stdout.split('\n');
            for (const line of lines) {
              if (line.startsWith('Boot') && !line.startsWith('BootOrder') && !line.startsWith('BootNext') && !line.startsWith('BootCurrent')) {
                const match = line.match(/^Boot([0-9A-Fa-f]+)(\*?)\s+(.+)$/);
                if (match) {
                  const num = match[1];
                  const desc = match[3];
                  if (desc.toLowerCase().includes('usb') || desc.toLowerCase().includes('removable') || desc.includes('\\EFI\\boot\\')) {
                    targetBootNum = num;
                    break;
                  }
                }
              }
            }
          }
        }

        if (!targetBootNum) {
          return errorResult('No USB boot entry found or specified');
        }

        await agent.sendCommand('exec', { command: `sudo -n efibootmgr -A -b ${targetBootNum}` });
        const resBootNext = await agent.sendCommand('exec', { command: `sudo -n efibootmgr -n ${targetBootNum}` }) as { code?: number; stderr?: string };
        if (resBootNext.code !== 0) {
          return errorResult(`Failed to set BootNext: ${resBootNext.stderr}`);
        }

        if (reboot) {
          agent.sendCommand('exec', { command: 'systemctl reboot' }).catch(() => {});
        }

        return textResult({
          success: true,
          bootNum: targetBootNum,
          message: reboot ? 'One-shot BootNext set. System is rebooting.' : 'One-shot BootNext set successfully.',
        });
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- Verify USB boot reinstall-readiness (#1236) ---
  // Read-only: reports whether the firmware has an active USB/removable UEFI
  // entry to boot from, so the launcher (#1231) can confirm "reinstall-ready"
  // (and surface a fix when it isn't) BEFORE setting BootNext + rebooting.
  server.tool(
    'verify_usb_boot',
    'Check whether the node can boot from USB for a reinstall: reports if an active USB/removable UEFI boot entry exists, with a fix hint when it does not. Read-only; does not change boot order.',
    { node: nodeParam },
    async ({ node }) => {
      const nodeName = await resolveNode(node);
      try {
        const agent = agentManager.getAgent(nodeName);
        const res = await agent.sendCommand('exec', { command: 'sudo -n efibootmgr -v' }) as { code?: number; stdout?: string };
        if (res.code !== 0) {
          return errorResult('Failed to query efibootmgr (is this a UEFI node with efibootmgr installed?)');
        }
        const parsed = parseEfibootmgr(res.stdout ?? '');
        const readiness = assessUsbBootReadiness(parsed);
        return textResult({
          node: nodeName,
          reinstallReady: readiness.reinstallReady,
          activeUsbEntries: readiness.activeUsbEntries,
          usbCandidates: readiness.usbCandidates,
          bootNext: parsed.bootNext,
          bootCurrent: parsed.bootCurrent,
          bootOrder: parsed.bootOrder,
          ...(readiness.hint ? { hint: readiness.hint } : {}),
        });
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- Reboot Node (#1235) ---
  // Plain node reboot, distinct from set_boot_next_usb (no boot-order change).
  // Gated under 'destroy' scope + allowMutations. Not in DESTRUCTIVE_TOOLS: a
  // reboot doesn't mutate disk, so a pre-mutation snapshot would be wasted work
  // and would delay the reboot. The agent layer falls back to a direct SSH
  // reboot when the agent process itself is unreachable.
  server.tool(
    'reboot_node',
    'Reboot a node now. Distinct from set_boot_next_usb — this does not change boot order. Falls back to a direct SSH reboot when the agent process is unreachable but the box is up.',
    { node: nodeParam },
    async ({ node }) => {
      const nodeName = await resolveNode(node);
      try {
        const agent = agentManager.getAgent(nodeName);
        const { via } = await agent.rebootNode();
        return textResult({
          success: true,
          node: nodeName,
          via,
          message: `Reboot initiated on ${nodeName} (via ${via}). The node will be unreachable for a short while.`,
        });
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // --- Factory Reset (#1237) ---
  // Highest blast radius: wraps performStackReset (the same engine behind
  // /api/system/stacks/reset, which has caused total data loss). Guards:
  //   - destroy scope + allowMutations (safeHandler)
  //   - DESTRUCTIVE_TOOLS ⇒ automatic pre-reset system snapshot + operator email
  //   - `confirm` must EXACTLY equal the node name, and `node` is required
  //     (no first-node default) so it can't fire on the wrong/implicit box
  //   - preserve defaults to performStackReset's safe DEFAULT_PRESERVE; pass
  //     [] for a full nuke. The engine's own path-whitelist + validation gate
  //     still apply underneath.
  server.tool(
    'factory_reset',
    'DESTRUCTIVE: reset a node toward factory state via the stack-reset engine — stops and removes all non-protected services and wipes their data under DATA_DIR. `confirm` must exactly equal the node name to proceed. Takes an automatic pre-reset snapshot. `preserve` keeps reset groups (omit for the safe default; pass [] for a full wipe).',
    {
      node: z.string().min(1).describe('Node to factory-reset. Required — there is deliberately no default for a node-wide wipe.'),
      confirm: z.string().describe('Must exactly equal `node` to confirm intent. Any mismatch refuses the reset.'),
      preserve: z.array(z.string()).optional().describe('Reset groups to preserve. Omit for the safe default-preserve set; pass [] for a full nuke.'),
    },
    async ({ node, confirm, preserve }) => {
      if (confirm !== node) {
        return errorResult(
          `Refusing factory reset: \`confirm\` must exactly equal the node name "${node}". ` +
          `This stops + removes every non-protected service on the node and wipes its data.`,
        );
      }
      try {
        const result = await performStackReset({ node, preserve });
        return textResult({ success: true, ...result });
      } catch (err: unknown) {
        if (err instanceof StackResetError) return errorResult(err.message);
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
