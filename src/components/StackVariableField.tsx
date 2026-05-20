'use client';

import { RefreshCw } from 'lucide-react';
import type { VariableMeta } from '@/lib/registry';
import { typedFetch, GenerateSecretResponseSchema } from '@servicebay/api-client';

interface StackVariable {
  name: string;
  value: string;
  meta?: VariableMeta;
}

interface StackVariableFieldDeviceContext {
  /** Map of `devicePath` (e.g. `/dev/serial/by-id`) → list of devices
   *  the agent reported. The renderer reads this for the device
   *  dropdown options. */
  deviceOptions: Record<string, string[]>;
  /** Latch true while a refresh is in flight so the dropdown shows
   *  `Loading devices...` and the refresh button spins. */
  loadingDevices: boolean;
  /** Whether the operator has selected a node. When false, the
   *  dropdown shows `Select a node first` and the refresh button is
   *  hidden — without a node we have no agent to query. */
  canRefresh: boolean;
  /** Trigger a fresh `/api/system/devices` lookup for the given
   *  device path. The parent owns the actual fetch + state writes so
   *  this component stays presentational. */
  onRefresh: (devicePath: string) => void;
}

interface StackVariableFieldProps {
  variable: StackVariable;
  onChange: (value: string) => void;
  /** Reverse-proxy public domain so `subdomain` fields can show
   *  `.example.com` as the suffix. Defaults to `'example.com'` when
   *  unset — matches the pre-extraction inline behaviour. */
  publicDomain?: string;
  /** Optional device-picker context. Omitting it makes `type: 'device'`
   *  variables render a disabled dropdown — same fallback both
   *  consumers had before. */
  deviceContext?: StackVariableFieldDeviceContext;
  /**
   * For subdomain variables: change the exposure profile (public vs
   * lan-only). Omit to hide the inline toggle — the field then shows
   * only the template default as a static badge. The wizard owns
   * the state mutation via useStackInstall.setVariableExposure.
   */
  onExposureChange?: (exposure: 'public' | 'internal' | 'lan') => void;
  /** Tailwind class shape. Pre-extraction the two consumers used
   *  slightly different paddings/border-radii; defaulting to the
   *  InstallerModal shape and letting OnboardingWizard pass its own
   *  via this prop keeps both layouts pixel-identical while still
   *  sharing the type-dispatch logic. */
  inputClassName?: string;
}

/**
 * Renders a single install-time variable input. Dispatches on
 * `variable.meta.type` to the appropriate widget: select, device,
 * subdomain, password, secret, or plain text fallback.
 *
 * Replaces the near-duplicate renderers in OnboardingWizard
 * (lines 2469–2537 before refactor) and InstallerModal (lines
 * 484–600 before refactor). Both copies were doing the same type
 * dispatch with subtly different copy that made future bugs likely
 * to land in only one site. See #341 (consolidation phase 2,
 * incremental step 1).
 */
