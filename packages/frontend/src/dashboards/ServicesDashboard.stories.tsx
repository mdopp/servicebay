import type { Meta, StoryObj } from '@storybook/nextjs';
import { http, HttpResponse } from 'msw';
import ServicesDashboard from './ServicesDashboard';
import { MockDigitalTwinProvider } from '../mocks/MockDigitalTwinProvider';
import { mockTwinSnapshot, emptyTwinSnapshot } from '../mocks/twin';

/**
 * ServicesDashboard story (#753 Phase 4). The dashboard renders
 * a grid of service cards from the twin's `services` array; each
 * card pulls extra detail from `/api/services`. MSW returns the
 * three services from `mockTwinSnapshot` so the grid is populated.
 */
const meta = {
  title: 'Dashboards/ServicesDashboard',
  component: ServicesDashboard,
  parameters: {
    layout: 'fullscreen',
    msw: {
      handlers: [
        http.get('/api/services', () =>
          HttpResponse.json([
            { name: 'immich', active: true, status: 'running', ports: [{ host: 2283, container: 2283 }], type: 'container' },
            { name: 'home-assistant', active: true, status: 'running', ports: [{ host: 8123, container: 8123 }], type: 'container' },
            { name: 'auth', active: true, status: 'running', ports: [{ host: 9091, container: 9091 }], type: 'container' },
          ]),
        ),
        http.get('/api/containers', () => HttpResponse.json([])),
        http.get('/api/install/status', () =>
          HttpResponse.json({
            job: null,
            jobIsActive: false,
            stackSetupPending: false,
            serverStartedAt: '2026-05-21T10:00:00.000Z',
          }),
        ),
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
} satisfies Meta<typeof ServicesDashboard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PopulatedTwin: Story = {};

export const EmptyTwin: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get('/api/services', () => HttpResponse.json([])),
        http.get('/api/containers', () => HttpResponse.json([])),
      ],
    },
  },
  decorators: [
    (Story) => (
      <MockDigitalTwinProvider snapshot={emptyTwinSnapshot}>
        <Story />
      </MockDigitalTwinProvider>
    ),
  ],
};
