// Pure helpers + shared types extracted from the original settings page so
// every tab can import them without dragging in stateful logic.

export type TemplateSettingsSchemaEntry = {
  default: string;
  description?: string;
  required?: boolean;
};

export const DEFAULT_TEMPLATE_SCHEMA: Record<string, TemplateSettingsSchemaEntry> = {
  DATA_DIR: {
    default: '/mnt/data',
    description: 'Base directory used by all templates for persistent data. Applies to new deployments.',
    required: true,
  },
};

// The self-update status shape now lives with the shared updater card so both
// Settings and Home can use it (#2082). Re-exported here for back-compat with
// existing settings importers.
export type { AppUpdateStatus } from '@/components/ServiceBayUpdateCard';

export type SettingsOverrides = Partial<{
  templateValues: Record<string, string>;
  registriesEnabled: boolean;
  registries: { name: string; url: string; branch?: string }[];
}> & {
  email?: Partial<{
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
    to: string[];
  }>;
};
