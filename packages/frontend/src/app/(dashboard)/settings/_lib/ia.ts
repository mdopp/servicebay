// Settings information architecture — the single source of truth for the
// new settings shell (#1956 / slice 1 of #1950).
//
// The IA is a rip-and-replace of the old flat tab list. Settings are now
// organised by GOAL (cross-cutting intent: "Reachable from the internet"
// bundles domain + proxy + cert + DNS), not by component. Five global
// groups remain — true cross-cutting concerns:
//
//   Network & Domain · Access & People · Notifications · Backups · System
//
// Each setting carries a disclosure TIER (feedback_ux_philosophy):
//   - 'essential' — the handful people actually change; shown by default.
//   - 'advanced'  — expert knobs, defaults intact; collapsed behind one click.
//   - (auto-managed settings are NOT settings — the system self-heals and
//     surfaces unavoidable input via the diagnose actions[] path, so they
//     don't appear here at all.)
//
// This registry drives BOTH the nav and the global search/command palette,
// so every setting is reachable by name. Lives in the feature `_lib/` with
// no `@/lib` import (that alias resolves to the BACKEND;
// reference_at_lib_alias_is_backend).

import {
  Bell,
  Network,
  Server,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export type SettingTier = 'essential' | 'advanced';

/** A single searchable setting within a group, mapped to a rendered section. */
export interface SettingEntry {
  /** Stable id; also the in-page anchor (`#<id>`) for deep links. */
  id: string;
  /** Plain-language name surfaced in search ("type a name, jump to it"). */
  label: string;
  /** Disclosure tier — drives default visibility. */
  tier: SettingTier;
  /** Extra search keywords (synonyms users might type). */
  keywords?: string[];
  /** When set, this entry is a LAUNCHER for a feature that lives at its own
   *  top-level route (e.g. the disk-import worker app at `/disk-import`), not an
   *  in-page Settings section. Search links straight here, and the group page
   *  renders it as a launch card instead of a disclosure section. */
  launchHref?: string;
}

/** A goal-based cross-cutting group = one nav entry = one route. */
export interface SettingsGroup {
  /** Route segment under `/settings/<id>` and stable identifier. */
  id: string;
  /** Nav label. */
  label: string;
  /** One-line intent statement (the GOAL the group serves). */
  intent: string;
  icon: LucideIcon;
  entries: SettingEntry[];
}

// Services are NOT a Settings concern (spec §4.4 / §8): a service lives on the
// Services nav and its own Operate page, never in cross-cutting Settings. The
// old `services` group (a duplicate service list that Settings even LANDED on)
// is removed; `/settings/services` now redirects to `/services` for old
// bookmarks. Settings carry only true cross-cutting concerns below.
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    id: 'network-domain',
    label: 'Network & Domain',
    intent: 'Reachable from the internet — domain, proxy, certificates and DNS.',
    icon: Network,
    entries: [
      { id: 'public-domain', label: 'Public domain', tier: 'essential', keywords: ['domain', 'internet', 'dns', 'https', 'cert', 'certificate', 'public'] },
      { id: 'reverse-proxy', label: 'Reverse proxy', tier: 'advanced', keywords: ['nginx', 'npm', 'proxy', 'routing'] },
      { id: 'gateway', label: 'Router / gateway', tier: 'advanced', keywords: ['fritzbox', 'router', 'port forward', 'gateway'] },
      { id: 'nodes', label: 'Nodes & connections', tier: 'advanced', keywords: ['node', 'ssh', 'podman', 'remote', 'host'] },
    ],
  },
  {
    id: 'access',
    label: 'Access & People',
    intent: 'Who can get in — users, credentials, tokens and approvals.',
    icon: Users,
    entries: [
      { id: 'access-requests', label: 'Access requests', tier: 'essential', keywords: ['request', 'approve', 'invite', 'people'] },
      { id: 'credentials', label: 'Credentials', tier: 'essential', keywords: ['password', 'login', 'admin', 'lldap'] },
      { id: 'api-tokens', label: 'API tokens', tier: 'advanced', keywords: ['token', 'api', 'bearer'] },
      { id: 'mcp', label: 'MCP access', tier: 'advanced', keywords: ['mcp', 'agent', 'claude', 'tool'] },
      { id: 'portal-access', label: 'Portal access', tier: 'advanced', keywords: ['portal', 'public page', 'landing'] },
      { id: 'approvals', label: 'Action approvals', tier: 'advanced', keywords: ['approve', 'destructive', 'confirm'] },
      { id: 'file-share', label: 'File sharing', tier: 'advanced', keywords: ['samba', 'smb', 'share', 'nas'] },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    intent: 'How ServiceBay reaches you when something needs attention.',
    icon: Bell,
    entries: [
      { id: 'email', label: 'Email notifications', tier: 'essential', keywords: ['email', 'smtp', 'alert', 'notify'] },
    ],
  },
  // Backups left Settings for its own app + launch tile (#1949/#1958): the
  // heavy backup/restore + off-box-destination UI is now the Backup app behind
  // a dashboard tile, with the actions running in the capped backup worker
  // (#1955). It is no longer a Settings group here.
  {
    id: 'system',
    label: 'System',
    intent: 'The box itself — identity, updates, logs and reset.',
    icon: Server,
    entries: [
      { id: 'server-identity', label: 'Server identity', tier: 'essential', keywords: ['name', 'server name', 'identity'] },
      { id: 'updates', label: 'Updates', tier: 'essential', keywords: ['update', 'upgrade', 'version'] },
      { id: 'update-window', label: 'Update window', tier: 'advanced', keywords: ['schedule', 'maintenance', 'auto-update'] },
      { id: 'log-level', label: 'Log level', tier: 'advanced', keywords: ['log', 'debug', 'verbose'] },
      // Stacks & templates left Settings (#2081): stack management moved to the
      // /services overview (grouped by stack + scoped per-stack wipe), so it is
      // no longer a Settings entry or a search hit here.
      // Terminal returned to the sidebar nav (#2083): a host shell is a recovery
      // tool, not a buried Settings launch card. It is a top-level nav entry
      // (config/navigation.ts) served at /terminal, so it is no longer a Settings
      // entry or a search hit here.
      // Disk import left Settings for its own app + launch tile (#1949 / #1953):
      // the heavy job runs in a resource-capped worker container reached via a
      // dashboard tile, so it is no longer a Settings entry here.
      { id: 'factory-reset', label: 'Factory reset', tier: 'advanced', keywords: ['reset', 'wipe', 'erase', 'danger'] },
    ],
  },
  {
    // Occasional one-off tools that don't belong in the primary sidebar. Disk
    // import (run once or twice ever) lives here as a launch card → the resource-
    // capped worker app at /disk-import, rather than a permanent nav entry
    // (#1958 follow-up). The heavy UI still runs in its own route/worker.
    id: 'maintenance',
    label: 'Maintenance',
    intent: 'Occasional one-off tools — import a disk into the box.',
    icon: Wrench,
    entries: [
      { id: 'disk-import', label: 'Import data', tier: 'essential', launchHref: '/disk-import', keywords: ['import', 'disk', 'usb', 'drive', 'sort', 'photos', 'music', 'copy', 'ingest', 'sd card'] },
    ],
  },
];

// Settings lands on Network & Domain — the first cross-cutting group (services
// no longer live in Settings, so they're no longer the landing).
export const DEFAULT_GROUP = SETTINGS_GROUPS.find(g => g.id === 'network-domain') ?? SETTINGS_GROUPS[0];

/** Flattened search index: every setting + its group, for the command palette. */
export interface SearchHit {
  group: SettingsGroup;
  entry: SettingEntry;
  /** Deep link to the setting (group route + in-page anchor). */
  href: string;
}

export const SEARCH_INDEX: SearchHit[] = SETTINGS_GROUPS.flatMap(group =>
  group.entries.map(entry => ({
    group,
    entry,
    // Launcher entries link straight to their own route (e.g. /disk-import) so
    // searching "import" jumps right into the importer; everything else deep-
    // links to the in-page Settings anchor.
    href: entry.launchHref ?? `/settings/${group.id}#${entry.id}`,
  })),
);

/** Case-insensitive match over label + keywords + group label. */
export function searchSettings(query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SEARCH_INDEX.filter(hit => {
    const haystack = [
      hit.entry.label,
      hit.group.label,
      ...(hit.entry.keywords ?? []),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}
