/**
 * `verifyNodeConnection` — runs a remote `podman info` to confirm SSH
 * access + Podman installation on a configured node.
 *
 * Lives here (not in `nodes.ts`) because it's the only piece of nodes
 * IO that needs the executor layer at runtime. Keeping it separate
 * means `nodes.ts` stays a pure config-IO module — no dependency on
 * `executor.ts` or anything in the agent layer. That break drops the
 * last cycle in the agent/executor/handler/manager + ssh/pool + nodes
 * + executor graph (#601 / ARCH-12).
 */
import { listNodes, normalizeName } from '../nodes';
import { getExecutor } from '../executor';

export async function verifyNodeConnection(name: string): Promise<{ success: boolean; error?: string }> {
  try {
    const nodes = await listNodes();
    const node = nodes.find(n => normalizeName(n.Name) === normalizeName(name));
    if (!node) {
      throw new Error(`Node ${name} not found`);
    }
    const executor = getExecutor(node);
    // `podman info` is the canonical "everything's wired up" probe —
    // proves both SSH access and a working Podman socket on the
    // remote side.
    await executor.exec('podman info');
    return { success: true };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    console.warn(`Connection check failed for node ${name}:`, e);
    return { success: false, error: errorMessage };
  }
}
