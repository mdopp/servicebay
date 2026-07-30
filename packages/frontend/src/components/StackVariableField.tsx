'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { VariableMeta } from '@servicebay/api-client';
import { typedFetch, GenerateSecretResponseSchema } from '@servicebay/api-client';
import { Button, Input, Select } from '@/components/ui';

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
  const cls = inputClassName ?? 'w-full p-2 border border-border bg-surface-2 text-text rounded focus:ring-2 focus:ring-accent';

  // Select dropdown
  if (v.meta?.type === 'select' && v.meta.options) {
    return (
      <Select
        value={v.value}
        onChange={(e) => onChange(e.target.value)}
        className={`${cls} appearance-none`}
      >
        <option value="" disabled>Select...</option>
        {v.meta.options.map(opt => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </Select>
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
        <Select
          value={v.value}
          onChange={(e) => onChange(e.target.value)}
          className={`${cls} appearance-none flex-1`}
        >
          <option value="" disabled>{placeholder}</option>
          {devices.map(dev => (
            <option key={dev} value={dev}>{dev.replace(`${devPath}/`, '')}</option>
          ))}
        </Select>
        {deviceContext?.canRefresh && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => deviceContext.onRefresh(devPath)}
            title="Refresh device list"
            size="sm"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </Button>
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
      ? 'bg-status-info/10 text-status-info'
      : exposure === 'internal'
        ? 'bg-status-warn/10 text-status-warn'
        : 'bg-surface text-text-muted';
    const badgeLabel = exposure === 'public' ? 'Public' : exposure === 'internal' ? 'Internal' : 'LAN';
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-0 flex-1 min-w-[12rem]">
          <Input
            type="text"
            value={v.value}
            onChange={(e) => onChange(e.target.value)}
            className={`${cls} rounded-r-none border-r-0`}
            placeholder={v.meta.default || 'subdomain'}
          />
          <span className="px-3 py-2 bg-surface-2 border border-border text-text-muted rounded-r text-sm whitespace-nowrap">
            .{publicDomain || 'example.com'}
          </span>
        </div>
        {onExposureChange ? (
          <div className="inline-flex rounded border border-border overflow-hidden text-xs" role="group" aria-label="Exposure profile">
            <Button
              variant={exposure === 'public' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => onExposureChange('public')}
              title="Reachable from the internet on 80/443. Auto-requests a Let's Encrypt cert at install."
              className="rounded-none"
            >
              Public
            </Button>
            <Button
              variant={exposure === 'internal' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => onExposureChange('internal')}
              title="LAN-only access but with a real Let's Encrypt cert. Authelia forward-auth works (needs HTTPS); NPM blocks non-LAN IPs. ACME challenge bypasses the allowlist so LE can validate."
              className="rounded-none border-l border-border"
            >
              Internal
            </Button>
            <Button
              variant={exposure === 'lan' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => onExposureChange('lan')}
              title="LAN-only, plain HTTP — no cert provisioned. Authelia forward-auth does NOT work here (rejects http scheme)."
              className="rounded-none border-l border-border"
            >
              LAN
            </Button>
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
      <Input
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
  // random value). Delegated to a small stateful subcomponent so the
  // regenerate request can drive a pending/disabled/error affordance
  // (hooks can't live behind these early-return branches).
  if (v.meta?.type === 'secret') {
    return <SecretField value={v.value} onChange={onChange} cls={cls} />;
  }

  // Default — plain text. Placeholder prefers `meta.example`, then
  // `meta.default` as a hint, falling back to a generic prompt.
  return (
    <Input
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

const fetchGeneratedSecret = () =>
  typedFetch('/api/install/generate-secret', GenerateSecretResponseSchema, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

/**
 * Secret variable input + regenerate button. Owns the in-flight state so
 * the operator gets feedback while `/api/install/generate-secret` is
 * pending: the button disables + spins, and a failed request surfaces a
 * visible inline hint instead of silence (#2186). The field stays typeable
 * throughout — the operator can always enter a value manually.
 */
function SecretField({
  value,
  onChange,
  cls,
}: {
  value: string;
  onChange: (value: string) => void;
  cls: string;
}) {
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState(false);

  // Unreachable mid-edit surfaces a visible hint rather than failing silently;
  // the operator can still type a value manually. The `regenerating` guard
  // stops a double-fire from a second click while the request is pending.
  const regenerate = async () => {
    if (regenerating) return;
    setRegenerating(true);
    setError(false);
    try {
      onChange((await fetchGeneratedSecret()).secret);
    } catch {
      setError(true);
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <div>
      <div className="flex gap-2">
        <Input
          type="text" value={value} onChange={(e) => onChange(e.target.value)}
          className={`${cls} font-mono text-xs flex-1`} spellCheck={false} autoComplete="off"
        />
        <Button
          type="button" onClick={regenerate} disabled={regenerating} aria-busy={regenerating}
          title="Regenerate"
          variant="secondary"
          size="sm"
        >
          <RefreshCw size={16} className={regenerating ? 'animate-spin' : ''} />
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-status-fail">
          Couldn&apos;t generate a secret — check your connection or type one manually.
        </p>
      )}
    </div>
  );
}
