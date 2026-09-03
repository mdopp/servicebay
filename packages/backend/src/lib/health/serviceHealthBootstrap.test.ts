import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #2544 — the health-probe view must resolve a variable the way the
 * install path does.
 *
 * Before this, `buildVariableView` was template defaults +
 * `Object.assign(templateSettings)` and nothing else. A port the operator
 * changed in Configure is recorded in `config.installedVariables` (#2531),
 * NOT in `templateSettings`, so the poller probed the template's default
 * port forever: a healthy service permanently reported unhealthy, with no
 * clue why.
 */

const listServices = vi.fn();
const registered: Array<{ serviceName: string; config: { url?: string; port?: string } }> = [];
const start = vi.fn();

const state: {
  config: Record<string, unknown> | null;
  variables: Record<string, { type?: string; default?: string }> | null;
  yaml: string | null;
  /** The node twin's watched files — i.e. what is DEPLOYED on the box. */
  files: Record<string, { content: string }>;
} = { config: null, variables: null, yaml: null, files: {} };

vi.mock('@/lib/store/repository', () => ({
  getNodeTwin: vi.fn(() => ({ files: state.files })),
}));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn(async () => {
    if (!state.config) throw new Error('config unreadable');
    return state.config;
  }),
}));
vi.mock('@/lib/services/ServiceManager', () => ({
  ServiceManager: { listServices: (node?: string) => listServices(node) },
}));
vi.mock('@/lib/registry', () => ({
  getTemplateYaml: vi.fn(async () => state.yaml),
  getTemplateVariables: vi.fn(async () => state.variables),
  // Present so `manifestAssembler` (imported below for the equality test)
  // can bind its own registry imports against this mock.
  getTemplateConfigFiles: vi.fn(async () => []),
  getTemplateAssetFiles: vi.fn(async () => []),
  getTemplateSettingsSchema: vi.fn(async () => ({})),
}));
vi.mock('./serviceHealth', () => ({
  getServiceHealthPoller: () => ({
    register: (s: { serviceName: string; config: { url?: string; port?: string } }) => {
      registered.push(s);
    },
    start,
  }),
}));

import { bootstrapServiceHealth } from './serviceHealthBootstrap';
import { applyVariableDefaults } from '@/lib/install/manifestAssembler';

/** An `immich`-shaped template: one port variable in the probe URL. */
const TEMPLATE_YAML = `apiVersion: v1
kind: Pod
metadata:
  name: immich
  annotations:
    servicebay.healthcheck: |
      url: http://localhost:{{IMMICH_PORT}}/api/server/ping
      interval: 30s
      timeout: 5s
spec:
  containers: []
`;

const svc = (name: string) => ({
  name,
  active: true,
  kubeFile: '',
  kubePath: '',
  yamlFile: null,
  yamlPath: null,
  status: 'active',
  ports: [],
  volumes: [],
  labels: {},
});

const probeUrl = () => registered[0]?.config.url;

describe('serviceHealthBootstrap variable resolution (#2544)', () => {
  beforeEach(() => {
    registered.length = 0;
    start.mockReset();
    listServices.mockReset().mockResolvedValue([svc('immich')]);
    state.yaml = TEMPLATE_YAML;
    state.variables = { IMMICH_PORT: { type: 'text', default: '2283' } };
    state.config = { templateSettings: {}, installedVariables: [] };
    state.files = {};
  });

  it('probes the port the OPERATOR set, not the template default', async () => {
    // The reported case: changed in Configure, so it lives only here.
    state.config = {
      templateSettings: {},
      installedVariables: [{ varName: 'IMMICH_PORT', value: '9999' }],
    };
    const result = await bootstrapServiceHealth('Local');
    expect(result.registered).toEqual(['immich']);
    expect(probeUrl()).toBe('http://localhost:9999/api/server/ping');
  });

  it('lets a global Template Setting outrank the operator-set value', async () => {
    state.config = {
      templateSettings: { IMMICH_PORT: '7777' },
      installedVariables: [{ varName: 'IMMICH_PORT', value: '9999' }],
    };
    await bootstrapServiceHealth('Local');
    expect(probeUrl()).toBe('http://localhost:7777/api/server/ping');
  });

  it('falls back to the template default when the operator set nothing', async () => {
    await bootstrapServiceHealth('Local');
    expect(probeUrl()).toBe('http://localhost:2283/api/server/ping');
  });

  it('still resolves defaults when config cannot be read at all', async () => {
    state.config = null; // getConfig rejects
    await bootstrapServiceHealth('Local');
    expect(probeUrl()).toBe('http://localhost:2283/api/server/ping');
  });

  it('renders the SAME value the install path resolves for that variable', async () => {
    // The #2537 technique: rather than asserting a hand-written expected
    // value, build the variable set exactly as `/api/install/start` does
    // (`applyVariableDefaults` over a replayed JobInput) and require the
    // probe URL to carry that value. If the two ever drift again, this
    // fails without anyone having to notice the new call site.
    state.config = {
      templateSettings: {},
      installedVariables: [{ varName: 'IMMICH_PORT', value: '9999' }],
    };
    const deployed = await applyVariableDefaults({
      items: [{ name: 'immich', checked: true }],
      variables: [],
      templateSource: 'Built-in',
      host: 'box.local',
    });
    const deployedPort = deployed.variables.find(v => v.name === 'IMMICH_PORT')?.value;

    await bootstrapServiceHealth('Local');
    expect(deployedPort).toBeTruthy();
    expect(probeUrl()).toBe(`http://localhost:${deployedPort}/api/server/ping`);
  });

  it('never renders a stored secret into a probe URL', async () => {
    state.yaml = TEMPLATE_YAML.replace(
      '/api/server/ping',
      '/api/server/ping?token={{IMMICH_API_TOKEN}}',
    );
    state.variables = {
      IMMICH_PORT: { type: 'text', default: '2283' },
      IMMICH_API_TOKEN: { type: 'secret' },
    };
    state.config = {
      templateSettings: {},
      installedVariables: [],
      // The #615 store. A probe URL is not a place for credential material,
      // so the resolver never consults it.
      installedSecrets: [{ varName: 'IMMICH_API_TOKEN', value: 'super-secret-token' }],
    };
    await bootstrapServiceHealth('Local');
    expect(probeUrl()).not.toContain('super-secret-token');
  });
});

