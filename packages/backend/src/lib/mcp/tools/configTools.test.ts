import { describe, it, expect, beforeEach, vi } from 'vitest';
import { REDACTED_SENTINEL, type AppConfig } from '@/lib/config';
import type { ToolServer } from './context';

/**
 * #2404 — `get_config` must never hand a live secret to an LLM tool-caller.
 *
 * The old `sanitizeConfig()` was a three-field denylist (`auth.passwordHash`,
 * `oidc.clientSecret`, `notifications.email.pass`) on a config object whose
 * job includes storing dozens of per-service credentials, so the tool returned
 * `gateway.password`, the whole `installedSecrets[]` array (private keys
 * included), the whole `installManifest.credentials[]` array, `lldap.password`,
 * `adguard.password` and `reverseProxy.npm.password` in plaintext.
 *
 * These tests prove the *negative* — that nothing leaks — the only way a test
 * can: every secret in the fixture is a unique canary string, and the assertion
 * walks the ACTUAL serialized tool output looking for any of them. That catches
 * a leak at any depth, in any shape, including fields this fix has never seen.
 *
 * Every value below is an obviously-fake placeholder. No real secret from any
 * box appears in this file.
 */

const getConfigMock = vi.fn<() => Promise<AppConfig>>();
const updateConfigMock = vi.fn<(patch: Partial<AppConfig>) => Promise<AppConfig>>();

vi.mock('@/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config')>();
  return {
    ...actual,
    getConfig: () => getConfigMock(),
    updateConfig: (patch: Partial<AppConfig>) => updateConfigMock(patch),
  };
});

// --------------------------------------------------------------------------
// Canaries — one unique, obviously-fake string per secret-bearing field.
// --------------------------------------------------------------------------

const CANARY = {
  gatewayPassword: 'CANARY-fake-gateway-pw-01',
  lldapPassword: 'CANARY-fake-lldap-admin-pw-02',
  adguardPassword: 'CANARY-fake-adguard-admin-pw-03',
  npmPassword: 'CANARY-fake-npm-admin-pw-04',
  authPasswordHash: 'CANARY-fake-scrypt-hash-05',
  oidcClientSecret: 'CANARY-fake-oidc-client-secret-06',
  smtpPass: 'CANARY-fake-smtp-pass-07',
  bootstrapTokenHash: 'CANARY-fake-bootstrap-token-hash-08',
  secretLldapJwt: 'CANARY-fake-lldap-jwt-secret-09',
  secretAutheliaStorage: 'CANARY-fake-authelia-storage-enc-10',
  secretVapidPrivateKey: 'CANARY-fake-vapid-private-key-11',
  secretRsaPem: '-----BEGIN RSA PRIVATE KEY-----\nCANARY-fake-authelia-oidc-rsa-12\n-----END RSA PRIVATE KEY-----',
  secretHaToken: 'CANARY-fake-homeassistant-token-13',
  credVaultwarden: 'CANARY-fake-vaultwarden-admin-pw-14',
  credImmichBearer: 'CANARY-fake-immich-bearer-15',
  externalBackupPassword: 'CANARY-fake-nas-ftp-pw-16',
  externalBackupPrivateKey: 'CANARY-fake-sftp-private-key-17',
  backupSmbPassword: 'CANARY-fake-smb-pw-18',
  templateSettingToken: 'CANARY-fake-plex-claim-token-19',
  futureAccessToken: 'CANARY-fake-future-field-apikey-20',
  // #2404 follow-up: credentials embedded in captured post-deploy stdout.
  postDeployNpmPassword: 'CANARY-fake-npm-postdeploy-pw-21',
  postDeployAdguardPassword: 'CANARY-fake-adguard-postdeploy-pw-22',
  postDeployBearerToken: 'CANARY-fake-engine-bearer-token-23',
  migrationSecret: 'CANARY-fake-migration-emitted-secret-24',
  futureTailSecret: 'CANARY-fake-future-tail-secret-25',
};

