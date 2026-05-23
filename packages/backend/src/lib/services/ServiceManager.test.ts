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
