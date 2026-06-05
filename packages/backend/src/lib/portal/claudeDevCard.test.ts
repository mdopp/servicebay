import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Integration coverage for the #1682 fixes on the claude-dev appless card:
 *  - the card carries its declared `category` ("Development"), falling back
 *    to "System" when the guide declares none;
 *  - the `external_scheme` VS Code action's `HOST:PORT` placeholder is
 *    interpolated with the box's real LAN IP + the resolved
 *    CLAUDE_DEV_SSH_PORT, so no literal `HOST`/`PORT` token survives.
 *
 * Unlike buildPortalCards.test.ts this does NOT mock ./userGuide — it runs
 * the real frontmatter parser so the category + action plumbing is exercised
 * end to end.
 */

const listServices = vi.fn();
const getServices = vi.fn();
const getLastResult = vi.fn();
const configState: { config: Record<string, unknown> } = { config: {} };

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => configState.config),
}));
vi.mock('@/lib/mode', () => ({
  getActiveDomain: () => 'home.arpa',
  getMode: () => 'lan',
}));
vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { listServices: (node?: string) => listServices(node) },
}));
vi.mock('@/lib/store/repository', () => ({
  getServices: (node?: string) => getServices(node),
}));
vi.mock('@/lib/health/store', () => ({
  HealthStore: { getLastResult: (id: string) => getLastResult(id) },
}));
vi.mock('@/lib/templateTier', () => ({ parseTemplateTier: () => 'app' }));
vi.mock('@/lib/templateLabel', () => ({ parseTemplateLabel: () => 'Claude Dev' }));

const CLAUDE_DEV_GUIDE = `---
lucide_icon: "bot"
category: "Development"
tagline: "A dev box."
primary_action:
  type: "in_app"
  label: "Open terminal"
  href: "/terminal?node=Local&container=claude-dev-claude-dev&attach=claude"
  icon: "bot"
actions:
  - type: "external_scheme"
    label: "Open in VS Code (desktop)"
    href: "vscode://vscode-remote/ssh-remote+dev@HOST:PORT/workspace"
    icon: "package"
---
body
`;

vi.mock('@/lib/registry', () => ({
  getTemplateUserGuide: vi.fn(async () => CLAUDE_DEV_GUIDE),
}));

// claude-dev has no subdomain var; its variables.json carries CLAUDE_DEV_SSH_PORT.
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(async (p: string) => {
      if (p.endsWith('variables.json')) {
        return JSON.stringify({
          CLAUDE_DEV_SSH_PORT: { type: 'text', default: '2222' },
        });
      }
      return 'apiVersion: v1\n'; // template.yml
    }),
  },
}));

import { buildPortalCards, interpolateActionHref } from './services';
import type { PortalAction } from './userGuide';

const svc = (name: string, active: boolean) => ({
  name,
  active,
  kubeFile: '',
  kubePath: '',
  yamlFile: null,
  yamlPath: null,
  status: active ? 'active' : 'inactive',
  ports: [],
  volumes: [],
  labels: {},
});

describe('claude-dev portal card (#1682)', () => {
  beforeEach(() => {
    listServices.mockReset().mockResolvedValue([svc('claude-dev', true)]);
    getServices.mockReset().mockReturnValue([]);
    getLastResult.mockReset().mockReturnValue(null);
    configState.config = { reverseProxy: { hosts: [] }, templateSettings: {}, lanIp: '192.168.178.100' };
  });

  it('files the appless card under its declared category "Development"', async () => {
    const cards = await buildPortalCards();
    expect(cards).toHaveLength(1);
    expect(cards[0].name).toBe('claude-dev');
    expect(cards[0].category).toBe('Development');
  });

  it('interpolates the VS Code href with the box LAN IP + CLAUDE_DEV_SSH_PORT (no literal HOST/PORT)', async () => {
    const cards = await buildPortalCards();
    const vscode = cards[0].secondaryActions.find(a => a.type === 'external_scheme');
    expect(vscode).toBeDefined();
    expect(vscode!.href).toBe('vscode://vscode-remote/ssh-remote+dev@192.168.178.100:2222/workspace');
    expect(vscode!.href).not.toContain('HOST');
    expect(vscode!.href).not.toContain('PORT');
  });

  it('honours an operator-overridden CLAUDE_DEV_SSH_PORT from templateSettings', async () => {
    configState.config = {
      reverseProxy: { hosts: [] },
      templateSettings: { CLAUDE_DEV_SSH_PORT: '2244' },
      lanIp: '192.168.178.100',
    };
    const cards = await buildPortalCards();
    const vscode = cards[0].secondaryActions.find(a => a.type === 'external_scheme');
    expect(vscode!.href).toContain('@192.168.178.100:2244/workspace');
  });

  it('falls back to the active domain for the host when no lanIp is recorded', async () => {
    configState.config = { reverseProxy: { hosts: [] }, templateSettings: {} };
    const cards = await buildPortalCards();
    const vscode = cards[0].secondaryActions.find(a => a.type === 'external_scheme');
    expect(vscode!.href).toContain('@home.arpa:2222/workspace');
  });

  it('keeps the in_app terminal deep-link (no HOST/PORT) untouched, pointing at the real container name', async () => {
    const cards = await buildPortalCards();
    expect(cards[0].primaryAction?.href).toBe(
      '/terminal?node=Local&container=claude-dev-claude-dev&attach=claude',
    );
  });
});

describe('interpolateActionHref (#1682)', () => {
  const ext = (href: string): PortalAction => ({
    type: 'external_scheme',
    label: 'x',
    href,
    desktop_only: true,
  });

  it('substitutes HOST and PORT word-tokens', () => {
    const out = interpolateActionHref(ext('vscode://r/ssh-remote+dev@HOST:PORT/workspace'), '10.0.0.5', '2222');
    expect(out.href).toBe('vscode://r/ssh-remote+dev@10.0.0.5:2222/workspace');
  });

  it('leaves an in_app action untouched', () => {
    const inApp: PortalAction = { type: 'in_app', label: 'x', href: '/terminal?container=HOSTx', desktop_only: false };
    expect(interpolateActionHref(inApp, '10.0.0.5', '2222')).toBe(inApp);
  });

  it('is a no-op when no HOST/PORT token is present', () => {
    const a = ext('vscode://r/ssh-remote+dev@already:9/workspace');
    expect(interpolateActionHref(a, '10.0.0.5', '2222')).toBe(a);
  });
});
