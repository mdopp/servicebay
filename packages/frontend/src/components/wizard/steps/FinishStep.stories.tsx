import type { Meta, StoryObj } from '@storybook/nextjs';
import { FinishStep } from './FinishStep';

const meta = {
  title: 'Wizard/FinishStep',
  component: FinishStep,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof FinishStep>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    handleFinish: () => console.log('[story] handleFinish — would route to /services'),
  },
};
