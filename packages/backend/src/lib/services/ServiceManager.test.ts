/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceManager } from './ServiceManager';

// Mock DigitalTwinStore
const mockNodes = {
    'local': {
        services: [],
        containers: [],
        files: {} as Record<string, any>,
        volumes: [],
        systemInfo: {},
        lastUpdate: 0
    }
};

vi.mock('../store/twin', () => ({
    DigitalTwinStore: {
        getInstance: () => ({
            nodes: mockNodes
        })
    }
}));

// getServiceFiles still calls loadSystemdUnitInfo (systemctl cat / show) via
// the agent even when the Quadlet body is served from the twin cache. Stub the
// agent so those exec calls don't blow up; the unit content itself comes from
// the mocked twin files.
const mockSendCommand = vi.fn(async () => ({ code: 1, stdout: '', stderr: '' }));
vi.mock('../agent/manager', () => ({
    agentManager: {
        ensureAgent: async () => ({ sendCommand: mockSendCommand }),
    },
}));

describe('ServiceManager (V4)', () => {
    beforeEach(() => {
        mockNodes['local'] = {
            services: [],
            containers: [],
            files: {},
            volumes: [],
            systemInfo: {},
            lastUpdate: 0
        };
    });

    it('should parse Kube YAML for hostNetwork and ports', async () => {
        const yamlContent = `
apiVersion: v1
kind: Pod
metadata:
  labels:
    app: test-app
spec:
  hostNetwork: true
  containers:
  - name: test
    ports:
    - containerPort: 80
`;
        const kubeContent = `Yaml=test.yaml`;
        
         
        mockNodes['local'].files = {
            '/path/to/test.kube': { path: '/path/to/test.kube', content: kubeContent, modified: 0 },
            '/path/to/test.yaml': { path: '/path/to/test.yaml', content: yamlContent, modified: 0 }
        } as any;

        const services = await ServiceManager.listServices('local');
        
        expect(services).toHaveLength(1);
        const svc = services[0];
        expect(svc.name).toBe('test');
        expect(svc.hostNetwork).toBe(true);
        expect(svc.labels['app']).toBe('test-app');
        // Check inferred host port
        expect(svc.ports).toHaveLength(1);
        expect(svc.ports[0]).toEqual({ host: '80', container: '80' });
    });

    it('should parse Quadlet .container for Network and Ports', async () => {
        const containerContent = `
[Unit]
Description=Test

[Container]
Image=alpine
Network=host
PublishPort=8080:80
Label=foo=bar
`;
         
        mockNodes['local'].files = {
            '/path/to/my-app.container': { path: '/path/to/my-app.container', content: containerContent, modified: 0 }
        } as any;

        const services = await ServiceManager.listServices('local');
        
        expect(services).toHaveLength(1);
        const svc = services[0];
        expect(svc.name).toBe('my-app');
        expect(svc.hostNetwork).toBe(true);
        expect(svc.labels['foo']).toBe('bar');
        expect(svc.ports).toHaveLength(1);
        expect(svc.ports[0]).toEqual({ host: '8080', container: '80' });
    });

    it('should parse Quadlet implicit host port (PublishPort=80)', async () => {
        const containerContent = `
[Container]
PublishPort=80
`;
         
        mockNodes['local'].files = {
            '/path/to/simple.container': { path: '/path/to/simple.container', content: containerContent, modified: 0 }
        } as any;

        const services = await ServiceManager.listServices('local');
        const svc = services[0];
        expect(svc.ports[0]).toEqual({ host: '80', container: '80' });
    });

    it('should ignore non-hostNetwork K8s without hostPort', async () => {
        const yamlContent = `
apiVersion: v1
kind: Pod
spec:
  containers:
  - ports:
    - containerPort: 80
`; // No hostNetwork, no hostPort

         
        mockNodes['local'].files = {
            '/path/to/iso.kube': { content: 'Yaml=iso.yml' },
            '/path/to/iso.yml': { content: yamlContent }
        } as any;

        const services = await ServiceManager.listServices('local');
        const svc = services[0];
        expect(svc.ports[0].host).toBeUndefined();
    });

    it('should parse Kube Volumes correctly', async () => {
        const yamlContent = `
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: db
    volumeMounts:
    - name: data
      mountPath: /var/lib/mysql
  volumes:
  - name: data
    hostPath:
      path: /mnt/data
`;
         
        mockNodes['local'].files = {
            '/path/to/db.kube': { content: 'Yaml=db.yml' },
            '/path/to/db.yml': { content: yamlContent }
        } as any;

        const services = await ServiceManager.listServices('local');
        const svc = services[0];
        expect(svc.volumes).toHaveLength(1);
        expect(svc.volumes[0]).toEqual({ host: '/mnt/data', container: '/var/lib/mysql' });
    });

    it('hides servicebay-splash from listServices (file-driven path)', async () => {
        // The boot-time splash Quadlet (#775) sits on disk next to
        // `servicebay.container` and the operator can't / shouldn't
        // manage it. listServices must skip it so the dashboard's
        // services count doesn't include a deliberately-dormant
        // helper as "1 of N not running".
        mockNodes['local'].files = {
            '/var/home/core/.config/containers/systemd/vaultwarden.container': {
                path: '/var/home/core/.config/containers/systemd/vaultwarden.container',
                content: '[Container]\nImage=vaultwarden/server',
                modified: 0,
            },
            '/var/home/core/.config/containers/systemd/servicebay-splash.container': {
                path: '/var/home/core/.config/containers/systemd/servicebay-splash.container',
                content: '[Container]\nImage=ghcr.io/mdopp/servicebay-splash',
                modified: 0,
            },
        } as any;
        const services = await ServiceManager.listServices('local');
        const names = services.map(s => s.name);
        expect(names).toContain('vaultwarden');
        expect(names).not.toContain('servicebay-splash');
    });

    it('hides servicebay-splash from the implicit-services path too', async () => {
        // Second code path in listServices: services flagged
        // `isServiceBay` (or `isReverseProxy`) get appended even when
        // they don't have a `.container` on disk. The splash unit
        // gets flagged isServiceBay by the twin's name-based
        // detector ("servicebay" keyword match), so this path was
        // re-introducing it after the file-driven filter.
        mockNodes['local'].files = {};
        (mockNodes['local'] as any).services = [
            { name: 'servicebay', activeState: 'active', isServiceBay: true },
            { name: 'servicebay-splash', activeState: 'inactive', isServiceBay: true },
        ];
        const services = await ServiceManager.listServices('local');
        const names = services.map(s => s.name);
        expect(names).toContain('servicebay');
        expect(names).not.toContain('servicebay-splash');
    });

    it('should parse Quadlet Volumes correctly', async () => {
        const containerContent = `
[Container]
Volume=/host/path:/container/path
Volume=my-vol:/data:Z
`;
         
        mockNodes['local'].files = {
            '/path/to/vol.container': { path: '/path/to/vol.container', content: containerContent, modified: 0 }
        } as any;

        const services = await ServiceManager.listServices('local');
        const svc = services[0];
        expect(svc.volumes).toHaveLength(2);
        expect(svc.volumes[0]).toEqual({ host: '/host/path', container: '/container/path' });
        expect(svc.volumes[1]).toEqual({ host: 'my-vol', container: '/data' });
    });
});

