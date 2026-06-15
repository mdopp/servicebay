import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR } from './dirs';
import { atomicWriteFile } from './util/atomicWrite';
import { decrypt, encrypt } from './secrets';
import { LogLevel } from './logger';
import { PortMapping as GraphPortMapping } from './network/types';
import { normalizeExternalTargets } from './network/externalLinks';
import { ConfigTransformer } from './config/transformer';
import type { BackupConfig } from './backup/types';
import type { MigrationAuditEntry } from './stackInstall/auditTypes';
import { logger } from './logger';

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export interface ExternalLink {
  id: string;
  name: string;
  url: string;
  description?: string;
  icon?: string;
  monitor?: boolean;
  ipTargets?: string[];
  ports?: GraphPortMapping[];
}

export interface RegistryConfig {
  name: string;
  url: string;
  branch?: string;
}

export interface RegistriesSettings {
  enabled: boolean;
  items: RegistryConfig[];
}

export interface GatewayConfig {
  type: 'fritzbox';
  host: string;
  username?: string;
  password?: string;
  ssl?: boolean;
}

/**
 * Destination for the config-survival backups (#1527). Mirrors the spirit of
 * Backup Sync's `BackupTarget`, but constrained to the transports the
 * config-survival layer actually speaks (it transfers in-memory tar buffers,
 * not an rsync of a mounted path):
 *  - `fritzbox` — the FritzBox USB NAS over FTP. Host/credentials default to
 *    `config.gateway`; the optional `host`/`username`/`password` fields let an
 *    operator override them (e.g. a dedicated FRITZ.NAS user) without touching
 *    the TR-064 gateway creds.
 *  - `ftp` — a standalone FTP(S) server (not the FritzBox).
 *  - `ssh` — an SFTP server (key- or password-auth).
 * `dir` is the remote base directory under which `sb-backup/` is created
 * (defaults to the server's login directory when omitted).
 */
export type ExternalBackupTarget =
  | { type: 'fritzbox'; host?: string; username?: string; password?: string; secure?: boolean }
  | { type: 'ftp'; host: string; port?: number; username: string; password: string; secure?: boolean; dir?: string }
  | { type: 'ssh'; host: string; port?: number; username: string; password?: string; privateKey?: string; dir?: string };

export interface ProxyHostEntry {
  /** Full domain, e.g. "vault.dopp.cloud" */
  domain: string;
  /** Service template name, e.g. "vaultwarden" */
  service: string;
  /** Target port on the node */
  forwardPort: number;
  /** Whether the NPM proxy host was created successfully */
  created: boolean;
  /** Whether SSL (Let's Encrypt) has been configured */
  sslConfigured?: boolean;
  /** Timestamp of creation */
  createdAt?: string;
  /**
   * Operator-facing intent: `public` services are meant to be
   * reachable from the internet (Let's Encrypt cert at install time,
   * public DNS A-record at the operator's registrar), `lan` services
   * are LAN-only (no public DNS record needed; AdGuard's wildcard
   * `*.<publicDomain> → <lanIp>` handles internal resolution). The
   * field is persisted here so the continuous `domain` health check
   * and the diagnose probes can decide:
   *   - the expected scheme for the NPM probe (`https` for public,
   *     `http` for LAN — NPM's ssl_forced only fires for public),
   *   - whether to bother letsdebug.net with this domain (skipped
   *     entirely for `lan` since it'll never have a public record).
   * Missing on entries that pre-date this field; treat as `lan` so
   * the conservative default applies. See VariableMeta.exposure for
   * the three-tier semantics.
   */
  exposure?: 'public' | 'internal' | 'lan';
}