/**
 * `post-deploy.py` emits credential banners as `__SB_CREDENTIAL__ {json}` lines
 * on stdout (docs/TEMPLATE_LOGGING.md); `persistPostDeployResult` then stores
 * the last ~1KB of that stdout verbatim in `servicePostDeploy[svc].stdoutTail`.
 * This builds a tail of exactly that shape — the leak box-verify found.
 */
function credentialTail(service: string, username: string, password: string): string {
  const blob = JSON.stringify({
    service,
    url: `https://${service}.example.test`,
    username,
    password,
    importance: 'critical',
    notes: 'Seeded by post-deploy.',
  });
  return [
    `[${service}] waiting for container to become healthy…`,
    `__SB_CREDENTIAL__ ${blob}`,
    `[${service}] post-deploy finished`,
  ].join('\n');
}

/** Substrings that must never survive into the tool output. */
const CANARY_NEEDLES = [
  ...Object.values(CANARY).filter(v => !v.includes('BEGIN RSA')),
  'CANARY-fake-authelia-oidc-rsa-12',
  'BEGIN RSA PRIVATE KEY',
];

/**
 * A live-shaped config: every secret-bearing field the issue names, plus the
 * shapes that make a naive substring matcher wrong (service-name-keyed maps
 * like `installedTemplates.keycloak` / `servicePostDeploy.passbolt`).
 */
