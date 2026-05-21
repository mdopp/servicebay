import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import { EmailStep } from './EmailStep';

interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  recipients: string;
}

const EMPTY: EmailConfig = {
  host: '',
  port: 587,
  secure: false,
  user: '',
  pass: '',
  from: '',
  recipients: '',
};

const GMAIL: EmailConfig = {
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  user: 'alerts@example.com',
  pass: 'app-password-not-real',
  from: 'alerts@example.com',
  recipients: 'admin@example.com',
};

function EmailStepWithState({ initial }: { initial: EmailConfig }) {
  const [cfg, setCfg] = useState(initial);
  return <EmailStep emailConfig={cfg} setEmailConfig={setCfg} />;
}

const meta = {
  title: 'Wizard/EmailStep',
  component: EmailStepWithState,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof EmailStepWithState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = { args: { initial: EMPTY } };
export const GmailPrefilled: Story = { args: { initial: GMAIL } };