export interface ReverseProxyConfig {
  /** Public domain used for subdomains (e.g. "dopp.cloud") */
  publicDomain?: string;
  /**
   * LAN domain (RFC 8375 reserved `home.arpa` by default) — services
   * are reachable on `<sub>.<lanDomain>` via AdGuard DNS rewrites in
   * `lan` install mode. Used as a fallback when `publicDomain` isn't
   * set, and as a survives-after-migration fallback in `public` mode
   * (LAN devices can keep hitting `vault.home.arpa` after the user
   * switches to a public domain — soft-handoff per #249).
   */
  lanDomain?: string;
  /**
   * ServiceBay's LAN IP — the address AdGuard rewrites point at.
   * Set to the install-time detected IP and reconciled on every boot
   * (#266). Stale entries auto-update; a `lan_ip_changed_since_install`
   * probe surfaces when the IP differs from install-time so the user
   * can set up a DHCP reservation if it keeps drifting.
   */
  lanIp?: string;
  /**
   * Historical record of LAN IP changes. Each entry is
   * `{ ip, detectedAt }`. Used by the diagnose probe to decide
   * `info` vs `warn` (more than 1 change in 30 days = unstable).
   */
  lanIpHistory?: Array<{ ip: string; detectedAt: string }>;
  /**
   * ISO timestamp set when the operator clicks "I'll handle it
   * manually" on the `router_dns_not_pointing` probe. Re-checks
   * resume 30 days after this timestamp. See D19-PR6 / #263.
   */
  routerDnsDismissedAt?: string;
  /** Proxy hosts created during stack deployment */
  hosts?: ProxyHostEntry[];
  /**
   * NPM (Nginx Proxy Manager) admin credentials. When set, ServiceBay reuses
   * them to auto-sync proxy routes during service install/update without
   * prompting the user. Leave unset to fall back to NPM's default creds
   * (admin@example.com / changeme) — which only work before the NPM admin
   * password is changed.
   */
  npm?: {
    email: string;
    password: string;
  };
}

interface AgentRestartSchedule {
  enabled: boolean;
  time: string; // HH:MM (UTC)
  timezone?: string;
}

interface AgentProcessCleanup {
  enabled: boolean;
  dryRun?: boolean;
  maxAgeMinutes?: number;
}

export interface AgentConfig {
  sessionId?: string; // Read-only, auto-generated at server startup
  cleanupOrphansOnStart?: boolean;
  restartSchedule?: AgentRestartSchedule;
  gracefulShutdownTimeout?: number; // seconds
  processCleanup?: AgentProcessCleanup;
}

