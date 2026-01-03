'use server';

import { listNodes, addNode, removeNode, setDefaultNode, PodmanConnection } from '@/lib/nodes';
import { revalidatePath } from 'next/cache';

export async function getNodes(): Promise<PodmanConnection[]> {
  return listNodes();
}

export async function createNode(name: string, destination: string, identity?: string) {
  try {
    await addNode(name, destination, identity);
    revalidatePath('/settings');
    return { success: true };
  } catch (error) {
    console.error('Failed to create node:', error);
    return { success: false, error: 'Failed to create node' };
  }
}

export async function deleteNode(name: string) {
  try {
    await removeNode(name);
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
