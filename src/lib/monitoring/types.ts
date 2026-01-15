export type CheckType = 'http' | 'ping' | 'script' | 'podman' | 'service' | 'systemd' | 'fritzbox' | 'node' | 'agent';

export interface CheckConfig {
  id: string;
  name: string;
  type: CheckType;
  target: string; // URL, IP, Container ID, or Script content
  interval: number; // in seconds
  enabled: boolean;
  created_at: string;
  nodeName?: string; // Optional node name for remote execution
  // HTTP specific options
  httpConfig?: {
    expectedStatus?: number;
    bodyMatch?: string;
    bodyMatchType?: 'contains' | 'regex';
  };
  // FritzBox specific options
  fritzboxConfig?: {
    host?: string;
    user?: string;
    password?: string;
  };
}

export interface CheckResult {
  check_id: string;
  timestamp: string;
  status: 'ok' | 'fail';
  latency?: number; // in ms
  message?: string;
}

// Extended type for UI
export interface Check extends CheckConfig {
  status: 'ok' | 'fail' | 'unknown';
  lastRun: string | null;
  lastResult: string | null;
  message?: string; 
  history: { status: 'ok' | 'fail'; latency: number; timestamp: string }[];
}