export interface AppConfig {
  /**
   * Schema version of the persisted `config.json` document (#1099 Phase 1).
   * `1` is the baseline — every shape that existed before this field was
   * introduced. Future breaking changes bump this number and add a
   * migration step to Phase 2's migration ledger; on startup the ledger
   * walks from the persisted version to `CURRENT_SCHEMA_VERSION`.
   *
   * Optional in the interface because legacy configs persisted before
   * this PR don't carry the field — the ConfigTransformer below stamps
   * them with `1` on first read so downstream code can rely on
   * `getSchemaVersion()` returning a number.
   */
  schemaVersion?: number;
  logLevel?: LogLevel;
  serverName?: string; // Custom display name for this server
  domain?: string; // Optional domain for display
  gateway?: GatewayConfig;
  reverseProxy?: ReverseProxyConfig;
  agent?: AgentConfig;
  templateSettings?: Record<string, string>;
  autoUpdate: {
    enabled: boolean;
    schedule: string; // Cron syntax, e.g. "0 0 * * *" for midnight
    /**
     * Last version we emailed the operator about. Used to dedupe so the
     * update notifier sends one email per release, not one per check tick.
     * Written by the in-process notifier; read on every check.
     */
    lastNotifiedVersion?: string;
    /**
     * Manifest digest of the `:latest` image that is currently applied (the
     * one a successful `performUpdate` pull last advanced us to). Used to gate
     * "update available" on the image actually being newer than what we run —
     * a release tag is cut *before* the `:latest` image is built+pushed, so a
     * tag-ahead-but-digest-unchanged state means "new version still building",
     * not "available". Written after a successful pull; null until first seen.
     */
    appliedImageDigest?: string;
  };
  /**
   * Unified auto-update window. ServiceBay manages three independent
   * sources of "the host may restart now": Zincati (OS updates, host
   * reboot), `podman-auto-update.timer` (container image refresh,
   * per-service restart), and the ServiceBay app itself. By default
   * each fires on its own clock, which is disruptive on a family-
   * visible appliance. This config gives the operator one quiet slot
   * and selectively applies it to each source.
   *
   * State machine:
   *   - `undefined` (fresh install, operator hasn't decided): we
   *     treat as "safety lock — no auto-updates anywhere". On boot
   *     ServiceBay writes `[updates] enabled = false` to Zincati and
   *     masks `podman-auto-update.timer`. This is the defence
   *     against the "FCoS auto-updated mid-install, host rebooted,
   *     and the USB install stick was still inserted → re-imaged
   *     from scratch" foot-gun.
   *   - `{ enabled: false }` (operator explicitly opted out): same as
   *     undefined — keep the locks. The wrapper exists so the UI can
   *     remember the operator's most-recent days/time selection if
   *     they toggle back on.
   *   - `{ enabled: true, ... }`: render drop-ins for whichever
   *     `applyTo.*` flags are on; leave the others locked (or, if
   *     the operator chose not to apply, unlocked at their default).
   */
  updateWindow?: {
    enabled: boolean;
    days: Array<'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'>;
    /** 24-h `HH:MM`, UTC. */
    startTime: string;
    /** Length of the maintenance window in minutes. Min 30, max 1440. */
    lengthMinutes: number;
    /**
     * Which restart sources the window applies to. Operators can
     * defer OS reboots while letting container images auto-refresh
     * (or vice-versa). `servicebay` is the ServiceBay-app updater
     * itself — today it only sends notifications and applies on
     * manual click, so this flag is forward-looking infrastructure.
     */
    applyTo: {
      os: boolean;
      containers: boolean;
      servicebay: boolean;
    };
  };
  registries?: RegistriesSettings;
  externalLinks?: ExternalLink[];
  mcp?: {
    /**
     * Master gate for write/mutating MCP tools. When false, MCP clients can
     * read state (`list_*`, `get_*`) but cannot start/stop/restart, deploy,
     * delete, exec, or restore.
     *
     * Default policy:
     *   - Fresh install (wizard sets this explicitly): false  — read-only.
     *   - Pre-existing install (field absent in config.json): treated as
     *     true so we don't break MCP clients that worked before this flag
     *     was introduced. The Settings UI still shows the toggle.
     */
    allowMutations?: boolean;
    /**
     * Bypass the exec_command denylist (rm -rf /, mkfs, dd of=/dev/sd*, …).
     * Off by default. Lift only if you genuinely need to run dangerous
     * commands through MCP — note that `allowMutations` must also be true.
     */
    allowDangerousExec?: boolean;
  };
  notifications?: {
    email?: {
      enabled: boolean;
      host: string;
      port: number;
      secure: boolean;
      user: string;
      pass: string;
      from: string;
      to: string[];
    };
  };
  auth?: {
    username?: string;
    /** scrypt-encoded password hash. Use hashPassword() to produce. */
    passwordHash?: string;
    /**
     * One-shot LAN-only bootstrap token for MCP. The operator types it
     * into the install wizard (`install-fedora-coreos.sh`); the script
     * SHA-256s the cleartext and persists only the hash here. The
     * server never sees the cleartext.
     *
     * Used to bootstrap MCP-based diagnostics during the install
     * window — before the operator has logged into the dashboard to
     * mint their first scoped token. Lifecycle:
     *
     *   - install: hash written, no expiresAt yet
     *   - first server boot that observes a hash with no expiresAt:
     *     persist `expiresAt = now + 30 min`
     *   - first dashboard-minted MCP token: entire entry deleted
     *   - operator clicks "revoke bootstrap token": same, immediate
     *
     * Validation requires the request originate from RFC1918 / loopback
     * (see src/lib/mcp/bootstrapToken.ts) and current time < expiresAt.
     * See #322.
     */
    bootstrapToken?: {
      /** sha256(cleartext) hex, written by the install script */
      hash: string;
      /** Always 'read' — the only scope this token gets */
      scope: 'read';
      /** Lazy-initialized at first boot to install + 30 min */
      expiresAt?: string;
    };
  };
  oidc?: {
    enabled: boolean;
    issuer: string;
    clientId: string;
    clientSecret: string;
    allowedGroups?: string[];
  };
  backup?: BackupConfig;
  /**
   * Nightly per-service config backup to an external NAS (#1217, epic #1190).
   * Separate from `backup` (the full snapshot to the local backup target): this
   * is the lightweight config-survival push. Defaults to enabled at 03:30 UTC;
   * the cron skips quietly when no reachable target is configured.
   *
   * `target` is the destination (#1527). When absent it defaults to the
   * FritzBox NAS over FTP derived from `config.gateway` — so existing boxes are
   * unaffected. An explicit `fritzbox` target can override the gateway's
   * host/credentials (#1525: one place to enter FritzBox creds, NAS defaults to
   * the gateway). An `ftp` target points at a separate FTP host.
   */
  externalBackup?: {
    enabled: boolean;
    /** Daily run time in 24h `HH:MM` UTC. */
    time?: string;
    /** How many dated snapshots to keep per service before pruning the oldest
     *  (#1865). Bounded so the NAS can't fill; defaults to 7 when unset. */
    retention?: number;
    target?: ExternalBackupTarget;
  };
  /**
   * LLDAP admin credentials, persisted by the install wizard so the user can
   * retrieve their auto-generated admin password from Settings → Integrations
   * after first install. Mirrors the `reverseProxy.npm` pattern.
   */
  lldap?: {
    url: string;
    username: string;
    password: string;
  };
  /**
   * AdGuard Home admin credentials, persisted by the AdGuard post-deploy
   * after a successful login probe. ServiceBay reads these when it needs
   * to manage DNS rewrites (split-horizon wildcards for the LAN + public
   * domains, FritzBox-DNS hand-off probe), without prompting the operator
   * again. Same trust class as `reverseProxy.npm` and `lldap`.
   */
  adguard?: {
    adminUrl: string;
    username: string;
    password: string;
  };
  setupCompleted?: boolean;
  stackSetupPending?: boolean;
  /**
   * Hermes maintenance-chat state (#1754, epic #1704). The Hermes API
   * connection itself (loopback port + bearer key) is NOT stored here —
   * the port comes from `templateSettings.HERMES_API_PORT` and the key
   * from `installedSecrets.HERMES_API_KEY` (encrypted at rest, server-side
   * only, never sent to the browser). This block holds only the id of the
   * single designated maintenance session so it's stable across calls.
   */
  hermes?: {
    /** Id of the persistent admin-for-families maintenance session. */
    maintenanceSessionId?: string;
  };
  /**
   * Set by `setup-config-merge.service` on re-install when an existing
   * config.json was merged with a freshly-staged ISO config. The
   * dashboard reads `reinstall.completedAt` to show a "Welcome back —
   * services restoring" banner so an operator who just re-flashed
   * doesn't stare at "Loading services…" with no signal that work is
   * happening in the background. Cleared via `POST
   * /api/system/reinstall/ack` (operator dismissal) or by auto-decay
   * once the timestamp is older than 10 min. See #337.
   *
   * Absent on a true fresh install (the promote-in-place branch of
   * setup-config-merge skips it).
   */
  reinstall?: {
    completedAt: string;
  };
  /**
   * Per-service record of the last `post-deploy.py` run. Written by
   * `ServiceManager.runPostDeployScript` after every run; read by the
   * `post_deploy_failed` probe (B8 / #241) so it can surface
   * "Re-run post-install" actions instead of letting silent seed
   * failures linger. See #252.
   *
   * Key is the template/service name (e.g. `vaultwarden`, `auth`).
   * `stdoutTail` is bounded to ~1KB so config.json stays small.
   */
  servicePostDeploy?: Record<string, ServicePostDeployRecord>;
  /**
   * Per-service record of the template-schema-version that was
   * deployed. Updated by `ServiceManager.deployKubeService` whenever a
   * deploy succeeds, so the next deploy can detect a breaking-change
   * delta and surface the CHANGELOG section to the operator before
   * applying it. See #353 / #354 / #352 (template upgrade system).
   *
   * Key is the template/service name. Absence means the service was
   * deployed before this tracking field existed — the update flow
   * treats that as "v1" so a v1→v2 bump still prompts.
   */
  installedTemplates?: Record<string, { schemaVersion: number; installedAt: string }>;
  /**
   * Per-service audit log of template migration script runs. Each
   * entry is appended by `ServiceManager.runMigrationScript` when a
   * deploy detects a schema-version delta and walks the migration
   * chain. Failed migrations stay in the log so the diagnose page
   * can surface them. See #352 phase 3.
   *
   * Key is the template/service name; value is the append-only run
   * history (most recent migration first). Bounded to the last 20
   * entries per service so config.json stays small.
   */
  serviceMigrations?: Record<string, MigrationAuditEntry[]>;
  /**
   * Credentials the install wizard saved for later retrieval (#19/A1).
   * Persisted at the end of every install so the operator can come
   * back to "what's the LLDAP admin password" days later without
   * having to keep the install log open. Encrypted at rest via the
   * existing `SENSITIVE_KEYS` regex on the password field.
   */
  installManifest?: InstallManifest;
  /**
   * Internal: every `type: secret | bcrypt | rsa-private` variable value
   * from the most recent install, keyed by template-variable name. Used
   * by the install runner to reuse passwords across clean-installs that
   * preserve secrets/identity — without this, the wizard regenerates
   * `LLDAP_ADMIN_PASSWORD` etc. on every run and the new value mismatches
   * the still-on-disk LDAP DB hash. Per-entry `password` field auto-
   * encrypts via the SENSITIVE_KEYS regex; the `varName` is plaintext.
   * Distinct from `installManifest.credentials` (user-facing) — that
   * indexes by display name and skips internal-only secrets like
   * `LLDAP_JWT_SECRET`.
   */
  installedSecrets?: Array<{ varName: string; password: string }>;
  /**
   * Anonymous "request access" submissions from the family portal
   * (#242). Public POST endpoint appends here; admin Settings page
   * reads + resolves. Capped at 50 pending so spam can't fill the
   * disk.
   */
  accessRequests?: AccessRequest[];
  /**
   * Max users allowed = approved LLDAP users + pending access requests.
   * New portal access requests are rejected once the count reaches this.
   * Default 20 when unset; set lower (e.g. 5) for a small household. (#1426)
   */
  maxUsers?: number;
  /**
   * When true, the family `/portal` page only renders for LAN-shaped
   * clients (loopback / RFC1918 / ULA); public visitors get a short
   * "available on the home network only" notice instead of the service
   * grid. App-level gate (the page reads the request's real client IP);
   * the request-access POST endpoint stays reachable so the cap and
   * anti-spam guards remain the public surface. Default off. (#1456)
   */
  portalLanOnly?: boolean;
  /**
   * Per-job log caps (#1098 Phase 1). Long-running installs and noisy
   * mass deploys can balloon `logs.db` without bound; these limits
   * give the logger a hard ceiling per job. Phase 2 wires the rotation
   * + `[TRUNCATED]` summary in `logger.ts`; this PR is just the
   * config surface so operators can set their own limits ahead of the
   * rotation landing.
   *
   * Defaults (read via `getJobLogLimits()` below) bias toward
   * "verbose but bounded": enough to debug a normal install end-to-end
   * without letting a thrashing job swallow the SQLite file.
   */
  logging?: {
    /** Hard cap on log entries persisted per job. Default 10_000. */
    maxJobLogLines?: number;
    /** Hard cap on cumulative log bytes persisted per job. Default 5_000_000 (~5 MB). */
    maxJobLogBytes?: number;
  };
}