export default function StackVariableField({
  variable: v,
  onChange,
  publicDomain,
  deviceContext,
  onExposureChange,
  inputClassName,
}: StackVariableFieldProps) {
  const cls = inputClassName ?? 'w-full p-2 border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded focus:ring-2 focus:ring-blue-500';

  // Select dropdown
  if (v.meta?.type === 'select' && v.meta.options) {
    return (
      <select
        value={v.value}
        onChange={(e) => onChange(e.target.value)}
        className={`${cls} appearance-none`}
      >
        <option value="" disabled>Select...</option>
        {v.meta.options.map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }

  // Device selector
  if (v.meta?.type === 'device') {
    const devPath = v.meta.devicePath || '/dev/serial/by-id';
    const devices = deviceContext?.deviceOptions[devPath] || [];
    const loading = !!deviceContext?.loadingDevices;
    const placeholder = loading
      ? 'Loading devices...'
      : !deviceContext?.canRefresh
        ? 'Select a node first'
        : devices.length === 0
          ? 'No devices found'
          : 'Select device...';
    return (
      <div className="flex gap-2">
        <select
          value={v.value}
          onChange={(e) => onChange(e.target.value)}
          className={`${cls} appearance-none flex-1`}
        >
          <option value="" disabled>{placeholder}</option>
          {devices.map(dev => (
            <option key={dev} value={dev}>{dev.replace(`${devPath}/`, '')}</option>
          ))}
        </select>
        {deviceContext?.canRefresh && (
          <button
            type="button"
            onClick={() => deviceContext.onRefresh(devPath)}
            className="p-2 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
            title="Refresh device list"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>
        )}
      </div>
    );
  }

  // Subdomain field (shows .domain suffix). When `onExposureChange` is
  // provided, an inline Public/Internal/LAN segmented toggle hangs to
  // the right — operators override the per-template default; the choice
  // drives whether the install auto-requests a Let's Encrypt cert and
  // whether NPM binds the LAN-only access list. Without
  // `onExposureChange` (e.g. read-only contexts) we fall back to a
  // small static badge so the operator still sees what's planned.
  if (v.meta?.type === 'subdomain') {
    const exposure: 'public' | 'internal' | 'lan' =
      v.meta.exposure === 'public' ? 'public'
      : v.meta.exposure === 'internal' ? 'internal'
      : 'lan';
    const badgeClass = exposure === 'public'
      ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100'
      : exposure === 'internal'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-100'
        : 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
    const badgeLabel = exposure === 'public' ? 'Public' : exposure === 'internal' ? 'Internal' : 'LAN';
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-0 flex-1 min-w-[12rem]">
          <input
            type="text"
            value={v.value}
            onChange={(e) => onChange(e.target.value)}
            className={`${cls} rounded-r-none border-r-0`}
            placeholder={v.meta.default || 'subdomain'}
          />
          <span className="px-3 py-2 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-700 text-gray-500 dark:text-gray-400 rounded-r text-sm whitespace-nowrap">
            .{publicDomain || 'example.com'}
          </span>
        </div>
        {onExposureChange ? (
          <div className="inline-flex rounded border border-gray-300 dark:border-gray-700 overflow-hidden text-xs" role="group" aria-label="Exposure profile">
            <button
              type="button"
              onClick={() => onExposureChange('public')}
              className={`px-2.5 py-1.5 ${exposure === 'public' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
              title="Reachable from the internet on 80/443. Auto-requests a Let's Encrypt cert at install."
            >
              Public
            </button>
            <button
              type="button"
              onClick={() => onExposureChange('internal')}
              className={`px-2.5 py-1.5 border-l border-gray-300 dark:border-gray-700 ${exposure === 'internal' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
              title="LAN-only access but with a real Let's Encrypt cert. Authelia forward-auth works (needs HTTPS); NPM blocks non-LAN IPs. ACME challenge bypasses the allowlist so LE can validate."
            >
              Internal
            </button>
            <button
              type="button"
              onClick={() => onExposureChange('lan')}
              className={`px-2.5 py-1.5 border-l border-gray-300 dark:border-gray-700 ${exposure === 'lan' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
              title="LAN-only, plain HTTP — no cert provisioned. Authelia forward-auth does NOT work here (rejects http scheme)."
            >
              LAN
            </button>
          </div>
        ) : (
          <span className={`px-2 py-0.5 rounded text-xs ${badgeClass}`}>{badgeLabel}</span>
        )}
      </div>
    );
  }

  // Password field
  if (v.meta?.type === 'password') {
    return (
      <input
        type="password"
        value={v.value}
        onChange={(e) => onChange(e.target.value)}
        className={cls}
        placeholder={`Enter ${v.name.toLowerCase().replace(/_/g, ' ')}`}
        autoComplete="new-password"
      />
    );
  }

  // Secret (auto-generated default; regenerate button picks a fresh
  // random value)
  if (v.meta?.type === 'secret') {
    return (
      <div className="flex gap-2">
        <input
          type="text"
          value={v.value}
          onChange={(e) => onChange(e.target.value)}
          className={`${cls} font-mono text-xs flex-1`}
          spellCheck={false}
          autoComplete="off"
        />
        <button
          type="button"
          onClick={async () => {
            try {
              const { secret } = await typedFetch(
                '/api/install/generate-secret',
                GenerateSecretResponseSchema,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({}),
                },
              );
              onChange(secret);
            } catch {
              // If the server is unreachable mid-edit the operator can
              // still type a value manually; swallowing keeps the form
              // responsive instead of throwing into React.
            }
          }}
          className="p-2 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          title="Regenerate"
        >
          <RefreshCw size={16} />
        </button>
      </div>
    );
  }

  // Default — plain text. Placeholder prefers `meta.example`, then
  // `meta.default` as a hint, falling back to a generic prompt.
  return (
    <input
      type="text"
      value={v.value}
      onChange={(e) => onChange(e.target.value)}
      className={cls}
      placeholder={v.meta?.example
        ? `e.g. ${v.meta.example}`
        : (v.meta?.default ? `Default: ${v.meta.default}` : `Value for ${v.name}`)}
    />
  );
}
