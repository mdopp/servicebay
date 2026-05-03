// Pure helpers + shared types extracted from the original settings page so
// every tab can import them without dragging in stateful logic.
import type { BackupLogEntry, BackupLogStatus } from '@/lib/systemBackup';

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
      channel?: 'stable' | 'test' | 'dev';
    };
  };
}

export interface SystemBackupEntrySummary {
  fileName: string;
  createdAt: string;
  size: number;
}

export type BackupStreamEvent =
  | { type: 'log'; entry: BackupLogEntry }
  | { type: 'done'; backup: SystemBackupEntrySummary }
  | { type: 'error'; message: string };

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

export const LOG_STATUS_BADGES: Record<BackupLogStatus, string> = {
  info: 'text-slate-600 bg-slate-100 dark:text-slate-300 dark:bg-slate-800',
  success: 'text-emerald-700 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-900/30',
  error: 'text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-900/30',
  skip: 'text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/30',
};

export const LOG_STATUS_DOTS: Record<BackupLogStatus, string> = {
  info: 'bg-slate-400',
  success: 'bg-emerald-500',
  error: 'bg-red-500',
  skip: 'bg-amber-500',
};

export const formatBytes = (size: number): string => {
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const precision = value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
};

const QUADLET_EXTENSIONS = ['.container', '.service', '.kube', '.yml', '.yaml', '.pod', '.network', '.volume'];

export type ServiceDataFileCategory = 'config' | 'logs' | 'certs' | 'data' | 'other';

export const SERVICE_DATA_CATEGORY_LABELS: Record<ServiceDataFileCategory, string> = {
  config: 'Configuration',
  logs: 'Logs',
  certs: 'Certificates',
  data: 'Database',
  other: 'Other Files',
};

export const SERVICE_DATA_CATEGORY_ICONS: Record<ServiceDataFileCategory, string> = {
  config: '⚙️',
  logs: '📋',
  certs: '🔒',
  data: '🗄️',
  other: '📄',
};

function categorizeServiceDataFile(filePath: string): ServiceDataFileCategory {
  const lower = filePath.toLowerCase();
  const fileName = lower.split('/').pop() || '';
  const dir = lower.split('/').slice(0, -1).join('/');

  if (dir.includes('proxy_host') || dir.includes('conf.d') || (dir.includes('nginx') && fileName.endsWith('.conf')))
    return 'config';
  if (fileName.endsWith('.conf') || fileName.endsWith('.json') || fileName.endsWith('.yml') || fileName.endsWith('.yaml'))
    return 'config';
  if (fileName === 'settings' || fileName === 'config' || dir.includes('settings'))
    return 'config';

  if (dir.includes('logs') || dir.includes('log') || fileName.endsWith('.log'))
    return 'logs';

  if (dir.includes('letsencrypt') || dir.includes('certs') || dir.includes('ssl') || dir.includes('tls'))
    return 'certs';
  if (fileName.endsWith('.pem') || fileName.endsWith('.crt') || fileName.endsWith('.key') || fileName.endsWith('.cert'))
    return 'certs';

  if (fileName.endsWith('.sqlite') || fileName.endsWith('.db') || fileName.endsWith('.sql'))
    return 'data';
  if (dir.includes('database') || dir.includes('db'))
    return 'data';

  return 'other';
}

export function groupServiceDataFiles(files: string[]): { category: ServiceDataFileCategory; files: string[] }[] {
  const groups = new Map<ServiceDataFileCategory, string[]>();
  for (const file of files) {
    const cat = categorizeServiceDataFile(file);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(file);
  }
  const order: ServiceDataFileCategory[] = ['config', 'certs', 'data', 'logs', 'other'];
  return order
    .filter(cat => groups.has(cat))
    .map(cat => ({ category: cat, files: groups.get(cat)! }));
}

export function groupFilesByService(
  files: { relativePath: string; fileName: string }[],
): { service: string; files: { relativePath: string; fileName: string }[] }[] {
  const groups = new Map<string, { relativePath: string; fileName: string }[]>();
  for (const file of files) {
    const name = file.fileName;
    let service = '';
    for (const ext of QUADLET_EXTENSIONS) {
      if (name.endsWith(ext)) {
        const stem = name.slice(0, -ext.length);
        const dashIdx = stem.indexOf('-');
        service = dashIdx > 0 ? stem.slice(0, dashIdx) : stem;
        const dotIdx = service.indexOf('.');
        if (dotIdx > 0) service = service.slice(0, dotIdx);
        break;
      }
    }
    if (!service) service = '_other';
    if (!groups.has(service)) groups.set(service, []);
    groups.get(service)!.push(file);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => {
      if (a === '_other') return 1;
      if (b === '_other') return -1;
      return a.localeCompare(b);
    })
    .map(([service, list]) => ({ service, files: list }));
}

export function resolveFilePreviewLanguage(fileName: string): string {
  if (fileName.endsWith('.yml') || fileName.endsWith('.yaml')) return 'yaml';
  if (fileName.endsWith('.kube') || fileName.endsWith('.container') || fileName.endsWith('.pod') || fileName.endsWith('.network') || fileName.endsWith('.volume')) return 'ini';
  if (fileName.endsWith('.json')) return 'json';
  if (fileName.endsWith('.sh')) return 'bash';
  return 'bash';
}