// #1098 Phase 1: defaults for the logging caps. Consumers (Phase 2's
// rotation in logger.ts) should always go through this getter so the
// fallback shape lives in one place.
export const DEFAULT_MAX_JOB_LOG_LINES = 10_000;
export const DEFAULT_MAX_JOB_LOG_BYTES = 5_000_000;

export function getJobLogLimits(config: AppConfig): { maxLines: number; maxBytes: number } {
  return {
    maxLines: config.logging?.maxJobLogLines ?? DEFAULT_MAX_JOB_LOG_LINES,
    maxBytes: config.logging?.maxJobLogBytes ?? DEFAULT_MAX_JOB_LOG_BYTES,
  };
}

// #1099 Phase 1: schema version of the persisted config document.
// Phase 2 will introduce a migration ledger that walks `persisted →
// CURRENT_SCHEMA_VERSION` on startup; this PR establishes the baseline
// so the ledger has a number to walk from. Legacy configs missing the
// field are stamped `1` by the ConfigTransformer below, so in-memory
// configs always carry a value once they've passed through migrateConfig().
export const CURRENT_SCHEMA_VERSION = 1;

export function getSchemaVersion(config: AppConfig): number {
  // Fallback to 1 (the baseline) rather than CURRENT — a legacy config
  // missing the field represents v1 data, regardless of where CURRENT
  // moves to in the future.
  return config.schemaVersion ?? 1;
}

