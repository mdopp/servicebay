
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { discoverSystemdServices } from '@/lib/discovery';
import { getExecutor } from '@/lib/executor';
import { getPodmanPs } from '@/lib/manager';

// Mocks
vi.mock('@/lib/executor');
vi.mock('@/lib/manager');

const MOCK_NODE = { Name: 'Local', URI: 'ssh://user@127.0.0.1', Identity: '/app/data/ssh/id_rsa', Default: true };

describe('Discovery', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should identify a .container file in systemd dir as managed', async () => {
        const mockExec = vi.fn();
        // #1097: systemctl now goes through execArgv. Mock both — exec
        // is still used for `echo $HOME` (needs shell expansion).
        const mockExecArgv = vi.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (getExecutor as any).mockReturnValue({
            exec: mockExec,
            execArgv: mockExecArgv,
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

        // Mock systemctl show (via execArgv) to return the Quadlet path
        mockExecArgv.mockImplementation(async (argv: string[]) => {
            if (argv[0] === 'systemctl' && argv.includes('show')) {
                return {
                    stdout: `FragmentPath=/home/user/.config/containers/systemd/servicebay.container\nSourcePath=/home/user/.config/containers/systemd/servicebay.container\n`
                };
            }
            return { stdout: '' };
        });
        mockExec.mockResolvedValue({ stdout: '' });

        const services = await discoverSystemdServices(MOCK_NODE);

        expect(services).toHaveLength(1);
        expect(services[0].serviceName).toBe('servicebay.service');
        expect(services[0].type).toBe('container'); // Derived from extension
        expect(services[0].status).toBe('managed'); // The fix!
    });

    it('should identify a .service file outside systemd dir as unmanaged', async () => {
        const mockExec = vi.fn();
        const mockExecArgv = vi.fn();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (getExecutor as any).mockReturnValue({
            exec: mockExec,
            execArgv: mockExecArgv,
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

        mockExecArgv.mockImplementation(async (argv: string[]) => {
            if (argv[0] === 'systemctl' && argv.includes('show')) {
                 // Return a path that is NOT in .config/containers/systemd
                return {
                    stdout: `FragmentPath=/home/user/.config/systemd/user/manual.service\nSourcePath=/home/user/.config/systemd/user/manual.service\n`
                };
            }
            return { stdout: '' };
        });
        mockExec.mockResolvedValue({ stdout: '' });

        const services = await discoverSystemdServices(MOCK_NODE);

        expect(services).toHaveLength(1);
        expect(services[0].status).toBe('unmanaged');
    });
});
