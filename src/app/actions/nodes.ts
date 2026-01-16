'use server';

import { listNodes, addNode, updateNode, removeNode, setDefaultNode, verifyNodeConnection, PodmanConnection } from '@/lib/nodes';
import { MonitoringStore } from '@/lib/monitoring/store';
import { revalidatePath } from 'next/cache';
import * as fs from 'fs';
import * as os from 'os';
import crypto from 'crypto';

export async function getNodes(): Promise<PodmanConnection[]> {
  return listNodes();
}

export async function createNode(name: string, destination: string, identity: string) {
  try {
    // Verify identity file exists
    const resolvedIdentity = identity.replace(/^~(?=$|\/|\\)/, os.homedir());
    if (!fs.existsSync(resolvedIdentity)) {
        return { success: false, error: `Identity file not found at ${resolvedIdentity}` };
    }

    await addNode(name, destination, identity);
    
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
    MonitoringStore.saveCheck({
        id: crypto.randomUUID(),
        name: `Node Health: ${name}`,
        type: 'node',
        target: name,
        interval: 60,
        enabled: true,
        created_at: new Date().toISOString()
    });

    // Create Agent Check
    MonitoringStore.saveCheck({
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
  try {
     // Verify identity file exists
     const resolvedIdentity = identity.replace(/^~(?=$|\/|\\)/, os.homedir());
     if (!fs.existsSync(resolvedIdentity)) {
         return { success: false, error: `Identity file not found at ${resolvedIdentity}` };
     }

     const newNode: Partial<PodmanConnection> = {
         Name: newName,
         URI: destination,
         Identity: identity
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
  try {
    await removeNode(name);
    
    // Remove associated health checks
    const checks = MonitoringStore.getChecks();
    const nodeChecks = checks.filter(c => 
        c.nodeName === name || 
        c.name === `Node Health: ${name}` ||
        c.name === `Agent: ${name}`
    );
    nodeChecks.forEach(c => MonitoringStore.deleteCheck(c.id));

    revalidatePath('/settings');
    return { success: true };
  } catch (error) {
    console.error('Failed to delete node:', error);
    return { success: false, error: 'Failed to delete node' };
  }
}

export async function setNodeAsDefault(name: string) {
  try {
    await setDefaultNode(name);
    revalidatePath('/settings');
    return { success: true };
  } catch (error) {
    console.error('Failed to set default node:', error);
    return { success: false, error: 'Failed to set default node' };
  }
}