function buildFixture(): AppConfig {
  const base: AppConfig = {
    logLevel: 'info',
    serverName: 'homebox',
    domain: 'example.test',
    autoUpdate: { enabled: true, schedule: '0 0 * * *' },
    gateway: {
      type: 'fritzbox',
      host: '192.168.178.1',
      username: 'gateway-admin',
      password: CANARY.gatewayPassword,
      ssl: true,
    },
    reverseProxy: {
      publicDomain: 'example.test',
      lanDomain: 'home.arpa',
      lanIp: '192.168.178.20',
      hosts: [
        { domain: 'vault.example.test', service: 'vaultwarden', forwardPort: 8080, created: true },
      ],
      npm: { email: 'npm-admin@example.test', password: CANARY.npmPassword },
    },
    agent: { sessionId: 'session-abc-123', cleanupOrphansOnStart: true },
    templateSettings: {
      LLDAP_SUBDOMAIN: 'ldap',
      HERMES_API_PORT: '8123',
      PLEX_CLAIM_TOKEN: CANARY.templateSettingToken,
    },
    notifications: {
      email: {
        enabled: true,
        host: 'smtp.example.test',
        port: 587,
        secure: true,
        user: 'notify@example.test',
        pass: CANARY.smtpPass,
        from: 'notify@example.test',
        to: ['admin@example.test'],
      },
    },
    auth: {
      username: 'admin',
      passwordHash: CANARY.authPasswordHash,
      bootstrapToken: {
        hash: CANARY.bootstrapTokenHash,
        scope: 'read',
        expiresAt: '2026-07-28T12:00:00Z',
      },
    },
    oidc: {
      enabled: true,
      issuer: 'https://auth.example.test',
      clientId: 'servicebay',
      clientSecret: CANARY.oidcClientSecret,
      allowedGroups: ['admins'],
    },
    lldap: { url: 'http://127.0.0.1:17170', username: 'admin', password: CANARY.lldapPassword },
    adguard: { adminUrl: 'http://127.0.0.1:3000', username: 'admin', password: CANARY.adguardPassword },
    backup: {
      enabled: true,
      schedule: 'daily',
      time: '02:00',
      target: { type: 'smb', host: 'nas.home.arpa', share: 'backups', username: 'nas', password: CANARY.backupSmbPassword },
    },
    externalBackup: {
      enabled: true,
      time: '03:30',
      target: {
        type: 'ssh',
        host: 'nas.home.arpa',
        username: 'nas',
        password: CANARY.externalBackupPassword,
        privateKey: CANARY.externalBackupPrivateKey,
      },
    },
    installedSecrets: [
      { varName: 'LLDAP_JWT_SECRET', password: CANARY.secretLldapJwt },
      { varName: 'AUTHELIA_STORAGE_ENCRYPTION_KEY', password: CANARY.secretAutheliaStorage },
      { varName: 'VAPID_PRIVATE_KEY', password: CANARY.secretVapidPrivateKey },
      { varName: 'AUTHELIA_OIDC_ISSUER_PRIVATE_KEY', password: CANARY.secretRsaPem },
      { varName: 'HOMEASSISTANT_LLAT', password: CANARY.secretHaToken },
    ],
    installManifest: {
      savedAt: '2026-07-25T10:00:00Z',
      credentials: [
        {
          service: 'vaultwarden',
          url: 'https://vault.example.test',
          username: 'admin',
          password: CANARY.credVaultwarden,
          importance: 'critical',
        },
        {
          service: 'immich',
          url: 'https://photos.example.test',
          username: 'api',
          password: CANARY.credImmichBearer,
          importance: 'system',
          notes: 'bearer token for the API',
        },
      ],
    },
    // Service-name-keyed maps: `keycloak` contains "key", `passbolt` contains
    // "pass". Neither is a secret and both must survive intact.
    installedTemplates: {
      keycloak: { schemaVersion: 2, installedAt: '2026-07-01T00:00:00Z' },
      vaultwarden: { schemaVersion: 1, installedAt: '2026-07-02T00:00:00Z' },
    },
    // Captured post-deploy stdout. `passbolt` is the service-name-shaped
    // negative (its NAME contains "pass"); the other three carry real-shaped
    // `__SB_CREDENTIAL__` banners inside the tail string, which is how live
    // credentials survived the key-name-only scrub.
    servicePostDeploy: {
      passbolt: { lastRunAt: '2026-07-20T00:00:00Z', exitCode: 0, stdoutTail: 'seed ok' },
      nginx: {
        lastRunAt: '2026-07-21T00:00:00Z',
        exitCode: 0,
        stdoutTail: credentialTail('nginx', 'npm-admin@example.test', CANARY.postDeployNpmPassword),
      },
      adguard: {
        lastRunAt: '2026-07-22T00:00:00Z',
        exitCode: 1,
        stdoutTail: credentialTail('adguard', 'admin', CANARY.postDeployAdguardPassword),
      },
      honcho: {
        lastRunAt: '2026-07-23T00:00:00Z',
        exitCode: 0,
        stdoutTail: `__SB_CREDENTIAL__ ${JSON.stringify({
          service: 'Honcho engine',
          url: 'env: HONCHO_BEARER',
          username: '—',
          password: CANARY.postDeployBearerToken,
          importance: 'system',
        })}`,
      },
    },
    // Migration-script stdout is captured the same way, into the same key name.
    serviceMigrations: {
      immich: [
        {
          ranAt: '2026-07-24T00:00:00Z',
          fromVersion: 1,
          toVersion: 2,
          exitCode: 0,
          stdoutTail: credentialTail('immich', 'api', CANARY.migrationSecret),
        },
      ],
    },
    accessRequests: [
      {
        id: 'req-1',
        requestedAt: '2026-07-20T00:00:00Z',
        name: 'Ada Lovelace',
        email: 'ada@example.test',
        status: 'pending',
      },
    ],
    setupCompleted: true,
  };

  // A secret-bearing field shaped like one somebody adds to AppConfig *later*:
  // the scrubber has never seen it and must still catch it structurally.
  return {
    ...base,
    futureIntegration: {
      endpoint: 'https://api.example.test',
      accessToken: CANARY.futureAccessToken,
      // Neither a secret-shaped key nor `stdoutTail` — only the VALUE gives it
      // away. The marker backstop is what has to catch this one.
      lastRunSummary: credentialTail('future-service', 'svc', CANARY.futureTailSecret),
    },
  } as unknown as AppConfig;
}

// --------------------------------------------------------------------------
// Harness — register the real tools against a capturing stub server so the
// assertions run over the ACTUAL tool output, not a hand-rolled copy of it.
// --------------------------------------------------------------------------

