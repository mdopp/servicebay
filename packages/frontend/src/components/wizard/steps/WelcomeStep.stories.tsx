import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import { WelcomeStep } from './WelcomeStep';

/**
 * Story for the wizard's first step (#753 Phase 4). Picked over a
 * full OnboardingWizard story because the wizard pulls in six
 * server-action modules + the DigitalTwin provider + the toast
 * provider — too much surface to mock cleanly in one PR. Per-step
 * stories give a frontend-only contributor the same "iterate on
 * this screen without a backend" loop with one-tenth of the mock
 * surface.
 *
 * The wrapper keeps the selection in local component state so the
 * Toggle controls behave naturally in the canvas — Storybook
 * `args` would freeze the toggle.
 */

type Selection = Parameters<typeof WelcomeStep>[0]['selection'];

const DEFAULT_SELECTION: Selection = {
  gateway: true,
  ssh: true,
  updates: true,
  registries: false,
  email: false,
  stacks: true,
};

function WelcomeStepWithState({ initial }: { initial: Selection }) {
  const [selection, setSelection] = useState<Selection>(initial);
  return <WelcomeStep selection={selection} setSelection={setSelection} />;
}

const meta = {
  title: 'Wizard/WelcomeStep',
  component: WelcomeStepWithState,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof WelcomeStepWithState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { initial: DEFAULT_SELECTION },
};

export const AllOn: Story = {
  args: {
    initial: {
      gateway: true,
      ssh: true,
      updates: true,
      registries: true,
      email: true,
      stacks: true,
    },
  },
};

export const StacksOnly: Story = {
  args: {
    initial: {
      gateway: false,
      ssh: false,
      updates: false,
      registries: false,
      email: false,
      stacks: true,
    },
  },
};
