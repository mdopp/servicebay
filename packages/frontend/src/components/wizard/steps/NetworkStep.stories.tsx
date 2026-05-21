import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import { NetworkStep } from './NetworkStep';
import type { OnboardingStatus } from '@/app/actions/onboarding';

const STATUS: OnboardingStatus = {
  needsSetup: true,
  stackSetupPending: true,
  hasGateway: false,
  hasSshKey: false,
  hasExternalLinks: false,
  installInProgress: null,
} as unknown as OnboardingStatus;

interface Args {
  selection: { gateway: boolean; ssh: boolean };
  initial: { publicDomain: string; gwHost: string; gwUser: string; gwPass: string };
  status: OnboardingStatus | null;
  loading: boolean;
}

function NetworkStepWithState({ selection, initial, status, loading }: Args) {
  const [publicDomain, setPublicDomain] = useState(initial.publicDomain);
  const [gwHost, setGwHost] = useState(initial.gwHost);
  const [gwUser, setGwUser] = useState(initial.gwUser);
  const [gwPass, setGwPass] = useState(initial.gwPass);
  return (
    <NetworkStep
      selection={selection}
      publicDomain={publicDomain}
      setPublicDomain={setPublicDomain}
      gwHost={gwHost}
      setGwHost={setGwHost}
      gwUser={gwUser}
      setGwUser={setGwUser}
      gwPass={gwPass}
      setGwPass={setGwPass}
      status={status}
      // No real action in stories — log instead of awaiting an API call.
       
      handleGenerateKey={async () => { console.log('[story] handleGenerateKey'); }}
      loading={loading}
    />
  );
}

const meta = {
  title: 'Wizard/NetworkStep',
  component: NetworkStepWithState,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof NetworkStepWithState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: {
    selection: { gateway: true, ssh: true },
    initial: { publicDomain: '', gwHost: '', gwUser: '', gwPass: '' },
    status: STATUS,
    loading: false,
  },
};

export const Prefilled: Story = {
  args: {
    selection: { gateway: true, ssh: true },
    initial: {
      publicDomain: 'example.com',
      gwHost: '192.168.1.1',
      gwUser: 'admin',
      gwPass: '••••••••',
    },
    status: { ...STATUS, hasGateway: true, hasSshKey: true } as OnboardingStatus,
    loading: false,
  },
};

export const GeneratingKey: Story = {
  args: {
    selection: { gateway: false, ssh: true },
    initial: { publicDomain: 'example.com', gwHost: '', gwUser: '', gwPass: '' },
    status: STATUS,
    loading: true,
  },
};
