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
  Database,
  Network,
  Server,
  Users,
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
      { id: 'portal-access', label: 'Portal access', tier: 'advanced', keywords: ['portal', 'public page', 'landing'] },
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
  {
    id: 'backups',
    label: 'Backups',
    intent: 'Protect your data — snapshots, restore and off-box destinations.',
    icon: Database,
    entries: [
      { id: 'backups', label: 'Backups & restore', tier: 'essential', keywords: ['backup', 'restore', 'snapshot', 'nas', 'usb'] },
      { id: 'external-backup', label: 'Off-box destination', tier: 'advanced', keywords: ['nas', 'ftp', 'external', 'destination'] },
    ],
  },
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
      { id: 'stacks', label: 'Stacks & templates', tier: 'advanced', keywords: ['stack', 'template', 'registry', 'variable'] },
      // Disk import left Settings for its own app + launch tile (#1949 / #1953):
      // the heavy job runs in a resource-capped worker container reached via a
      // dashboard tile, so it is no longer a Settings entry here.
      { id: 'factory-reset', label: 'Factory reset', tier: 'advanced', keywords: ['reset', 'wipe', 'erase', 'danger'] },
    ],
  },
];

export const DEFAULT_GROUP = SETTINGS_GROUPS[0];

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
    href: `/settings/${group.id}#${entry.id}`,
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
