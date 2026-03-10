/**
 * LLDAP GraphQL API client for user and group management.
 * Connects to LLDAP's HTTP API (not LDAP protocol) for admin operations.
 */

interface LldapConfig {
  host: string;
  httpPort: number;
  baseDn: string;
  adminPassword: string;
}

export interface LldapUser {
  id: string;
  email: string;
  displayName: string;
  firstName: string;
  lastName: string;
  creationDate: string;
  groups: { id: number; displayName: string }[];
}

export interface LldapGroup {
  id: number;
  displayName: string;
  creationDate: string;
  users: { id: string; displayName: string }[];
}

/** Default groups to seed on first setup */
const DEFAULT_GROUPS = [
  { name: 'admins', description: 'Full access to all services and admin panels' },
  { name: 'family', description: 'Access to user-facing services (photos, passwords, files, home automation)' },
];

class LldapClient {
  private baseUrl: string;
  private adminPassword: string;
  private token: string | null = null;
  private tokenExpiry = 0;

  constructor(config: LldapConfig) {
    this.baseUrl = `http://${config.host}:${config.httpPort}`;
    this.adminPassword = config.adminPassword;
  }

  private async authenticate(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiry) {
      return this.token;
    }

    const res = await fetch(`${this.baseUrl}/auth/simple/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: this.adminPassword }),
    });

    if (!res.ok) {
      throw new Error(`LLDAP auth failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    this.token = data.token;
    // Refresh 5 minutes before expiry (tokens last ~1 day)
    this.tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
    return this.token!;
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const token = await this.authenticate();
    const res = await fetch(`${this.baseUrl}/api/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      throw new Error(`LLDAP GraphQL error: ${res.status} ${await res.text()}`);
    }

    const json = await res.json();
    if (json.errors?.length) {
      throw new Error(`LLDAP GraphQL: ${json.errors[0].message}`);
    }
    return json.data as T;
  }

  async listUsers(): Promise<LldapUser[]> {
    const data = await this.graphql<{ users: LldapUser[] }>(`
      query {
        users {
          id email displayName firstName lastName creationDate
          groups { id displayName }
        }
      }
    `);
    return data.users;
  }

  async getUser(userId: string): Promise<LldapUser> {
    const data = await this.graphql<{ user: LldapUser }>(`
      query($userId: String!) {
        user(userId: $userId) {
          id email displayName firstName lastName creationDate
          groups { id displayName }
        }
      }
    `, { userId });
    return data.user;
  }

  async createUser(input: {
    id: string;
    email: string;
    displayName?: string;
    firstName?: string;
    lastName?: string;
  }): Promise<LldapUser> {
    const data = await this.graphql<{ createUser: LldapUser }>(`
      mutation($user: CreateUserInput!) {
        createUser(user: $user) {
          id email displayName firstName lastName creationDate
          groups { id displayName }
        }
      }
    `, { user: input });
    return data.createUser;
  }

  async deleteUser(userId: string): Promise<void> {
    await this.graphql(`
      mutation($userId: String!) {
        deleteUser(userId: $userId) { ok }
      }
    `, { userId });
  }

  async listGroups(): Promise<LldapGroup[]> {
    const data = await this.graphql<{ groups: LldapGroup[] }>(`
      query {
        groups {
          id displayName creationDate
          users { id displayName }
        }
      }
    `);
    return data.groups;
  }

  async createGroup(name: string): Promise<LldapGroup> {
    const data = await this.graphql<{ createGroup: LldapGroup }>(`
      mutation($name: String!) {
        createGroup(name: $name) {
          id displayName creationDate
          users { id displayName }
        }
      }
    `, { name });
    return data.createGroup;
  }

  async deleteGroup(groupId: number): Promise<void> {
    await this.graphql(`
      mutation($groupId: Int!) {
        deleteGroup(groupId: $groupId) { ok }
      }
    `, { groupId });
  }

  async addUserToGroup(userId: string, groupId: number): Promise<void> {
    await this.graphql(`
      mutation($userId: String!, $groupId: Int!) {
        addUserToGroup(userId: $userId, groupId: $groupId) { ok }
      }
    `, { userId, groupId });
  }

  async removeUserFromGroup(userId: string, groupId: number): Promise<void> {
    await this.graphql(`
      mutation($userId: String!, $groupId: Int!) {
        removeUserFromGroup(userId: $userId, groupId: $groupId) { ok }
      }
    `, { userId, groupId });
  }

  /**
   * Seed default groups if they don't already exist.
   * Returns the list of groups that were created.
   */
  async seedDefaultGroups(): Promise<string[]> {
    const existing = await this.listGroups();
    const existingNames = new Set(existing.map(g => g.displayName));
    const created: string[] = [];

    for (const group of DEFAULT_GROUPS) {
      if (!existingNames.has(group.name)) {
        await this.createGroup(group.name);
        created.push(group.name);
      }
    }
    return created;
  }
}

let clientInstance: LldapClient | null = null;
let clientConfigKey: string | null = null;

function getLldapClient(config: LldapConfig): LldapClient {
  const key = JSON.stringify(config);
  if (clientInstance && clientConfigKey === key) {
    return clientInstance;
  }
  clientInstance = new LldapClient(config);
  clientConfigKey = key;
  return clientInstance;
}

/**
 * Get LLDAP client from app config, or null if LDAP is not configured.
 */
export async function getLldapClientFromConfig(): Promise<LldapClient | null> {
  const { getConfig } = await import('@/lib/config');
  const config = await getConfig();
  if (!config.ldap) return null;
  return getLldapClient(config.ldap);
}
