import type { Meta, StoryObj } from '@storybook/nextjs';
import { http, HttpResponse } from 'msw';
import OnboardingWizard from './OnboardingWizard';
import { MockDigitalTwinProvider } from '../mocks/MockDigitalTwinProvider';
import { mockTwinSnapshot, emptyTwinSnapshot } from '../mocks/twin';

/**
 * End-to-end `OnboardingWizard` story (#753 Phase 4). The wizard
 * touches a wide surface — server actions (`checkOnboardingStatus`,
 * `saveGatewayConfig`, `savePublicDomainConfig`, `saveEmailConfig`,
 * `generateLocalKey`, `completeStackSetup`, `fetchTemplates`,
 * `getNodes`), MSW-mocked endpoints (`/api/install/{status,start}`,
 * `/api/services`, `/api/system/{storage,diagnose}`), and the
 * DigitalTwin context. The decorators below cover the context;
 * the server actions tree-shake away because the storybook webpack
 * alias maps `@/lib/*` and `@/app/actions/*` to an empty stub
 * (see `.storybook/main.ts`). Any call into them at runtime would
 * fail loudly — desired failure mode for stories.
 *
 * For "test a single wizard step" workflows prefer the per-step
 * stories (`WelcomeStep`, `EmailStep`, `NetworkStep`,
 * `MachineStep`, `FinishStep`) — they have a tenth of the mock
 * surface and exercise the same JSX.
 */
const meta = {
  title: 'Wizard/OnboardingWizard',
  component: OnboardingWizard,
  parameters: {
    layout: 'fullscreen',
    msw: {
      handlers: [
        // Wizard polls install status to decide whether to render
        // the "active install" view or the configuration flow.
        http.get('/api/install/status', () =>
          HttpResponse.json({
            job: null,
            jobIsActive: false,
            stackSetupPending: false,
            serverStartedAt: '2026-05-21T10:00:00.000Z',
          }),
        ),
        http.post('/api/install/start', () => HttpResponse.json({ ok: true })),
        http.get('/api/system/storage', () => HttpResponse.json({ raids: [], drives: [] })),
        http.post('/api/system/diagnose', () =>
          HttpResponse.json({ node: 'Local', probes: [] }),
        ),
        http.get('/api/services', () => HttpResponse.json([])),
        http.get('/api/auth/lldap-url', () => HttpResponse.json({ url: null })),
      ],
    },
  },
  decorators: [
    (Story) => (
      <MockDigitalTwinProvider snapshot={mockTwinSnapshot}>
        <Story />
      </MockDigitalTwinProvider>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof OnboardingWizard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PopulatedTwin: Story = {};

export const EmptyTwin: Story = {
  decorators: [
    (Story) => (
      <MockDigitalTwinProvider snapshot={emptyTwinSnapshot}>
        <Story />
      </MockDigitalTwinProvider>
    ),
  ],
};
