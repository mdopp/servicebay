export type CheckType = 'http' | 'ping' | 'script' | 'podman' | 'service' | 'systemd';

export interface CheckConfig {
  id: string;
  name: string;
  type: CheckType;
  target: string; // URL, IP, Container ID, or Script content
  interval: number; // in seconds
  enabled: boolean;
  created_at: string;
  // HTTP specific options
  httpConfig?: {
    expectedStatus?: number;
    bodyMatch?: string;
    bodyMatchType?: 'contains' | 'regex';
  };
}

export interface CheckResult {
  check_id: string;
  timestamp: string;
  status: 'ok' | 'fail';
  latency?: number; // in ms
  message?: string;
}

export interface CheckStatus {
  id: string;
  last_run: string | null;
  status: 'ok' | 'fail' | 'unknown';
  message: string | null;
  latency: number | null;
}
