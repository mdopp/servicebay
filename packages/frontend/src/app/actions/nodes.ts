'use server';

import { listNodes, addNode, updateNode, removeNode, setDefaultNode, PodmanConnection } from '@/lib/nodes';
import { verifyNodeConnection } from '@/lib/nodes/verify';
import { HealthStore } from '@/lib/health/store';
import { SSH_DIR } from '@/lib/dirs';
import { revalidatePath } from 'next/cache';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import crypto from 'crypto';
import { assertAdminSession } from './_session';

/**
 * Traversal barrier for the SSH-identity path (CodeQL js/path-injection at
 * createNode/editNode). `identity` is a request-supplied server-action param
 * that previously reached `fs.existsSync` (and the stored node) after only a
 * tilde expansion, so an absolute or `../`-laden value could point the box's
 * SSH auth at any file on disk. Legitimate keys live under the managed
 * `SSH_DIR` (`DATA_DIR/ssh`, the UI default `/app/data/ssh/id_rsa`) or the
 * agent user's own `~/.ssh`; nothing else is a valid key location.
 *
 * We tilde-expand, resolve, and require the result to sit inside one of those
 * allowed roots. On any escape we return `null` (fail closed) so the caller
 * rejects the request rather than touching an arbitrary path. The value that
 * flows onward to `fs`/`addNode`/`updateNode` is re-derived from the barrier
 * output, so CodeQL sees the taint severed by an explicit sanitizer.
 */
function resolveSafeIdentity(identity: string): string | null {
  if (typeof identity !== 'string' || identity.length === 0 || identity.includes('\0')) {
    return null;
  }
  const expanded = identity.replace(/^~(?=$|\/|\\)/, os.homedir());
  const resolved = path.resolve(expanded);
  const allowedRoots = [path.resolve(SSH_DIR), path.resolve(os.homedir(), '.ssh')];
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      // Re-derive the in-root path from the sanitised remainder so the value
      // reaching fs is built from the barrier output, not the raw taint.
      const inner = path.relative(root, resolved);
      return inner ? path.join(root, inner) : root;
    }
  }
  return null;
}

export async function getNodes(): Promise<PodmanConnection[]> {
  await assertAdminSession();
  return listNodes();
}

export async function createNode(name: string, destination: string, identity: string) {
  await assertAdminSession();
  try {
    // Constrain the identity path to an allowed SSH-key dir before it reaches
    // the filesystem or the stored node (path-injection barrier).
    const resolvedIdentity = resolveSafeIdentity(identity);
    if (!resolvedIdentity) {
        return { success: false, error: 'Identity path must be an SSH key under the managed key directory or ~/.ssh.' };
    }
    if (!fs.existsSync(resolvedIdentity)) {
        return { success: false, error: `Identity file not found at ${resolvedIdentity}` };
    }

    await addNode(name, destination, resolvedIdentity);
    
    // Verify connection
    const verification = await verifyNodeConnection(name);
    
    revalidatePath('/settings');
    
    if (!verification.success) {
        return { 
            success: true, 
            warning: `Node added, but connection check failed: ${verification.error || 'Unknown error'}` 
        };
    }

    // Create Health Check
    HealthStore.saveCheck({
        id: crypto.randomUUID(),
        name: `Node Health: ${name}`,
        type: 'node',
        target: name,
        interval: 60,
        enabled: true,
        created_at: new Date().toISOString()
    });

    // Create Agent Check
    HealthStore.saveCheck({
        id: crypto.randomUUID(),
        name: `Agent: ${name}`,
        type: 'agent',
        target: name,
        interval: 30, // Frequent checks for agent
        enabled: true,
        created_at: new Date().toISOString(),
        nodeName: 'Local'
    });
    
    return { success: true };
  } catch (error) {
    console.error('Failed to create node:', error);
    return { success: false, error: 'Failed to create node: ' + (error instanceof Error ? error.message : String(error)) };
  }
}

export async function editNode(oldName: string, newName: string, destination: string, identity: string) {
  await assertAdminSession();
  try {
     // Constrain the identity path to an allowed SSH-key dir before it reaches
     // the filesystem or the stored node (path-injection barrier).
     const resolvedIdentity = resolveSafeIdentity(identity);
     if (!resolvedIdentity) {
         return { success: false, error: 'Identity path must be an SSH key under the managed key directory or ~/.ssh.' };
     }
     if (!fs.existsSync(resolvedIdentity)) {
         return { success: false, error: `Identity file not found at ${resolvedIdentity}` };
     }

     const newNode: Partial<PodmanConnection> = {
         Name: newName,
         URI: destination,
         Identity: resolvedIdentity
     };

     await updateNode(oldName, newNode);
     
     // Verify connection
     const verification = await verifyNodeConnection(newName);
     
     revalidatePath('/settings');
     
     if (!verification.success) {
         return { 
             success: true, 
             warning: `Node updated, but connection check failed: ${verification.error || 'Unknown error'}` 
         };
     }

     return { success: true };
  } catch (error) {
     console.error('Failed to update node:', error);
     return { success: false, error: 'Failed to update node: ' + (error instanceof Error ? error.message : String(error)) };
  }
}

export async function deleteNode(name: string) {
  await assertAdminSession();
  try {
    await removeNode(name);
    
    // Remove associated health checks
    const checks = HealthStore.getChecks();
    const nodeChecks = checks.filter(c => 
        c.nodeName === name || 
        c.name === `Node Health: ${name}` ||
        c.name === `Agent: ${name}`
    );
    nodeChecks.forEach(c => HealthStore.deleteCheck(c.id));

    revalidatePath('/settings');
    return { success: true };
  } catch (error) {
    console.error('Failed to delete node:', error);
    return { success: false, error: 'Failed to delete node' };
  }
}

export async function setNodeAsDefault(name: string) {
  await assertAdminSession();
  try {
    await setDefaultNode(name);
    revalidatePath('/settings');
    return { success: true };
  } catch (error) {
    console.error('Failed to set default node:', error);
    return { success: false, error: 'Failed to set default node' };
  }
}
