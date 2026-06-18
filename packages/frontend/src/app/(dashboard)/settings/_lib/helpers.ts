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

export interface AppUpdateStatus {
  hasUpdate: boolean;
  current: string;
  /**
   * Release tag is ahead but the `:latest` image hasn't been published yet
   * (release-please cuts the tag before the Release workflow pushes the image).
   * Shown as "new version building" rather than an actionable update.
   */
  imageBuilding?: boolean;
  latest: {
    version: string;
    url: string;
    date: string;
    notes: string;
  } | null;
  config: {
    autoUpdate: {
      enabled: boolean;
      schedule: string;
    };
  };
}

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
