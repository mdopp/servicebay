import { PortMapping as GraphPortMapping } from './types';

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'external-link';

export const getExternalLinkNodeId = (link: { id?: string; name?: string }): string =>
  `link-${link.id || slugify(link.name || 'external-link')}`;

export const normalizeExternalTargets = (input: unknown): string[] => {
  if (!input) return [];
  const rawValues = Array.isArray(input) ? input : [input];
  return rawValues
    .flatMap((value) => String(value).split(/[\,\n]+/))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

export const parseTargetHostPort = (target: string): { host: string; port?: number } => {
  const trimmed = target.trim();
  if (!trimmed) return { host: '' };

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return {
        host: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port, 10) : undefined,
      };
    } catch {
      // Ignore parse errors and fall through to generic handling.
    }
  }

  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']');
    if (closing !== -1) {
      const host = trimmed.slice(1, closing);
      const portPart = trimmed.slice(closing + 1);
      const port = portPart.startsWith(':') ? parseInt(portPart.slice(1), 10) : undefined;
      return { host, port: Number.isFinite(port) ? port : undefined };
    }
  }

  const parts = trimmed.split(':');
  if (parts.length === 1) {
    return { host: parts[0] };
  }

  const portCandidate = parseInt(parts[parts.length - 1], 10);
  if (Number.isFinite(portCandidate)) {
    const hostPart = parts.slice(0, parts.length - 1).join(':');
    return { host: hostPart, port: portCandidate };
  }

  return { host: trimmed };
};

export const buildExternalLinkPorts = (targets: string[]): GraphPortMapping[] =>
  targets
    .map(parseTargetHostPort)
    .filter((entry) => Boolean(entry.host) && Number.isFinite(entry.port) && (entry.port ?? 0) > 0)
    .map((entry) => ({
      host: entry.port as number,
      container: entry.port as number,
      hostIp: entry.host,
      protocol: 'tcp',
      source: 'external-link',
    }));