export interface ServicePostDeployRecord {
  /** ISO timestamp of when the script finished (success or failure). */
  lastRunAt: string;
  /** Exit code; 0 = success. */
  exitCode: number;
  /** Tail of stdout (last ~1KB). Aids "what failed" diagnosis without bloating config. */
  stdoutTail?: string;
}

/**
 * One credential the install wizard saved for the operator. Mirrors
 * the wire-shape `Credential` in `lib/stackInstall/credentialsManifest.ts`
 * but kept here to avoid a cross-module import in `AppConfig`.
 *
 * Each entry's `password` field is auto-encrypted at rest via
 * `SENSITIVE_KEYS` — same trust boundary as the kube YAMLs that
 * already embed plaintext secrets. See #19 / A1.
 */
export interface InstalledCredential {
  service: string;
  url: string;
  username: string;
  /** Auto-encrypted at rest by `transformConfig` (key matches SENSITIVE_KEYS). */
  password: string;
  importance: 'critical' | 'system';
  notes?: string;
}

export interface InstallManifest {
  /** ISO timestamp of when this manifest was persisted. */
  savedAt: string;
  credentials: InstalledCredential[];
}

/**
 * "Request access" submission from the family portal (#242 follow-up).
 * Anonymous family-LAN visitors fill a form with their name + email
 * and the admin sees pending requests in Settings, then creates an
 * LLDAP user. Persisted in `config.accessRequests` so they survive
 * reboots; auto-capped at 50 pending so a hostile LAN visitor can't
 * fill the disk.
 */