/**
 * #2656 — the probe target must come from the manifest that is DEPLOYED, not
 * from the current template rendered against the current config.
 *
 * The reported box case, reproduced literally below: a hostNetwork service
 * deployed with `url: http://localhost:8701/healthz` whose template had since
 * moved to `http://localhost:{{CHRONICLE_PORT}}/healthz` with `default: 8700`.
 * The poller probed 8700 — nothing listens there — and the tile read
 * `ready: false / "fetch failed"` forever, while the annotated URL answered
 * 200 the whole time. `localhost` was never the problem (ServiceBay's own
 * container runs `Network=host`, so loopback IS the host's loopback); the
 * drift between the two manifests was.
 */
describe('serviceHealthBootstrap probes the DEPLOYED manifest (#2656)', () => {
  const DEPLOYED_YAML = `apiVersion: v1
kind: Pod
metadata:
  name: daggerheart-chronik
  annotations:
    servicebay.healthcheck: |
      url: http://localhost:8701/healthz
      interval: 30s
      timeout: 5s
spec:
  hostNetwork: true
  containers: []
`;

  /** The same template the box carries: the port is a variable, default 8700. */
  const CURRENT_TEMPLATE_YAML = `apiVersion: v1
kind: Pod
metadata:
  name: daggerheart-chronik
  annotations:
    servicebay.ports: "{{CHRONICLE_PORT}}/tcp"
    servicebay.healthcheck: |
      url: http://localhost:{{CHRONICLE_PORT}}/healthz
      interval: 30s
      timeout: 5s
spec:
  hostNetwork: true
  containers:
  - name: chronik
    ports:
      - containerPort: {{CHRONICLE_PORT}}
`;

  const deployedSvc = {
    ...svc('daggerheart-chronik'),
    yamlFile: 'daggerheart-chronik.yml',
    yamlPath: '/var/home/core/.config/containers/systemd/daggerheart-chronik.yml',
  };

  beforeEach(() => {
    registered.length = 0;
    start.mockReset();
    listServices.mockReset().mockResolvedValue([deployedSvc]);
    state.yaml = CURRENT_TEMPLATE_YAML;
    state.variables = { CHRONICLE_PORT: { type: 'text', default: '8700' } };
    state.config = { templateSettings: {}, installedVariables: [] };
    state.files = { [deployedSvc.yamlPath]: { content: DEPLOYED_YAML } };
  });

  it('probes the port the DEPLOYED pod declares, not the template default', async () => {
    const result = await bootstrapServiceHealth('Local');
    expect(result.registered).toEqual(['daggerheart-chronik']);
    // 8700 is what the template resolves and what produced "fetch failed".
    expect(probeUrl()).toBe('http://localhost:8701/healthz');
  });

  it('keeps probing the deployed target when the template moves the port again', async () => {
    // A template-side bump with no intervening redeploy is the same drift.
    state.variables = { CHRONICLE_PORT: { type: 'text', default: '9100' } };
    await bootstrapServiceHealth('Local');
    expect(probeUrl()).toBe('http://localhost:8701/healthz');
  });

  it('follows the template once a redeploy has converged the deployed manifest', async () => {
    // What a redeploy leaves behind: the pod YAML IS the rendered template,
    // ports: block and all. The poller must now agree with it — same code
    // path, no second source of truth.
    state.files = {
      [deployedSvc.yamlPath]: {
        content: CURRENT_TEMPLATE_YAML.replace(/\{\{CHRONICLE_PORT\}\}/g, '8700'),
      },
    };
    await bootstrapServiceHealth('Local');
    expect(probeUrl()).toBe('http://localhost:8700/healthz');
  });

  it('falls back to the template when the twin has no deployed pod YAML', async () => {
    // A `.container` Quadlet, or a node that has not reported its files yet.
    listServices.mockResolvedValue([svc('daggerheart-chronik')]);
    state.files = {};
    await bootstrapServiceHealth('Local');
    expect(probeUrl()).toBe('http://localhost:8700/healthz');
  });

  it('falls back to the template when the deployed annotation is unusable', async () => {
    // An unrendered placeholder survived into the deployed file — that file is
    // not a probe target, but the service must not lose its health tile.
    state.files = {
      [deployedSvc.yamlPath]: {
        content: DEPLOYED_YAML.replace('http://localhost:8701/healthz', ''),
      },
    };
    await bootstrapServiceHealth('Local');
    expect(probeUrl()).toBe('http://localhost:8700/healthz');
  });

  it('registers a service the registry has no template for at all', async () => {
    // A hand-deployed / box-local service used to be skipped outright, so it
    // showed no health even though its own manifest says how to probe it.
    state.yaml = null;
    const result = await bootstrapServiceHealth('Local');
    expect(result.registered).toEqual(['daggerheart-chronik']);
    expect(probeUrl()).toBe('http://localhost:8701/healthz');
  });

  it('resolves the deployed YAML through the twin key suffix as listServices does', async () => {
    state.files = { 'daggerheart-chronik.yml': { content: DEPLOYED_YAML } };
    await bootstrapServiceHealth('Local');
    expect(probeUrl()).toBe('http://localhost:8701/healthz');
  });
});
