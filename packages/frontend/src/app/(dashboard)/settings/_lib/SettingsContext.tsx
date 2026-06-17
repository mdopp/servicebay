'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import SSHSetupModal from '@/components/SSHSetupModal';
import { useToast } from '@/providers/ToastProvider';
import { AppConfig } from '@/lib/config';
import { PodmanConnection } from '@/lib/nodes';
import {
  getNodes,
  createNode,
  editNode,
  deleteNode,
  setNodeAsDefault,
} from '@/app/actions/nodes';
import { checkConnection, checkFullConnection } from '@/app/actions/ssh';
import {
  DEFAULT_TEMPLATE_SCHEMA,
  type SettingsOverrides,
  type TemplateSettingsSchemaEntry,
} from './helpers';

export interface NodeHealthEntry {
  loading: boolean;
  online: boolean;
  auth: boolean;
  error?: string;
}

interface SettingsContextValue {
  loading: boolean;
  configReady: boolean;
  saving: boolean;
  refreshConfig: () => Promise<void>;

  // Server identity
  serverName: string;
  setServerName: (next: string) => void;

  // Email
  emailEnabled: boolean;
  setEmailEnabled: (next: boolean) => void;
  emailHost: string;
  setEmailHost: (next: string) => void;
  emailPort: number;
  setEmailPort: (next: number) => void;
  emailSecure: boolean;
  setEmailSecure: (next: boolean) => void;
  emailUser: string;
  setEmailUser: (next: string) => void;
  emailPass: string;
  setEmailPass: (next: string) => void;
  emailFrom: string;
  setEmailFrom: (next: string) => void;
  emailRecipients: string[];
  setEmailRecipients: (next: string[]) => void;

  // Registries
  registriesEnabled: boolean;
  setRegistriesEnabled: (next: boolean) => void;
  registries: { name: string; url: string; branch?: string }[];
  setRegistries: (next: { name: string; url: string; branch?: string }[]) => void;

  // Template settings
  templateSchema: Record<string, TemplateSettingsSchemaEntry>;
  templateValues: Record<string, string>;
  setTemplateValues: React.Dispatch<React.SetStateAction<Record<string, string>>>;

  // Persist
  persistSettings: (overrides?: SettingsOverrides) => Promise<void>;

  // Nodes
  nodes: PodmanConnection[];
  refreshNodes: () => Promise<void>;
  nodeHealth: Record<string, NodeHealthEntry>;
  checkHealth: (nodeName: string) => Promise<void>;
  submitNode: (
    mode: 'create' | 'edit',
    payload: { name: string; destination: string; identity: string; originalName?: string },
  ) => Promise<boolean>;
  removeNode: (name: string) => Promise<void>;
  setDefault: (name: string) => Promise<void>;

  // SSH modal
  openSSHModal: (defaults?: { host?: string; port?: number; user?: string }) => void;
  parseDestination: (destination: string) => { host: string; port: number; user: string };

  // Routing helpers
  router: ReturnType<typeof useRouter>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within <SettingsProvider>');
  return ctx;
}

const normalizeNodeName = (name: string) => name.trim().toLowerCase();

function dedupeNodes(list: PodmanConnection[]): PodmanConnection[] {
  const seen = new Map<string, PodmanConnection>();
  for (const node of list) {
    const key = normalizeNodeName(node.Name);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, node);
    } else {
      seen.set(key, { ...existing, Default: existing.Default || node.Default });
    }
  }
  const result = Array.from(seen.values());
  if (result.length > 0 && !result.some(n => n.Default)) {
    result[0].Default = true;
  }
  return result;
}

function parseDestination(destination: string): { host: string; port: number; user: string } {
  let host = '';
  let port = 22;
  let user = 'root';
  try {
    const urlStr = destination.includes('://') ? destination : `ssh://${destination}`;
    const parsed = new URL(urlStr);
    host = parsed.hostname;
    port = parsed.port ? parseInt(parsed.port) : 22;
    user = parsed.username || 'root';
  } catch {
    // ignore
  }
  return { host, port, user };
}