export interface AccessRequest {
  /** Random uuid; the route handler generates it. */
  id: string;
  /** ISO timestamp of when the form was submitted. */
  requestedAt: string;
  /**
   * Display name. Originally a single free-text field; newer requests
   * compose this from firstName + lastName on submit but it remains
   * the canonical "human-readable label" for old entries that don't
   * carry the split fields.
   */
  name: string;
  email: string;
  /** Optional "why" note from the requester. */
  message?: string;
  /**
   * Desired LLDAP login. Validated to `[a-z0-9._-]{1,60}` so it maps
   * cleanly to LLDAP's `uid` without further sanitization. Optional
   * for backward-compatibility with requests submitted before #405.
   */
  username?: string;
  /** Given name — feeds LLDAP `firstName` when the admin approves. */
  firstName?: string;
  /** Family name — feeds LLDAP `lastName` when the admin approves. */
  lastName?: string;
  /**
   * Lifecycle state.
   *   pending  — awaiting an admin decision.
   *   approved — admin provisioned/accepted the request (one-click
   *              Approve or "Mark resolved").
   *   denied   — admin dismissed the request; nothing was provisioned.
   *
   * Legacy entries written before #1824 carry the old `'resolved'`
   * value, which always meant the approve path. Read those as
   * `'approved'`; never write `'resolved'` going forward.
   */
  status: 'pending' | 'approved' | 'denied' | 'resolved';
  /** ISO timestamp of when the admin resolved (approved/denied) it. */
  resolvedAt?: string;
  /**
   * Provenance/category for requests filed programmatically via SB-MCP
   * (#1818) rather than the anonymous portal form — e.g. `resident` for
   * a Solilos conversational onboarding. Absent for portal submissions
   * (which are implicitly portal-account requests).
   */
  kind?: string;
  /**
   * Free-form structured context attached by the MCP caller (#1818) —
   * e.g. "voice profile enrolled". Surfaced to the admin alongside the
   * request so they can decide. Capped on the MCP tool side.
   */
  payload?: string;
  /**
   * Who/what filed the request when it came in over SB-MCP (#1818) —
   * the calling agent/token identity, for the admin's audit trail.
   * Absent for anonymous portal submissions.
   */
  requestedBy?: string;
}

export function getOidcCallbackUrl(config: { reverseProxy?: { publicDomain?: string } }): string {
  const domain = config.reverseProxy?.publicDomain;
  if (domain) {
    return `https://admin.${domain}/api/auth/oidc/callback`;
  }
  return 'http://localhost:3000/api/auth/oidc/callback';
}

/**
 * Base URL of the ServiceBay admin UI for use in outbound communications
 * (e.g. notification emails). Prefers the public domain when available so
 * the link works from outside the LAN; otherwise falls back to the LAN
 * domain. Returns null when nothing usable is configured — callers should
 * omit the link rather than generating a broken localhost URL.
 */
export function getAdminBaseUrl(config: { reverseProxy?: { publicDomain?: string; lanDomain?: string } }): string | null {
  const publicDomain = config.reverseProxy?.publicDomain;
  if (publicDomain) {
    return `https://admin.${publicDomain}`;
  }
  const lanDomain = config.reverseProxy?.lanDomain;
  if (lanDomain) {
    return `http://admin.${lanDomain}`;
  }
  return null;
}

const normalizeExternalLinkEntry = (link: ExternalLink): ExternalLink => {
  const normalizedTargets = normalizeExternalTargets(link.ipTargets ?? []);
  return {
    ...link,
    ipTargets: normalizedTargets,
  };
};

const normalizeExternalLinks = (links?: ExternalLink[]): ExternalLink[] | undefined => {
  if (!Array.isArray(links)) return links;
  return links.map(normalizeExternalLinkEntry);
};

