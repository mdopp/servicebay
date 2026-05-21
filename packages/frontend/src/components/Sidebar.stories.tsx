import type { Meta, StoryObj } from '@storybook/nextjs';
import { http, HttpResponse } from 'msw';
import Sidebar from './Sidebar';
import { idleInstallStatus } from '../mocks/fixtures';

/**
 * First Storybook story for Phase 4 (#753). Picks `Sidebar` because
 * it exercises the full stack a frontend-only contributor cares
 * about — App Router navigation hooks (`useRouter`, `usePathname`,
 * `useSearchParams`), `typedFetch` against the mocked `/api/install/
 * status` endpoint, and Tailwind + dark-mode tokens — without
 * pulling in the heavyweight DigitalTwinProvider or any agent state.
 *
 * Variants here drive the conditional "Setup" entry: the default
 * mocked `/api/install/status` returns idle (no Setup link); the
 * `ActiveInstall` story overrides the worker with a job-active
 * fixture so the Setup chip shows.
 */
const meta = {
  title: 'Components/Sidebar',
  component: Sidebar,
  parameters: {
    layout: 'fullscreen',
    msw: {
      handlers: [
        http.get('/api/install/status', () => HttpResponse.json(idleInstallStatus)),
      ],
    },
    nextjs: {
      navigation: {
        pathname: '/services',
      },
    },
  },
  tags: ['autodocs'],
} satisfies Meta<typeof Sidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ActiveInstall: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get('/api/install/status', () =>
          HttpResponse.json({
            ...idleInstallStatus,
            job: { phase: 'running', startedAt: '2026-05-21T10:00:00.000Z' },
            jobIsActive: true,
            stackSetupPending: true,
          }),
        ),
      ],
    },
  },
};

export const OnNetworkRoute: Story = {
  parameters: {
    nextjs: {
      navigation: {
        pathname: '/network',
      },
    },
  },
};
