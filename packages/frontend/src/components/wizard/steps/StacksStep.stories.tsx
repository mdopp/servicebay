import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import { StacksStep } from './StacksStep';
import type { Template } from '@servicebay/api-client';
import type { useStackInstall, StackItem, StackVariable } from '@/hooks/useStackInstall';

/**
 * StacksStep story (#753 Phase 4.x follow-up). The wizard's heaviest
 * sub-step — fronts `useStackInstall`, a hook that owns the entire
 * stack-install state machine + side-effects. Storying it means
 * inverting the hook into a plain object so each variant can pin a
 * specific phase (`select` / `configure` / `installing` / `done`)
 * without running the install runner.
 *
 * The `noopInstallFlow` helper is the only complex part of the
 * fixture — it satisfies the `InstallFlow` type with default values
 * + no-op methods. Variants below override only the fields each
 * variant cares about.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noop = (..._args: any[]) => {};
const noopAsync = async () => {};

type InstallFlow = ReturnType<typeof useStackInstall>;

function noopInstallFlow(overrides: Partial<InstallFlow> = {}): InstallFlow {
  return {
    phase: 'idle',
    items: [],
    variables: [],
    logs: [],
    installingNow: null,
    deployedNames: [],
    // `StackInstallSummary` reads `.length` off this — `null` would
    // crash the Done variant. Empty array means "no credentials to
    // surface" which renders the empty-state copy.
    credentialsManifest: [],
    npmCredPrompt: null,
    // `StackInstallProgress` reads `.email` / `.password` off this
    // unconditionally — a null here is what made the Installing /
    // Done variants crash on mount. Empty strings keep the input
    // fields rendered with placeholder text.
    npmCredFallback: { email: '', password: '' },
    error: null,
    cleanInstall: false,
    cleanInstallConfirm: '',
    setCleanInstall: noop,
    setCleanInstallConfirm: noop,
    preserve: undefined,
    setPreserve: noop,
    setItemChecked: noop,
    setItems: noop,
    setVariableValue: noop,
    setVariableExposure: noop,
    startConfigure: noopAsync,
    runInstall: noopAsync,
    retryNpmCredentials: noopAsync,
    skipNpmCredentials: noop,
    appendLog: noop,
    reset: noop,
    abortInstall: noop,
    attachToJob: noopAsync,
    jobId: null,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const SAMPLE_TEMPLATES: Template[] = [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { name: 'auth', label: 'Authelia + LLDAP (SSO)', tier: 'core', description: 'Identity provider' } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { name: 'immich', label: 'Immich (Photos)', tier: 'feature', description: 'Photo & video library' } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { name: 'vaultwarden', label: 'Vaultwarden', tier: 'feature', description: 'Password manager' } as any,
];

const STACK_ITEMS_CONFIGURED: StackItem[] = [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { name: 'auth', checked: true, dependencies: [] } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { name: 'immich', checked: true, dependencies: ['auth'] } as any,
];

const STACK_VARIABLES_SAMPLE: StackVariable[] = [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { name: 'AUTHELIA_SUBDOMAIN', value: 'auth', meta: { type: 'subdomain', label: 'Authelia subdomain' } } as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { name: 'IMMICH_SUBDOMAIN', value: 'photos', meta: { type: 'subdomain', label: 'Immich subdomain' } } as any,
];

interface Args {
  stackInstallStep: 'select' | 'services' | 'configure' | 'installing' | 'done';
  installFlow?: Partial<InstallFlow>;
  diagnoseProbes: import('../../DiagnoseProbeList').DiagnoseProbe[] | null;
  diagnoseRunning: boolean;
  installingNow: string | null;
  stacksLoading: boolean;
  stacksOnlyMode: boolean;
}

function StacksStepWithState({
  stackInstallStep,
  installFlow: installFlowOverride,
  diagnoseProbes,
  diagnoseRunning,
  installingNow,
  stacksLoading,
  stacksOnlyMode,
}: Args) {
  const [pickerChecked, setPickerChecked] = useState<Set<string>>(new Set(['auth', 'immich']));
  const [stackItems, setStackItems] = useState<StackItem[]>(STACK_ITEMS_CONFIGURED);
  const [stackSelectedNode, setStackSelectedNode] = useState<string | null>('Local');
  return (
    <StacksStep
      stackInstallStep={stackInstallStep}
      stacksLoading={stacksLoading}
      availableStacks={SAMPLE_TEMPLATES}
      pickerChecked={pickerChecked}
      setPickerChecked={setPickerChecked}
      stackItems={stackItems}
      setStackItems={setStackItems}
      stackVariables={STACK_VARIABLES_SAMPLE}
      installFlow={noopInstallFlow(installFlowOverride)}
      stackNodes={[{ Name: 'Local', URI: 'ssh://core@127.0.0.1' }]}
      stackSelectedNode={stackSelectedNode}
      setStackSelectedNode={setStackSelectedNode}
      installingNow={installingNow}
      diagnoseProbes={diagnoseProbes}
      diagnoseRunning={diagnoseRunning}
      handleStackSkip={noopAsync}
      stacksOnlyMode={stacksOnlyMode}
      handleFinish={noopAsync}
      SERVICE_DEPS={{}}
      stackDeviceOptions={{}}
      stackLoadingDevices={false}
    />
  );
}

const meta = {
  title: 'Wizard/StacksStep',
  component: StacksStepWithState,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof StacksStepWithState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PickerSelect: Story = {
  args: {
    stackInstallStep: 'select',
    diagnoseProbes: null,
    diagnoseRunning: false,
    installingNow: null,
    stacksLoading: false,
    stacksOnlyMode: false,
  },
};

export const Configure: Story = {
  args: {
    stackInstallStep: 'configure',
    diagnoseProbes: null,
    diagnoseRunning: false,
    installingNow: null,
    stacksLoading: false,
    stacksOnlyMode: false,
  },
};

export const Installing: Story = {
  args: {
    stackInstallStep: 'installing',
    installFlow: {
      phase: 'installing',
      items: STACK_ITEMS_CONFIGURED,
      variables: STACK_VARIABLES_SAMPLE,
      logs: [
        '[2026-05-21T10:00:00Z] auth: pulling images',
        '[2026-05-21T10:00:12Z] auth: deploying',
        '[2026-05-21T10:00:30Z] auth: ✓ ready',
        '[2026-05-21T10:00:32Z] immich: pulling images',
      ],
      deployedNames: ['auth'],
      jobId: 'job-mock-123',
    },
    diagnoseProbes: null,
    diagnoseRunning: false,
    installingNow: 'immich',
    stacksLoading: false,
    stacksOnlyMode: false,
  },
};

export const Done: Story = {
  args: {
    stackInstallStep: 'done',
    installFlow: {
      phase: 'done',
      items: STACK_ITEMS_CONFIGURED,
      variables: STACK_VARIABLES_SAMPLE,
      deployedNames: ['auth', 'immich'],
    },
    diagnoseProbes: [
      { id: 'p1', label: 'OIDC provider (Authelia)', status: 'ok', detail: 'Discovery answers 200 with a valid configuration document.' },
      { id: 'p2', label: 'External reachability', status: 'ok', detail: 'auth.example.com, photos.example.com — 2/2 reachable.' },
    ],
    diagnoseRunning: false,
    installingNow: null,
    stacksLoading: false,
    stacksOnlyMode: false,
  },
};

export const Loading: Story = {
  args: {
    stackInstallStep: 'select',
    diagnoseProbes: null,
    diagnoseRunning: false,
    installingNow: null,
    stacksLoading: true,
    stacksOnlyMode: false,
  },
};