const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  templateSettings: {},
  logLevel: 'info',
  agent: {
    cleanupOrphansOnStart: true,
    restartSchedule: {
      enabled: false,
      time: '03:00',
      timezone: 'UTC'
    },
    gracefulShutdownTimeout: 30,
    processCleanup: {
      enabled: true,
      dryRun: false,
      maxAgeMinutes: 60
    }
  },
  autoUpdate: {
    // Auto-update by default for fresh installs. The home-lab use case
    // strongly prefers "stays patched on its own" over "asks before every
    // minor security release." Users can flip this off in Settings → System.
    enabled: true,
    schedule: '0 0 * * *', // Daily at midnight
  }
};

const normalizeTemplateSettingsKeys = (settings?: Record<string, string>): Record<string, string> | undefined => {
  if (!settings) return settings;
  const normalized = { ...settings };
  if (typeof normalized.STACKS_DIR === 'string' && !normalized.DATA_DIR) {
    normalized.DATA_DIR = normalized.STACKS_DIR;
  }
  if ('STACKS_DIR' in normalized) {
    delete normalized.STACKS_DIR;
  }
  return normalized;
};

// Recursive helper to traverse config and apply a transform function to specific keys
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function transformConfig(obj: any, keysToTransform: string[], transformFn: (val: string) => string): any {
  if (Array.isArray(obj)) {
    return obj.map(v => transformConfig(v, keysToTransform, transformFn));
  } else if (obj !== null && typeof obj === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newObj: any = {};
    for (const key of Object.keys(obj)) {
      if (keysToTransform.includes(key) && typeof obj[key] === 'string') {
        newObj[key] = transformFn(obj[key]);
      } else {
        newObj[key] = transformConfig(obj[key], keysToTransform, transformFn);
      }
    }
    return newObj;
  }
  return obj;
}

const SENSITIVE_KEYS = ['password', 'secret', 'token', 'key', 'apiKey'];

/** Sentinel a redacted secret value is replaced with (#1275). */
export const REDACTED_SENTINEL = '__REDACTED__';

/**
 * Replace every secret-valued field (the same `SENSITIVE_KEYS` set used for
 * at-rest encryption) with `REDACTED_SENTINEL`, so the config can be handed to
 * a less-trusted caller — e.g. a scoped `sb_` API token reading GET
 * /api/settings (#1275). Anything encrypted on disk is therefore also redacted
 * here. Pure: returns a deep copy, never mutates the input.
 */
export function redactSensitiveConfig<T>(config: T): T {
  return transformConfig(config, SENSITIVE_KEYS, () => REDACTED_SENTINEL) as T;
}

export async function getConfig(): Promise<AppConfig> {
  let rawConfig: unknown = {};
  try {
    const content = await fs.readFile(CONFIG_PATH, 'utf-8');
    rawConfig = JSON.parse(content);
  } catch {
    // If file is missing or corrupt, return defaults
    return DEFAULT_CONFIG;
  }

  // Decrypt sensitive fields. transformConfig uses decrypt which
  // catches its own errors per-key, so this call should be safe.
  const decrypted = transformConfig(rawConfig, SENSITIVE_KEYS, decrypt) as AppConfig;
  const merged = { ...DEFAULT_CONFIG, ...decrypted };
  merged.templateSettings = normalizeTemplateSettingsKeys(merged.templateSettings) || {};
  merged.externalLinks = normalizeExternalLinks(merged.externalLinks);
  return merged;
}

/**
 * Per-process serialization for config writes. Prevents the
 * read-modify-write race in `updateConfig`: without it, two concurrent
 * callers both read state X, both compute X+updates, then both write
 * — the second write clobbers the first's update.
 *
 * The queue is a Promise chain. Each new write waits for the previous
 * one to settle (success or error) before running. Errors don't break
 * the chain — they're caught here so a failed update doesn't prevent
 * subsequent ones.
 */
let configWriteQueue: Promise<unknown> = Promise.resolve();

function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = configWriteQueue.then(fn, fn);
  // Don't let a rejection break the chain — `fn` already either
  // returns the result or throws, the queue just needs to advance.
  configWriteQueue = next.catch(() => undefined);
  return next;
}

async function saveConfigLocked(config: AppConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  // Encrypt sensitive fields before saving
  const normalizedConfig: AppConfig = {
    ...config,
    externalLinks: normalizeExternalLinks(config.externalLinks),
    templateSettings: normalizeTemplateSettingsKeys(config.templateSettings)
  };
  const safeConfig = transformConfig(normalizedConfig, SENSITIVE_KEYS, encrypt);
  await atomicWriteFile(CONFIG_PATH, JSON.stringify(safeConfig, null, 2));
}

