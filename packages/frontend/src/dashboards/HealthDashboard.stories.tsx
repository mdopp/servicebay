import type { Meta, StoryObj } from '@storybook/nextjs';
import { http, HttpResponse } from 'msw';
import HealthDashboard from './HealthDashboard';
import { MockDigitalTwinProvider } from '../mocks/MockDigitalTwinProvider';
import { mockTwinSnapshot } from '../mocks/twin';

const SAMPLE_CHECKS = [
  {
    id: 'chk-immich',
    name: 'Immich',
    type: 'http',
    target: 'https://photos.example.com',
    interval: 60,
    enabled: true,
    created_at: '2026-05-01T00:00:00Z',
    httpConfig: { expectedStatus: 200 },
  },
  {
    id: 'chk-auth',
    name: 'Authelia',
    type: 'http',
    target: 'https://auth.example.com/.well-known/openid-configuration',
    interval: 60,
    enabled: true,
    created_at: '2026-05-01T00:00:00Z',
    httpConfig: { expectedStatus: 200 },
  },
  {
    id: 'chk-ha',
    name: 'Home Assistant',
    type: 'http',
    target: 'https://ha.example.com',
    interval: 60,
    enabled: true,
    created_at: '2026-05-01T00:00:00Z',
    httpConfig: { expectedStatus: 200 },
  },
];

const NOW = '2026-05-21T10:00:00.000Z';
const SAMPLE_RESULTS = {
  'chk-immich': [
    { check_id: 'chk-immich', status: 'ok', latency_ms: 142, timestamp: NOW, message: 'HTTP 200' },
  ],
  'chk-auth': [
    { check_id: 'chk-auth', status: 'ok', latency_ms: 87, timestamp: NOW, message: 'HTTP 200' },
  ],
  'chk-ha': [
    { check_id: 'chk-ha', status: 'fail', latency_ms: 0, timestamp: NOW, message: 'connect ETIMEDOUT' },
  ],
};

/**
 * HealthDashboard story (#753 Phase 4.x follow-up). Same shape as the
 * Network/Services dashboard stories — wraps with the twin decorator
 * and pins MSW handlers for `/api/health/checks` + per-check history.
 */
const meta = {
  title: 'Dashboards/HealthDashboard',
  component: HealthDashboard,
  parameters: {
    layout: 'fullscreen',
    msw: {
      handlers: [
        http.get('/api/health/checks', () => HttpResponse.json(SAMPLE_CHECKS)),
        http.get('/api/health/checks/:id/history', ({ params }) => {
          const id = String(params.id);
          return HttpResponse.json(SAMPLE_RESULTS[id as keyof typeof SAMPLE_RESULTS] ?? []);
        }),
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
} satisfies Meta<typeof HealthDashboard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MixedHealth: Story = {};

export const AllPassing: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get('/api/health/checks', () => HttpResponse.json(SAMPLE_CHECKS)),
        http.get('/api/health/checks/:id/history', ({ params }) =>
          HttpResponse.json([
            {
              check_id: String(params.id),
              status: 'ok',
              latency_ms: 100,
              timestamp: NOW,
              message: 'HTTP 200',
            },
          ]),
        ),
      ],
    },
  },
};

export const NoChecks: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get('/api/health/checks', () => HttpResponse.json([])),
      ],
    },
  },
};
