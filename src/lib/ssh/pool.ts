import { Client } from 'ssh2';
import { readFileSync } from 'fs';
import { PodmanConnection, listNodes } from '../nodes';
import { logger } from '@/lib/logger';

export interface SSHClientWrapper {
  client: Client;
  nodeName: string;
  connected: boolean;
  lastUsed: number;
}

export class SSHConnectionPool {
  private static instance: SSHConnectionPool;
  private clients: Map<string, SSHClientWrapper> = new Map();
  private pendingConnections: Map<string, Promise<Client>> = new Map();

  private constructor() {}

  public static getInstance(): SSHConnectionPool {
    if (!SSHConnectionPool.instance) {
      SSHConnectionPool.instance = new SSHConnectionPool();
    }
    return SSHConnectionPool.instance;
  }

  /**
   * Get an active SSH connection for a node.
   * Reuses existing connection if available, or establishes a new one.
   */
  public async getConnection(nodeName: string): Promise<Client> {
    // 1. Check if we have an active connection
    const existing = this.clients.get(nodeName);
    if (existing && existing.connected) {
      existing.lastUsed = Date.now();
      return existing.client;
    }

    // 2. Check if a connection is currently being established (deduplication)
    if (this.pendingConnections.has(nodeName)) {
      return this.pendingConnections.get(nodeName)!;
    }

    // 3. Establish new connection
    const connectPromise = this.establishConnection(nodeName);
    this.pendingConnections.set(nodeName, connectPromise);

    try {
      const client = await connectPromise;
      return client;
    } finally {
      this.pendingConnections.delete(nodeName);
    }
  }

  private async establishConnection(nodeName: string): Promise<Client> {
    const nodes = await listNodes();
    const node = nodes.find(n => n.Name === nodeName);

    if (!node) {
      const error = `Node '${nodeName}' not found in nodes.json`;
      logger.error('SSH', error);
      throw new Error(error);
    }

    logger.info('SSH', `Establishing connection to ${nodeName} (${node.URI})...`);
    const config = await this.parseConnectionConfig(node);

    return new Promise((resolve, reject) => {
      const conn = new Client();
      let resolved = false;
      
      // Add connection timeout
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          const error = `SSH connection timeout for ${nodeName} (${node.URI})`;
          logger.error('SSH', error);
          this.removeConnection(nodeName);
          reject(new Error(error));
        }
      }, 15000); // 15 second timeout

      conn.on('ready', () => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          this.clients.set(nodeName, {
            client: conn,
            nodeName,
            connected: true,
            lastUsed: Date.now()
          });
          logger.info('SSH', `✓ Successfully connected to ${nodeName} (${node.URI})`);
          resolve(conn);
        }
      });

      conn.on('error', (err) => {
        if (!resolved) {
          clearTimeout(timeout);
          resolved = true;
          logger.error('SSH', `✗ Connection error for ${nodeName} (${node.URI}):`, err.message || err);
          this.removeConnection(nodeName);
          
          // Enhance common errors for better UI feedback
          let errorMsg = `SSH connection failed for ${nodeName}`;
          if (err.message) {
            if (err.message.includes('All configured authentication methods failed')) {
              errorMsg = `Authentication failed for ${nodeName}. Check your SSH key or credentials.`;
            } else if (err.message.includes('ENOTFOUND') || err.message.includes('getaddrinfo')) {
              errorMsg = `Cannot resolve hostname for ${nodeName}. Check the URI in nodes.json.`;
            } else if (err.message.includes('ECONNREFUSED')) {
              errorMsg = `Connection refused by ${nodeName}. Check if SSH server is running.`;
            } else if (err.message.includes('ETIMEDOUT')) {
              errorMsg = `Connection timeout for ${nodeName}. Check network connectivity.`;
            } else {
              errorMsg = `${errorMsg}: ${err.message}`;
            }
          }
          reject(new Error(errorMsg));
        }
      });

      conn.on('end', () => {
        logger.info('SSH', `Connection ended for ${nodeName}`);
        this.removeConnection(nodeName);
      });

      conn.on('close', () => {
        logger.info('SSH', `Connection closed for ${nodeName}`);
        this.removeConnection(nodeName);
      });

      try {
        logger.info('SSH', `Connecting with config: host=${config.host}, port=${config.port || 22}, user=${config.username}`);
        conn.connect(config);
      } catch (err) {
        clearTimeout(timeout);
        logger.error('SSH', `Failed to initiate connection to ${nodeName}:`, err);
        reject(err);
      }
    });
  }

  private removeConnection(nodeName: string) {
    const wrapper = this.clients.get(nodeName);
    if (wrapper) {
      wrapper.connected = false;
      try {
          wrapper.client.end();
      } catch { /* ignore */ }
      this.clients.delete(nodeName);
    }
  }

  private async parseConnectionConfig(node: PodmanConnection) {
    const uri = new URL(node.URI);
    // URI format: ssh://user@host:port/path (path is ignored for connection)
    
    let privateKey: string | Buffer;
    
    // Identity is a path. Need to read it.
    // If path is relative, what is it relative to? 
    // Assuming absolute or relative to ServiceBay data root?
    // Based on instructions, keys are in /app/data/ssh (which is persistent).
    // The node.Identity usually stores the full path.
    
    try {
        privateKey = readFileSync(node.Identity);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Failed to read SSH key at ${node.Identity}: ${msg}`);
    }

    return {
      host: uri.hostname,
      port: parseInt(uri.port) || 22,
      username: uri.username,
      privateKey,
      // Default timeouts
      readyTimeout: 20000,
      keepaliveInterval: 10000, // Send keepalive every 10s
    };
  }
}
