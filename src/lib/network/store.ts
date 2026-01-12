import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const STORE_PATH = path.join(os.homedir(), '.servicebay', 'network-edges.json');

export interface ManualEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  port?: number;
  created_at: string;
}

export class NetworkStore {
  static async getEdges(): Promise<ManualEdge[]> {
    try {
      const content = await fs.readFile(STORE_PATH, 'utf-8');
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  static async addEdge(edge: ManualEdge): Promise<void> {
    const edges = await this.getEdges();
    // Avoid duplicates
    if (!edges.find(e => e.source === edge.source && e.target === edge.target)) {
        edges.push(edge);
        await this.saveEdges(edges);
    }
  }

  static async removeEdge(id: string): Promise<void> {
    const edges = await this.getEdges();
    const filtered = edges.filter(e => e.id !== id);
    await this.saveEdges(filtered);
  }

  private static async saveEdges(edges: ManualEdge[]): Promise<void> {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fs.writeFile(STORE_PATH, JSON.stringify(edges, null, 2));
  }
}