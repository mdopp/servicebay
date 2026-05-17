/**
 * Reset preserve-group identifiers used by `/api/system/stacks/reset`
 * and `/api/system/stacks/reset/info`. The wizard surfaces a checkbox
 * per group so the operator can pick *what* a "clean install"
 * actually wipes (#568 transparency rework).
 *
 * Defaults preserve the three system-critical groups; only
 * `service-data` (app payload — photos, HA, media, …) wipes unless
 * the operator explicitly opts in. The previous behaviour was "wipe
 * everything" which caused the May-15 data-loss incident
 * (see [[feedback_destructive_install_options]]).
 *
 * Lives in /src/lib because Next.js route files cannot export extra
 * symbols — the route handler imports from here instead.
 */

export const RESET_GROUPS = {
  /** ServiceBay's own state: secret.key, .auth-secret.env, config.json,
   *  cert-archive. Wiping this turns every `enc:v1:` encrypted credential
   *  in config.json into garbage (the AES key + AUTH_SECRET are here).
   *  Default: PRESERVE. */
  secrets: {
    paths: ['/var/mnt/data/servicebay'],
    excludePaths: ['/var/mnt/data/servicebay/quadlet-backup'],
    label: 'ServiceBay secrets + config',
    description: 'Encryption keys (secret.key, AUTH_SECRET), config.json, cert-archive. Wiping these forces every encrypted credential to be re-entered and the wizard to start over.',
  },
  /** NPM proxy + LE certs as a unit. Cert-reuse logic (#566) needs
   *  both the on-disk certs AND NPM's DB rows that reference them by
   *  id, so we treat them atomically.
   *  Default: PRESERVE — LE has a 5-duplicate-certs / 168h rate limit
   *  that bites if you wipe + re-issue more than a couple of times. */
  certs: {
    paths: ['/var/mnt/data/stacks/nginx-proxy-manager'],
    label: 'NPM proxy + Let\'s Encrypt certs',
    description: 'Reverse-proxy config + issued LE certificates. Wiping triggers fresh ACME challenges on next install — LE\'s rate limit blocks repeated wipes.',
  },
  /** Authelia + LLDAP — identity provider state. Wiping means
   *  re-seeding users, regenerating OIDC client secrets, and every
   *  SSO-enabled service has to be re-linked.
   *  Default: PRESERVE. */
  identity: {
    paths: ['/var/mnt/data/stacks/auth'],
    label: 'Identity provider (Authelia + LLDAP)',
    description: 'User accounts, groups, OIDC clients, session cookies. Wiping means every family member re-creates their login and every SSO-enabled service re-pairs.',
  },
  /** Everything else under stacks/*: photos, music, HA configs,
   *  Vaultwarden vault, Syncthing config, AdGuard rules, …
   *  Default: WIPE. The "clean" in clean install. */
  'service-data': {
    paths: ['/var/mnt/data/stacks'],
    label: 'Service data (photos, HA, media, files, vault, …)',
    description: 'Immich photos, Home Assistant configs, media library, Vaultwarden vault, Syncthing data, AdGuard rules, etc. The "clean" in clean install.',
  },
} as const;

export type ResetGroup = keyof typeof RESET_GROUPS;

/** Default `preserve` array when the API caller omits one. Keeps the
 *  three system-critical groups; only `service-data` wipes. */
export const DEFAULT_PRESERVE: ResetGroup[] = ['secrets', 'certs', 'identity'];
