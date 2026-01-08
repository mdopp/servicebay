
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverSystemdServices } from './discovery';
import { getExecutor } from './executor';
import { getPodmanPs } from './manager';

// Mocks
vi.mock('./executor');
vi.mock('./manager');

describe('Discovery', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should identify a .container file in systemd dir as managed', async () => {
        const mockExec = vi.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (getExecutor as any).mockReturnValue({
            exec: mockExec,
            exists: vi.fn(),
        });

        // Mock podman ps returning a container belonging to a unit
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (getPodmanPs as any).mockResolvedValue([
            {
                Id: 'container123',
                Names: ['servicebay'],
                Labels: { 'PODMAN_SYSTEMD_UNIT': 'servicebay.service' }
            }
        ]);

        // Mock systemctl show to return the Quadlet path
        mockExec.mockImplementation(async (cmd: string) => {
            if (cmd.includes('systemctl --user show')) {
                return { 
                    stdout: `FragmentPath=/home/user/.config/containers/systemd/servicebay.container\nSourcePath=/home/user/.config/containers/systemd/servicebay.container\n`
                };
            }
            return { stdout: '' };
        });

        const services = await discoverSystemdServices({ Name: 'Local', URI: 'local', Identity: '', Default: true });

        expect(services).toHaveLength(1);
        expect(services[0].serviceName).toBe('servicebay.service');
        expect(services[0].type).toBe('container'); // Derived from extension
        expect(services[0].status).toBe('managed'); // The fix!
    });

    it('should identify a .service file outside systemd dir as unmanaged', async () => {
        const mockExec = vi.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (getExecutor as any).mockReturnValue({
            exec: mockExec,
            exists: vi.fn(),
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (getPodmanPs as any).mockResolvedValue([
            {
                Id: 'container456',
                Names: ['manual-service'],
                Labels: { 'PODMAN_SYSTEMD_UNIT': 'manual.service' }
            }
        ]);

        mockExec.mockImplementation(async (cmd: string) => {
            if (cmd.includes('systemctl --user show')) {
                 // Return a path that is NOT in .config/containers/systemd
                return { 
                    stdout: `FragmentPath=/home/user/.config/systemd/user/manual.service\nSourcePath=/home/user/.config/systemd/user/manual.service\n`
                };
            }
            return { stdout: '' };
        });

        const services = await discoverSystemdServices({ Name: 'Local', URI: 'local', Identity: '', Default: true });

        expect(services).toHaveLength(1);
        expect(services[0].status).toBe('unmanaged');
    });
});