describe('getServiceFiles — .container Quadlet resolution (#1778)', () => {
    const OLLAMA_PATH = '/var/home/core/.config/containers/systemd/ollama.container';
    const OLLAMA_BODY = [
        '[Unit]',
        'Description=Ollama',
        '',
        '[Container]',
        'Image=docker.io/ollama/ollama:latest',
        'AddDevice=nvidia.com/gpu=all',
        'PublishPort=11434:11434',
        '',
        '[Install]',
        'WantedBy=default.target',
    ].join('\n');

    beforeEach(() => {
        mockNodes['local'] = {
            services: [],
            containers: [],
            files: {},
            volumes: [],
            systemInfo: {},
            lastUpdate: 0,
        };
        mockSendCommand.mockClear();
    });

    it('resolves a .container service (not "File not found: ollama.kube")', async () => {
        // Regression for #1778: ollama runs as a single-container .container
        // Quadlet (the #1026 GPU fixup). The old path constructed
        // `${name}.kube` and 404'd; it must now serve the real .container body.
        mockNodes['local'].files = {
            [OLLAMA_PATH]: { path: OLLAMA_PATH, content: OLLAMA_BODY, modified: 0 },
        } as any;

        const files = await ServiceManager.getServiceFiles('local', 'ollama');
        expect(files.quadletKind).toBe('container');
        // kubeContent surfaces the .container unit body itself.
        expect(files.kubeContent).toContain('[Container]');
        expect(files.kubeContent).toContain('AddDevice=nvidia.com/gpu=all');
        // No separate pod spec for a .container — yamlContent stays empty.
        expect(files.yamlContent).toBe('');
        expect(files.yamlPath).toBe('');
        // kubePath points at the REAL .container path so writes target it.
        expect(files.kubePath).toBe(OLLAMA_PATH);
    });

    it('still resolves a .kube service to its pod-spec yaml', async () => {
        const kubePath = '/var/home/core/.config/containers/systemd/vaultwarden.kube';
        const yamlPath = '/var/home/core/.config/containers/systemd/vaultwarden.yml';
        mockNodes['local'].files = {
            [kubePath]: { path: kubePath, content: 'Yaml=vaultwarden.yml\n', modified: 0 },
            [yamlPath]: { path: yamlPath, content: 'apiVersion: v1\nkind: Pod\n', modified: 0 },
        } as any;

        const files = await ServiceManager.getServiceFiles('local', 'vaultwarden');
        expect(files.quadletKind).toBe('kube');
        expect(files.kubeContent).toContain('Yaml=vaultwarden.yml');
        expect(files.yamlContent).toContain('kind: Pod');
    });

    it('prefers .kube when both extensions somehow exist', async () => {
        const kubePath = '/x/dual.kube';
        const containerPath = '/x/dual.container';
        mockNodes['local'].files = {
            [containerPath]: { path: containerPath, content: '[Container]\nImage=x', modified: 0 },
            [kubePath]: { path: kubePath, content: 'Yaml=dual.yml', modified: 0 },
        } as any;

        const files = await ServiceManager.getServiceFiles('local', 'dual');
        expect(files.quadletKind).toBe('kube');
        expect(files.kubePath).toBe(kubePath);
    });
});
