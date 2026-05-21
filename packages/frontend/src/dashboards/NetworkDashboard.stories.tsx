import type { Meta, StoryObj } from '@storybook/nextjs';
import { http, HttpResponse } from 'msw';
import NetworkDashboard from './NetworkDashboard';
import { MockDigitalTwinProvider } from '../mocks/MockDigitalTwinProvider';
import { mockTwinSnapshot, emptyTwinSnapshot } from '../mocks/twin';

/**
 * NetworkDashboard story (#753 Phase 4). The dashboard reads from
 * the DigitalTwin context (mocked via `MockDigitalTwinProvider`)
 * and fires a handful of background fetches the wizard hits during
 * a normal install (NPM proxy hosts, container info, etc). MSW
 * handlers return empty arrays for the rest so the graph renders
 * its idle / loaded state without exploding.
 */
const meta = {
  title: 'Dashboards/NetworkDashboard',
  component: NetworkDashboard,
  parameters: {
    layout: 'fullscreen',
    msw: {
      handlers: [
        http.get('/api/network/graph', () => HttpResponse.json({ nodes: [], edges: [] })),
        http.get('/api/services', () => HttpResponse.json([])),
        http.get('/api/containers', () => HttpResponse.json([])),
        http.get('/api/install/status', () =>
          HttpResponse.json({
            job: null,
            jobIsActive: false,
            stackSetupPending: false,
            serverStartedAt: '2026-05-21T10:00:00.000Z',
          }),
        ),
        // Any auth / system probe falls through to bypass.
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
} satisfies Meta<typeof NetworkDashboard>;

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

export const Disconnected: Story = {
  decorators: [
    (Story) => (
      <MockDigitalTwinProvider snapshot={null} isConnected={false}>
        <Story />
      </MockDigitalTwinProvider>
    ),
  ],
};