export async function saveConfig(config: AppConfig): Promise<void> {
  return withConfigLock(() => saveConfigLocked(config));
}

/**
 * Reads the config and re-saves it to ensure all sensitive fields are encrypted.
 * Should be called on application startup.
 */
export async function migrateConfig(): Promise<void> {
  try {
    const transformer = new ConfigTransformer(CONFIG_PATH);
    await transformer.run();
    const config = await getConfig();
    // saveConfig automatically handles encryption of all sensitive keys
    await saveConfig(config);
  } catch (error) {
    logger.warn('config', 'Failed to migrate/encrypt config on startup:', error);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null && typeof srcVal === 'object' && !Array.isArray(srcVal) &&
      tgtVal !== null && typeof tgtVal === 'object' && !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

export async function updateConfig(updates: Partial<AppConfig>): Promise<AppConfig> {
  // Hold the lock across the read+write so two concurrent callers
  // don't both read state X then both write X+updates with one
  // clobbering the other. Calling `saveConfigLocked` directly here
  // (instead of `saveConfig`) avoids re-entering the same lock.
  return withConfigLock(async () => {
    const current = await getConfig();
    const updated: AppConfig = deepMerge(current, updates);
    await saveConfigLocked(updated);
    // #1093: apply runtime side effects of certain fields here so EVERY
    // updateConfig caller — not just the /api/settings/logLevel route
    // handler — picks up the change without a server restart. logLevel
    // is the canonical case: server.ts only reads it once at boot.
    if (updates.logLevel && updates.logLevel !== current.logLevel) {
      logger.setLogLevel(updates.logLevel);
    }
    return updated;
  });
}

/**
 * Strip every secret value from `config.json` so that the next
 * `getConfig()` can't surface stale ciphertext that the upcoming new
 * install will be unable to decrypt (secret.key is being wiped
 * alongside this call).
 *
 * Reset-flow contract (#711):
 *   - Deletes every value still in `enc:v1:` form (raw on-disk
 *     ciphertext — getConfig() decrypts those to plaintext, so this
 *     reads the raw file directly).
 *   - Drops `auth.passwordHash` + `auth.bootstrapToken` (plaintext
 *     hashes that survive the cipher wipe — useless once secret.key
 *     is gone).
 *   - Preserves operator-input fields (publicDomain, lanDomain,
 *     gateway.host, etc.) so the wizard's already-written context
 *     survives the reset.
 *
 * Runs under the same `withConfigLock` queue as `updateConfig` /
 * `saveConfig` — that's the reason it lives here and not in
 * `performStackReset`. The pre-#711 implementation invoked a Python
 * one-liner via the agent's shell exec, which read and wrote
 * `config.json` outside the Node.js lock. A concurrent
 * post-deploy that called `updateConfig({ adguard: { password }})`
 * would land its write *between* the Python script's read and
 * write — the python write then clobbered the post-deploy update
 * because it persisted its older in-memory snapshot. Operators
 * surfaced this as "adguard.password missing after install" + the
 * wildcard DNS rewrites silently failing to provision.
 */
export async function scrubEncryptedConfig(): Promise<{ removedKeys: number }> {
  return withConfigLock(async () => {
    let removedKeys = 0;
    let raw: unknown;
    try {
      const content = await fs.readFile(CONFIG_PATH, 'utf-8');
      raw = JSON.parse(content);
    } catch {
      return { removedKeys };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (obj: any): void => {
      if (Array.isArray(obj)) {
        for (const v of obj) walk(v);
        return;
      }
      if (obj !== null && typeof obj === 'object') {
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (typeof v === 'string' && v.startsWith('enc:v1:')) {
            delete obj[k];
            removedKeys += 1;
          } else if (v !== null && typeof v === 'object') {
            walk(v);
          }
        }
      }
    };
    walk(raw);
    if (raw !== null && typeof raw === 'object' && 'auth' in (raw as Record<string, unknown>)) {
      const auth = (raw as { auth?: Record<string, unknown> }).auth;
      if (auth && typeof auth === 'object') {
        if ('passwordHash' in auth) { delete auth.passwordHash; removedKeys += 1; }
        if ('bootstrapToken' in auth) { delete auth.bootstrapToken; removedKeys += 1; }
      }
    }
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await atomicWriteFile(CONFIG_PATH, JSON.stringify(raw, null, 2));
    return { removedKeys };
  });
}