interface CapturedTool {
  description: string;
  schema: Record<string, unknown>;
  handler: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

const tools = new Map<string, CapturedTool>();

const stubServer: ToolServer = {
  tool(name: string, description: string, schema: Record<string, unknown>, handler: CapturedTool['handler']) {
    tools.set(name, { description, schema, handler });
    return undefined;
  },
};

beforeEach(async () => {
  tools.clear();
  getConfigMock.mockReset();
  updateConfigMock.mockReset();
  const { registerConfigTools } = await import('./configTools');
  registerConfigTools({ server: stubServer });
});

async function callGetConfig(cfg: AppConfig): Promise<{ text: string; parsed: Record<string, unknown> }> {
  getConfigMock.mockResolvedValue(cfg);
  const tool = tools.get('get_config');
  if (!tool) throw new Error('get_config was not registered');
  const result = await tool.handler();
  const text = result.content[0].text;
  return { text, parsed: JSON.parse(text) as Record<string, unknown> };
}

/** Every primitive value in the tree, with its dotted path. */
function walkValues(value: unknown, path = '$'): Array<{ path: string; value: unknown }> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, i) => walkValues(entry, `${path}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, val]) => walkValues(val, `${path}.${key}`));
  }
  return [{ path, value }];
}

/** Look up a dotted path in the parsed output. */
function at(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

// --------------------------------------------------------------------------

describe('get_config secret scrubbing (#2404)', () => {
  it('leaks none of the fixture secrets anywhere in the serialized output', async () => {
    const { text } = await callGetConfig(buildFixture());
    const leaked = CANARY_NEEDLES.filter(needle => text.includes(needle));
    expect(leaked).toEqual([]);
  });

  it('leaks no secret value at any depth of the parsed output', async () => {
    const { parsed } = await callGetConfig(buildFixture());
    const offenders = walkValues(parsed)
      .filter(({ value }) => typeof value === 'string' && CANARY_NEEDLES.some(n => value.includes(n)))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  // The nine fields the issue names, checked one by one at their real paths.
  it.each([
    ['gateway.password', 'gateway.password'],
    ['lldap.password', 'lldap.password'],
    ['adguard.password', 'adguard.password'],
    ['reverseProxy.npm.password', 'reverseProxy.npm.password'],
    ['auth.passwordHash', 'auth.passwordHash'],
    ['oidc.clientSecret', 'oidc.clientSecret'],
    ['notifications.email.pass', 'notifications.email.pass'],
  ])('redacts %s', async (_label, path) => {
    const { parsed } = await callGetConfig(buildFixture());
    expect(at(parsed, path)).toBe(REDACTED_SENTINEL);
  });

  it('replaces installedSecrets wholesale with a count, not entries', async () => {
    const { parsed } = await callGetConfig(buildFixture());
    expect(parsed.installedSecrets).toBe(`${REDACTED_SENTINEL} (5 entries)`);
  });

  it('replaces installManifest.credentials wholesale but keeps savedAt', async () => {
    const { parsed } = await callGetConfig(buildFixture());
    expect(at(parsed, 'installManifest.credentials')).toBe(`${REDACTED_SENTINEL} (2 entries)`);
    expect(at(parsed, 'installManifest.savedAt')).toBe('2026-07-25T10:00:00Z');
  });

  // Fields the old three-field denylist never covered, including nested and
  // never-before-seen shapes — these are what the structural fix buys.
  it.each([
    ['auth.bootstrapToken (object holding a token hash)', 'auth.bootstrapToken', `${REDACTED_SENTINEL} (3 fields)`],
    ['backup.target.password', 'backup.target.password', REDACTED_SENTINEL],
    ['externalBackup.target.password', 'externalBackup.target.password', REDACTED_SENTINEL],
    ['externalBackup.target.privateKey', 'externalBackup.target.privateKey', REDACTED_SENTINEL],
    ['a secret-named templateSettings entry', 'templateSettings.PLEX_CLAIM_TOKEN', REDACTED_SENTINEL],
    ['a future field the fix has never seen', 'futureIntegration.accessToken', REDACTED_SENTINEL],
  ])('redacts %s', async (_label, path, expected) => {
    const { parsed } = await callGetConfig(buildFixture());
    expect(at(parsed, path)).toBe(expected);
  });

  it('keeps every non-secret field intact', async () => {
    const { parsed } = await callGetConfig(buildFixture());
    expect(parsed.logLevel).toBe('info');
    expect(parsed.serverName).toBe('homebox');
    expect(parsed.domain).toBe('example.test');
    expect(parsed.setupCompleted).toBe(true);
    expect(parsed.autoUpdate).toEqual({ enabled: true, schedule: '0 0 * * *' });
    expect(at(parsed, 'gateway.host')).toBe('192.168.178.1');
    expect(at(parsed, 'gateway.username')).toBe('gateway-admin');
    expect(at(parsed, 'reverseProxy.publicDomain')).toBe('example.test');
    expect(at(parsed, 'reverseProxy.npm.email')).toBe('npm-admin@example.test');
    expect(at(parsed, 'reverseProxy.hosts')).toEqual([
      { domain: 'vault.example.test', service: 'vaultwarden', forwardPort: 8080, created: true },
    ]);
    expect(at(parsed, 'agent.sessionId')).toBe('session-abc-123');
    expect(at(parsed, 'notifications.email.host')).toBe('smtp.example.test');
    expect(at(parsed, 'notifications.email.to')).toEqual(['admin@example.test']);
    expect(at(parsed, 'auth.username')).toBe('admin');
    expect(at(parsed, 'oidc.issuer')).toBe('https://auth.example.test');
    expect(at(parsed, 'oidc.clientId')).toBe('servicebay');
    expect(at(parsed, 'lldap.url')).toBe('http://127.0.0.1:17170');
    expect(at(parsed, 'adguard.username')).toBe('admin');
    expect(at(parsed, 'backup.target.host')).toBe('nas.home.arpa');
    expect(at(parsed, 'templateSettings.LLDAP_SUBDOMAIN')).toBe('ldap');
    expect(at(parsed, 'accessRequests')).toEqual([
      {
        id: 'req-1',
        requestedAt: '2026-07-20T00:00:00Z',
        name: 'Ada Lovelace',
        email: 'ada@example.test',
        status: 'pending',
      },
    ]);
  });

  // Over-redaction is a correctness bug too. Service names are arbitrary and
  // several real ones contain "key"/"pass".
  it('does not redact service-name-keyed records whose name contains a secret word', async () => {
    const { parsed } = await callGetConfig(buildFixture());
    expect(at(parsed, 'installedTemplates.keycloak')).toEqual({ schemaVersion: 2, installedAt: '2026-07-01T00:00:00Z' });
    // `passbolt` survives as a record (the key is a service name, not a secret);
    // only its captured stdout is withheld.
    expect(at(parsed, 'servicePostDeploy.passbolt')).toEqual({
      lastRunAt: '2026-07-20T00:00:00Z',
      exitCode: 0,
      stdoutTail: REDACTED_SENTINEL,
    });
  });

  it('preserves the "not configured" signal instead of masking it', async () => {
    const fixture = buildFixture();
    fixture.oidc!.clientSecret = '';
    delete fixture.gateway!.password;
    const { parsed } = await callGetConfig(fixture);
    expect(at(parsed, 'oidc.clientSecret')).toBe('');
    expect(at(parsed, 'gateway')).not.toHaveProperty('password');
  });

  it('does not mutate the config it was handed', async () => {
    const fixture = buildFixture();
    await callGetConfig(fixture);
    expect(fixture.gateway?.password).toBe(CANARY.gatewayPassword);
    expect(fixture.installedSecrets).toHaveLength(5);
  });

  it('describes itself accurately — no "3 fields" claim in the tool description', async () => {
    const description = tools.get('get_config')?.description ?? '';
    expect(description).toMatch(/redact/i);
    expect(description).toMatch(/installedSecrets/);
  });
});

/**
 * #2404 follow-up — the key-name scrubber shipped, then box-verify found live
 * credentials still leaving the box inside `servicePostDeploy[*].stdoutTail`:
 * captured `post-deploy.py` stdout, whose KEY name is innocuous but whose
 * string CONTENT embeds `__SB_CREDENTIAL__ {json}` banners with usable
 * passwords and bearer tokens. Same shape applies to
 * `serviceMigrations[*][].stdoutTail`.
 */
describe('get_config withholds captured script output (#2404 follow-up)', () => {
  it('leaves no __SB_CREDENTIAL__ marker anywhere in the serialized output', async () => {
    const { text } = await callGetConfig(buildFixture());
    expect(text).not.toContain('__SB_CREDENTIAL__');
  });

  it('withholds every servicePostDeploy stdoutTail, secret-bearing or not', async () => {
    const { parsed } = await callGetConfig(buildFixture());
    const records = parsed.servicePostDeploy as Record<string, Record<string, unknown>>;
    expect(Object.keys(records).sort()).toEqual(['adguard', 'honcho', 'nginx', 'passbolt']);
    for (const [service, record] of Object.entries(records)) {
      expect(record.stdoutTail, `servicePostDeploy.${service}.stdoutTail`).toBe(REDACTED_SENTINEL);
    }
  });

  it('keeps lastRunAt and exitCode so "did post-deploy succeed" is still answerable', async () => {
    const { parsed } = await callGetConfig(buildFixture());
    expect(at(parsed, 'servicePostDeploy.nginx.lastRunAt')).toBe('2026-07-21T00:00:00Z');
    expect(at(parsed, 'servicePostDeploy.nginx.exitCode')).toBe(0);
    expect(at(parsed, 'servicePostDeploy.adguard.lastRunAt')).toBe('2026-07-22T00:00:00Z');
    expect(at(parsed, 'servicePostDeploy.adguard.exitCode')).toBe(1);
    expect(at(parsed, 'servicePostDeploy.passbolt.exitCode')).toBe(0);
  });

  it('withholds migration-script stdoutTail but keeps the version delta', async () => {
    const { parsed } = await callGetConfig(buildFixture());
    const entries = at(parsed, 'serviceMigrations.immich') as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      ranAt: '2026-07-24T00:00:00Z',
      fromVersion: 1,
      toVersion: 2,
      exitCode: 0,
      stdoutTail: REDACTED_SENTINEL,
    });
  });

  it('catches a credential banner in a field whose key is not secret-shaped', async () => {
    const { parsed } = await callGetConfig(buildFixture());
    expect(at(parsed, 'futureIntegration.lastRunSummary')).toBe(REDACTED_SENTINEL);
  });

  it('redacts a PEM private key found in a string value at any key', async () => {
    const fixture = buildFixture() as unknown as Record<string, unknown>;
    fixture.someNote = '-----BEGIN OPENSSH PRIVATE KEY-----\nCANARY-fake-pem-in-a-note\n-----END OPENSSH PRIVATE KEY-----';
    const { parsed, text } = await callGetConfig(fixture as unknown as AppConfig);
    expect(parsed.someNote).toBe(REDACTED_SENTINEL);
    expect(text).not.toContain('PRIVATE KEY-----');
  });

  it('leaves an ordinary stdout tail-free record untouched', async () => {
    const fixture = buildFixture();
    fixture.servicePostDeploy = { media: { lastRunAt: '2026-07-25T00:00:00Z', exitCode: 0 } };
    const { parsed } = await callGetConfig(fixture);
    expect(at(parsed, 'servicePostDeploy.media')).toEqual({
      lastRunAt: '2026-07-25T00:00:00Z',
      exitCode: 0,
    });
  });

  it('announces the withholding in the tool description', async () => {
    const description = tools.get('get_config')?.description ?? '';
    expect(description).toMatch(/stdoutTail/);
  });
});

describe('isSecretKey (#2404)', () => {
  it.each([
    'password', 'passwd', 'pass', 'passphrase', 'passwordHash',
    'secret', 'clientSecret', 'installedSecrets', 'credentials',
    'token', 'bootstrapToken', 'accessToken', 'PLEX_CLAIM_TOKEN',
    'key', 'apiKey', 'apikey', 'privateKey', 'privatekey', 'apiKeys',
    'VAPID_PRIVATE_KEY', 'AUTHELIA_STORAGE_ENCRYPTION_KEY',
    'hash', 'salt', 'bearer', 'client-secret', 'api_key',
  ])('treats %s as secret', async (key) => {
    const { isSecretKey } = await import('../redact');
    expect(isSecretKey(key)).toBe(true);
  });

  it.each([
    // Service names that merely contain a secret word.
    'keycloak', 'passbolt', 'vaultwarden', 'paperless', 'immich',
    // Real non-secret AppConfig fields.
    'sessionId', 'identityFile', 'serverName', 'sslConfigured', 'lastMessage',
    'schemaVersion', 'dayOfWeek', 'installedTemplates', 'servicePostDeploy',
    'templateSettings', 'publicDomain', 'lanIpHistory', 'accessRequests',
    'importance', 'notes', 'savedAt', 'allowDangerousExec', 'bypass',
    // Why the follow-up fix needs its own layer: the key name is innocuous,
    // only the captured stdout it holds is dangerous.
    'stdoutTail', 'ranAt', 'fromVersion', 'exitCode', 'lastRunAt',
  ])('does not treat %s as secret', async (key) => {
    const { isSecretKey } = await import('../redact');
    expect(isSecretKey(key)).toBe(false);
  });
});

describe('update_config write allowlist is unaffected (#2404 is read-path only)', () => {
  const patchSchema = () => {
    const schema = tools.get('update_config')?.schema.patch;
    if (!schema) throw new Error('update_config patch schema missing');
    return schema as { safeParse: (v: unknown) => { success: boolean } };
  };

  it.each([
    ['logLevel', { logLevel: 'debug' }],
    ['serverName', { serverName: 'newbox' }],
    ['domain', { domain: 'new.test' }],
    ['autoUpdate', { autoUpdate: { enabled: false } }],
    ['templateSettings', { templateSettings: { FOO: 'bar' } }],
  ])('still accepts %s', (_label, patch) => {
    expect(patchSchema().safeParse(patch).success).toBe(true);
  });

  it.each([
    ['auth', { auth: { passwordHash: 'x' } }],
    ['oidc', { oidc: { clientSecret: 'x' } }],
    ['notifications', { notifications: { email: { pass: 'x' } } }],
    ['gateway', { gateway: { password: 'x' } }],
    ['installedSecrets', { installedSecrets: [] }],
    ['installManifest', { installManifest: { savedAt: 'x', credentials: [] } }],
    ['lldap', { lldap: { password: 'x' } }],
  ])('still rejects %s', (_label, patch) => {
    expect(patchSchema().safeParse(patch).success).toBe(false);
  });

  it('writes only the allowlisted fields through to updateConfig', async () => {
    const fixture = buildFixture();
    getConfigMock.mockResolvedValue(fixture);
    updateConfigMock.mockResolvedValue({ ...fixture, serverName: 'newbox' });
    const tool = tools.get('update_config');
    if (!tool) throw new Error('update_config was not registered');

    await tool.handler({ patch: { serverName: 'newbox', autoUpdate: { enabled: false } } });

    expect(updateConfigMock).toHaveBeenCalledTimes(1);
    expect(updateConfigMock.mock.calls[0][0]).toEqual({
      serverName: 'newbox',
      autoUpdate: { enabled: false, schedule: '0 0 * * *' },
    });
  });

  it('scrubs the config it echoes back after a write', async () => {
    const fixture = buildFixture();
    getConfigMock.mockResolvedValue(fixture);
    updateConfigMock.mockResolvedValue(fixture);
    const tool = tools.get('update_config');
    if (!tool) throw new Error('update_config was not registered');

    const result = await tool.handler({ patch: { serverName: 'newbox' } });
    const text = result.content[0].text;
    expect(CANARY_NEEDLES.filter(needle => text.includes(needle))).toEqual([]);
  });
});
