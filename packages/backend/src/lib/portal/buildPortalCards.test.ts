import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Integration coverage for the #1662 fix: a stopped-but-installed feature
 * service must still produce a portal card (with a `down`/"Not running"
 * badge) instead of being filtered out before card assembly.
 */

const listServices = vi.fn();
const getServices = vi.fn();
const getLastResult = vi.fn();

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => ({ reverseProxy: { hosts: [] }, templateSettings: {} })),
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
vi.mock('@/lib/registry', () => ({
  getTemplateUserGuide: vi.fn(async () => '# guide\nbody'),
}));
vi.mock('@/lib/templateTier', () => ({ parseTemplateTier: () => 'app' }));
vi.mock('@/lib/templateLabel', () => ({ parseTemplateLabel: () => 'Immich' }));
vi.mock('./userGuide', () => ({
  parseUserGuide: () => ({ frontmatter: {}, body: 'body' }),
  DEFAULT_PORTAL_CATEGORY: 'System',
}));

// fs reads: template.yml (any non-null string) + variables.json (a subdomain var).
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(async (p: string) => {
      if (p.endsWith('variables.json')) {
        return JSON.stringify({
          IMMICH_SUBDOMAIN: { type: 'subdomain', default: 'photos' },
        });
      }
      return 'apiVersion: v1\n'; // template.yml
    }),
  },
}));

import { buildPortalCards } from './services';

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

describe('buildPortalCards stopped-service down badge (#1662)', () => {
  beforeEach(() => {
    listServices.mockReset();
    getServices.mockReset().mockReturnValue([]);
    getLastResult.mockReset().mockReturnValue(null);
  });

  it('renders a stopped installed service with a down/"Not running" badge', async () => {
    listServices.mockResolvedValue([svc('immich', false)]);

    const cards = await buildPortalCards();

    expect(cards).toHaveLength(1);
    expect(cards[0].name).toBe('immich');
    expect(cards[0].status).toBe('down');
    expect(cards[0].statusReason).toBe('Not running');
  });

  it('keeps a running service with no health signal as unknown (not down)', async () => {
    listServices.mockResolvedValue([svc('immich', true)]);

    const cards = await buildPortalCards();

    expect(cards).toHaveLength(1);
    expect(cards[0].status).toBe('unknown');
  });
});
