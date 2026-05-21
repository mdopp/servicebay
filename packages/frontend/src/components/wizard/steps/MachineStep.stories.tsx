import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import { MachineStep } from './MachineStep';
import { isValidOperatorEmail, operatorEmailIssue } from '@servicebay/api-client';

type DetectedDrive = {
  name: string;
  path: string;
  type: string;
  size: string;
  model?: string;
  rota?: boolean;
  mountpoint?: string | null;
};

const SAMPLE_DRIVES: DetectedDrive[] = [
  { name: 'sda', path: '/dev/sda', type: 'disk', size: '4T', model: 'WDC WD40EFRX' },
  { name: 'sdb', path: '/dev/sdb', type: 'disk', size: '4T', model: 'WDC WD40EFRX' },
];

const SAMPLE_RAID = {
  device: '/dev/md127',
  label: 'data',
  fstype: 'xfs',
  size: '3.6T',
  mountpoint: '/mnt/data',
  degraded: false,
};

interface Args {
  initialMode: 'public' | 'lan';
  initialDomain: string;
  initialEmail: string;
  detectedRaid: typeof SAMPLE_RAID | undefined;
  detectedDrives: DetectedDrive[];
  stackLoadingDevices: boolean;
}

function MachineStepWithState({
  initialMode,
  initialDomain,
  initialEmail,
  detectedRaid,
  detectedDrives,
  stackLoadingDevices,
}: Args) {
  const [installMode, setInstallMode] = useState<'public' | 'lan'>(initialMode);
  const [publicDomain, setPublicDomain] = useState(initialDomain);
  const [operatorEmail, setOperatorEmail] = useState(initialEmail);
  const [cleanInstall, setCleanInstall] = useState(false);
  const [cleanInstallConfirm, setCleanInstallConfirm] = useState('');
  const [preserve, setPreserve] = useState<string[] | undefined>(undefined);
  return (
    <MachineStep
      installMode={installMode}
      setInstallMode={setInstallMode}
      publicDomain={publicDomain}
      setPublicDomain={setPublicDomain}
      operatorEmail={operatorEmail}
      setOperatorEmail={setOperatorEmail}
      isValidOperatorEmail={isValidOperatorEmail}
      operatorEmailIssue={operatorEmailIssue}
      detectedRaid={detectedRaid}
      availableStacks={[]}
      cleanInstall={cleanInstall}
      setCleanInstall={setCleanInstall}
      cleanInstallConfirm={cleanInstallConfirm}
      setCleanInstallConfirm={setCleanInstallConfirm}
      preserve={preserve}
      setPreserve={setPreserve}
      stackSelectedNode="Local"
      navigateTo={(step) => console.log('[story] navigateTo', step)}
      detectedDrives={detectedDrives}
      stackLoadingDevices={stackLoadingDevices}
    />
  );
}

const meta = {
  title: 'Wizard/MachineStep',
  component: MachineStepWithState,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof MachineStepWithState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PublicMode: Story = {
  args: {
    initialMode: 'public',
    initialDomain: 'example.com',
    initialEmail: 'admin@example.com',
    detectedRaid: SAMPLE_RAID,
    detectedDrives: SAMPLE_DRIVES,
    stackLoadingDevices: false,
  },
};

export const LanMode: Story = {
  args: {
    initialMode: 'lan',
    initialDomain: '',
    initialEmail: 'admin@example.com',
    detectedRaid: SAMPLE_RAID,
    detectedDrives: SAMPLE_DRIVES,
    stackLoadingDevices: false,
  },
};

export const NoRaidDetected: Story = {
  args: {
    initialMode: 'public',
    initialDomain: 'example.com',
    initialEmail: '',
    detectedRaid: undefined,
    detectedDrives: [],
    stackLoadingDevices: false,
  },
};

export const LoadingDevices: Story = {
  args: {
    initialMode: 'public',
    initialDomain: '',
    initialEmail: '',
    detectedRaid: undefined,
    detectedDrives: [],
    stackLoadingDevices: true,
  },
};