function useNodeHealthCheck(nodes: PodmanConnection[]) {
  const [nodeHealth, setNodeHealth] = useState<Record<string, NodeHealthEntry>>({});

  const checkHealth = useCallback(
    async (nodeName: string) => {
      setNodeHealth(prev => ({ ...prev, [nodeName]: { loading: true, online: false, auth: false } }));

      const node = nodes.find(n => n.Name === nodeName);
      if (!node) return;

      if (node.URI === 'local') {
        setNodeHealth(prev => ({
          ...prev,
          [nodeName]: {
            loading: false,
            online: false,
            auth: false,
            error: 'Legacy local nodes are unsupported. Edit this node to use ssh://user@host.',
          },
        }));
        return;
      }

      try {
        let host = '';
        let port = 22;
        let user = 'root';

        if (node.URI.startsWith('ssh://')) {
          const url = new URL(node.URI);
          host = url.hostname;
          port = url.port ? parseInt(url.port) : 22;
          user = url.username || 'root';
        } else {
          const parts = node.URI.split('@');
          if (parts.length === 2) {
            user = parts[0];
            host = parts[1];
          } else {
            host = node.URI;
          }
        }

        const res = await checkFullConnection(host, port, user, node.Identity);

        setNodeHealth(prev => ({
          ...prev,
          [nodeName]: {
            loading: false,
            online: res.success || res.stage === 'auth',
            auth: res.success,
            error: res.error,
          },
        }));
      } catch (e) {
        setNodeHealth(prev => ({
          ...prev,
          [nodeName]: { loading: false, online: false, auth: false, error: String(e) },
        }));
      }
    },
    [nodes],
  );

  return { nodeHealth, setNodeHealth, checkHealth };
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { addToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [configReady, setConfigReady] = useState(false);
  const [saving, setSaving] = useState(false);

  const [serverName, setServerName] = useState('');
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailHost, setEmailHost] = useState('');
  const [emailPort, setEmailPort] = useState(587);
  const [emailSecure, setEmailSecure] = useState(false);
  const [emailUser, setEmailUser] = useState('');
  const [emailPass, setEmailPass] = useState('');
  const [emailFrom, setEmailFrom] = useState('');
  const [emailRecipients, setEmailRecipients] = useState<string[]>([]);

  const [registriesEnabled, setRegistriesEnabled] = useState(true);
  const [registries, setRegistries] = useState<{ name: string; url: string; branch?: string }[]>([]);

  const [templateSchema, setTemplateSchema] = useState<Record<string, TemplateSettingsSchemaEntry>>(
    DEFAULT_TEMPLATE_SCHEMA,
  );
  const [templateValues, setTemplateValues] = useState<Record<string, string>>({
    DATA_DIR: DEFAULT_TEMPLATE_SCHEMA.DATA_DIR.default,
  });

  const [nodes, setNodes] = useState<PodmanConnection[]>([]);
  const { nodeHealth, checkHealth } = useNodeHealthCheck(nodes);

  const [isSSHModalOpen, setIsSSHModalOpen] = useState(false);
  const [sshModalDefaults, setSshModalDefaults] = useState({ host: '', port: 22, user: 'root' });

  // Track in-flight saves so callbacks can read the latest value without
  // forcing themselves into the dependency closure.
  const savingRef = useRef(saving);
  useEffect(() => { savingRef.current = saving; }, [saving]);

  const refreshNodes = useCallback(async () => {
    try {
      const list = await getNodes();
      setNodes(dedupeNodes(list));
    } catch (e) {
      console.error('Failed to fetch nodes', e);
    }
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error('Failed to fetch config');
      const data: AppConfig = await res.json();

      if (data.registries) {
        if (Array.isArray(data.registries)) {
          setRegistries(data.registries);
          setRegistriesEnabled(true);
        } else {
          setRegistries(data.registries.items);
          setRegistriesEnabled(data.registries.enabled);
        }
      }

      setServerName(data.serverName || '');

      const response = data as AppConfig & { templateSettingsSchema?: Record<string, TemplateSettingsSchemaEntry> };
      const schema = response.templateSettingsSchema || DEFAULT_TEMPLATE_SCHEMA;
      const defaults = Object.fromEntries(
        Object.entries(schema).map(([k, v]) => [k, v.default ?? '']),
      ) as Record<string, string>;
      const persisted = data.templateSettings || {};
      setTemplateSchema(schema);
      setTemplateValues({ ...defaults, ...persisted });

      if (data.notifications?.email) {
        const e = data.notifications.email;
        setEmailEnabled(e.enabled);
        setEmailHost(e.host);
        setEmailPort(e.port);
        setEmailSecure(e.secure);
        setEmailUser(e.user);
        setEmailPass(e.pass);
        setEmailFrom(e.from);
        setEmailRecipients(e.to || []);
      }

      await refreshNodes();
      setConfigReady(true);
    } catch (error) {
      console.error(error);
      addToast('error', 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [addToast, refreshNodes]);

  // Load persisted settings from the API once on mount. Async fetch that
  // synchronises React state with an external system (the config file) —
  // the canonical effect use.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async config load on mount, not a cascading-render anti-pattern
    void refreshConfig();
  }, [refreshConfig]);

  const persistSettings = useCallback(
    async (overrides?: SettingsOverrides) => {
      if (!configReady || savingRef.current) return;
      setSaving(true);
      try {
        const templateDefaults = Object.fromEntries(
          Object.entries(templateSchema).map(([key, meta]) => [key, meta.default ?? '']),
        ) as Record<string, string>;
        const effectiveTemplateValues = overrides?.templateValues ?? templateValues;
        const enforcedTemplateValues = {
          ...templateDefaults,
          ...effectiveTemplateValues,
        } as Record<string, string>;

        const effectiveRegistries = overrides?.registries ?? registries;
        const effectiveRegistriesEnabled = overrides?.registriesEnabled ?? registriesEnabled;

        const emailOverrides = overrides?.email ?? {};
        const emailConfig = {
          enabled: emailOverrides.enabled ?? emailEnabled,
          host: emailOverrides.host ?? emailHost,
          port: emailOverrides.port ?? emailPort,
          secure: emailOverrides.secure ?? emailSecure,
          user: emailOverrides.user ?? emailUser,
          pass: emailOverrides.pass ?? emailPass,
          from: emailOverrides.from ?? emailFrom,
          to: emailOverrides.to ?? emailRecipients,
        };

        const newConfig: Partial<AppConfig> = {
          serverName: serverName || undefined,
          templateSettings: enforcedTemplateValues,
          registries: {
            enabled: effectiveRegistriesEnabled,
            items: effectiveRegistries,
          },
          notifications: {
            email: emailConfig,
          },
        };

        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newConfig),
        });

        if (!res.ok) {
          const errorBody = await res.json().catch(() => ({}));
          throw new Error(errorBody.error || 'Failed to save settings');
        }

        addToast('success', 'Settings saved', 'Your changes were stored.');
      } catch (error) {
        console.error(error);
        addToast(
          'error',
          'Failed to save settings',
          error instanceof Error ? error.message : undefined,
        );
      } finally {
        setSaving(false);
      }
    },
    [
      addToast,
      configReady,
      emailEnabled,
      emailFrom,
      emailHost,
      emailPass,
      emailPort,
      emailRecipients,
      emailSecure,
      emailUser,
      registries,
      registriesEnabled,
      serverName,
      templateSchema,
      templateValues,
    ],
  );

  // Auto-probe health when nodes change.
  useEffect(() => {
    if (nodes.length === 0) return;
    nodes.forEach(n => {
      if (!nodeHealth[n.Name]) void checkHealth(n.Name);
    });
  }, [nodes, checkHealth, nodeHealth]);

  const openSSHModal = useCallback(
    (defaults?: { host?: string; port?: number; user?: string }) => {
      if (defaults) {
        setSshModalDefaults({
          host: defaults.host ?? '',
          port: defaults.port ?? 22,
          user: defaults.user ?? 'root',
        });
      }
      setIsSSHModalOpen(true);
    },
    [],
  );

  const submitNode = useCallback(
    async (
      mode: 'create' | 'edit',
      payload: { name: string; destination: string; identity: string; originalName?: string },
    ) => {
      if (!payload.name || !payload.destination || !payload.identity) return false;

      const { host, port, user } = parseDestination(payload.destination);

      const normalizedName = normalizeNodeName(payload.name);
      if (normalizedName === 'local') {
        addToast('error', 'Local is reserved', 'The Local node is managed automatically. Please use a different name.');
        return false;
      }

      if (host) {
        const check = await checkConnection(host, port);
        if (!check.success || !check.isOpen) {
          addToast('error', 'Connection Failed', `Could not connect to ${host}:${port}. Is the server reachable?`);
          return false;
        }
      }

      try {
        const result = mode === 'edit' && payload.originalName
          ? await editNode(payload.originalName, payload.name, payload.destination, payload.identity)
          : await createNode(payload.name, payload.destination, payload.identity);

        if (result.success) {
          await refreshNodes();
          const warning = (result as { warning?: string }).warning;
          if (warning) {
            if (
              warning.includes('timed out') ||
              warning.includes('Permission denied') ||
              warning.includes('password') ||
              warning.includes('publickey')
            ) {
              addToast('warning', 'SSH Connection Failed', 'The node was saved, but we could not connect. It seems password-less SSH is not configured.');
              if (host) openSSHModal({ host, port, user });
            } else {
              addToast('warning', mode === 'edit' ? 'Node updated with warning' : 'Node added with warning', warning);
            }
          } else {
            addToast('success', mode === 'edit' ? 'Node updated' : 'Node added');
          }
          return true;
        }

        addToast(
          'error',
          mode === 'edit' ? 'Failed to update node' : 'Failed to add node',
          (result as { error?: string }).error,
        );
        return false;
      } catch (error) {
        addToast(
          'error',
          mode === 'edit' ? 'Failed to update node' : 'Failed to add node',
          error instanceof Error ? error.message : String(error),
        );
        return false;
      }
    },
    [addToast, openSSHModal, refreshNodes],
  );

  const removeNode = useCallback(
    async (name: string) => {
      const res = await deleteNode(name);
      if (res.success) {
        await refreshNodes();
        addToast('success', 'Node removed');
      } else {
        addToast('error', 'Failed to remove node');
      }
    },
    [addToast, refreshNodes],
  );

  const setDefault = useCallback(
    async (name: string) => {
      const res = await setNodeAsDefault(name);
      if (res.success) {
        await refreshNodes();
        addToast('success', 'Default node updated');
      } else {
        addToast('error', 'Failed to set default node');
      }
    },
    [addToast, refreshNodes],
  );

  const value: SettingsContextValue = useMemo(
    () => ({
      loading,
      configReady,
      saving,
      refreshConfig,
      serverName,
      setServerName,
      emailEnabled,
      setEmailEnabled,
      emailHost,
      setEmailHost,
      emailPort,
      setEmailPort,
      emailSecure,
      setEmailSecure,
      emailUser,
      setEmailUser,
      emailPass,
      setEmailPass,
      emailFrom,
      setEmailFrom,
      emailRecipients,
      setEmailRecipients,
      registriesEnabled,
      setRegistriesEnabled,
      registries,
      setRegistries,
      templateSchema,
      templateValues,
      setTemplateValues,
      persistSettings,
      nodes,
      refreshNodes,
      nodeHealth,
      checkHealth,
      submitNode,
      removeNode,
      setDefault,
      openSSHModal,
      parseDestination,
      router,
    }),
    [
      loading,
      configReady,
      saving,
      refreshConfig,
      serverName,
      emailEnabled,
      emailHost,
      emailPort,
      emailSecure,
      emailUser,
      emailPass,
      emailFrom,
      emailRecipients,
      registriesEnabled,
      registries,
      templateSchema,
      templateValues,
      persistSettings,
      nodes,
      refreshNodes,
      nodeHealth,
      checkHealth,
      submitNode,
      removeNode,
      setDefault,
      openSSHModal,
      router,
    ],
  );

  return (
    <SettingsContext.Provider value={value}>
      {children}
      <SSHSetupModal
        isOpen={isSSHModalOpen}
        onClose={() => setIsSSHModalOpen(false)}
        initialHost={sshModalDefaults.host}
        initialPort={sshModalDefaults.port}
        initialUser={sshModalDefaults.user}
      />
    </SettingsContext.Provider>
  );
}
