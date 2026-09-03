'use client';

import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import { Button, Field, Input } from '@/components/ui';
import { fetchGatewaySettings, updateGatewaySettings, TypedFetchError } from '@servicebay/api-client';

interface GatewayState {
  configured: boolean;
  type: string | null;
  host: string;
  username: string;
  hasPassword: boolean;
  ssl: boolean;
}

/**
 * Settings → Gateway (#333). FritzBox host/username/password edit.
 *
 * The install-fedora-coreos.sh writes config.gateway at install time;
 * before this section, the only way to update it was a full re-install
 * or hand-editing config.json on the box. The "Edit Gateway" button
 * on the Internet-Gateway card also linked here-but-wrongly to
 * /registry?selected=gateway — that link is fixed in this same PR.
 */
export default function GatewaySection() {
  const { addToast } = useToast();
  const [state, setState] = useState<GatewayState | null>(null);
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | null>('load');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  // Empty string means "no change". The placeholder reflects whether a
  // password is currently stored so the operator knows whether to type.
  const [password, setPassword] = useState('');
  const [ssl, setSsl] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchGatewaySettings();
        if (!cancelled) {
          setState(data);
          setHost(data.host);
          setUsername(data.username);
          setSsl(data.ssl);
        }
      } catch (e) {
        // Silently ignore errors on load
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const submit = async (test: boolean) => {
    if (!host.trim()) {
      addToast('error', 'Host is required');
      return;
    }
    setBusy(test ? 'test' : 'save');
    try {
      await updateGatewaySettings(
        host.trim(),
        username.trim(),
        password,
        ssl,
        test,
      );
      addToast(
        'success',
        test ? 'Connected — credentials saved' : 'Gateway saved',
      );
      // The POST only acks; re-read the view to reset the password
      // placeholder + reflect the new hasPassword.
      setState(await fetchGatewaySettings());
      setPassword('');
    } catch (e) {
      const message = e instanceof TypedFetchError
        ? e.message
        : e instanceof Error ? e.message : 'Unknown error';
      addToast(
        'error',
        test ? 'Connection test failed' : 'Could not save gateway',
        message,
      );
    } finally {
      setBusy(null);
    }
  };

  if (busy === 'load' || !state) {
    return (
      <p className="text-sm text-text-muted">
        <Loader2 className="w-4 h-4 animate-spin inline mr-2" />
        Loading gateway settings…
      </p>
    );
  }

  return (
    <>
        <div className="flex justify-end">
          {state.configured ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-status-ok">
              <CheckCircle2 size={14} /> Configured
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-status-warn">
              <AlertCircle size={14} /> Not configured
            </span>
          )}
        </div>

      <div className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Host">
            {(props) => (
              <Input
                {...props}
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="fritz.box or 192.168.178.1"
                className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface text-text font-mono"
                autoComplete="off"
              />
            )}
          </Field>
          <Field label="Username">
            {(props) => (
              <Input
                {...props}
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="fritz4554"
                className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface text-text font-mono"
                autoComplete="off"
              />
            )}
          </Field>
          <Field label="Password" className="sm:col-span-2">
            {(props) => (
              <Input
                {...props}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={state.hasPassword ? '•••••••• (leave blank to keep current)' : '(set a password)'}
                className="w-full px-3 py-2 text-sm rounded-card border border-border bg-surface text-text font-mono"
                autoComplete="new-password"
              />
            )}
          </Field>
        </div>

        <label className="inline-flex items-center gap-2 cursor-pointer text-sm text-text">
          <Input
            type="checkbox"
            checked={ssl}
            onChange={(e) => setSsl(e.target.checked)}
            className="w-4 h-4"
          />
          Use HTTPS for TR-064 (uncommon — most FritzBoxes use unencrypted port 49000)
        </label>

        <div className="flex gap-2 pt-2">
          <Button
            onClick={() => submit(true)}
            disabled={busy !== null}
            variant="primary"
            size="md"
          >
            {busy === 'test' && <Loader2 size={14} className="animate-spin" />}
            Test connection &amp; save
          </Button>
          <Button
            onClick={() => submit(false)}
            disabled={busy !== null}
            variant="secondary"
            size="md"
            title="Save without testing — useful when the FritzBox is currently unreachable"
          >
            {busy === 'save' && <Loader2 size={14} className="animate-spin" />}
            Save without test
          </Button>
        </div>

        <p className="text-[11px] text-text-muted italic">
          The TR-064 user needs the &quot;Smart Home&quot; permission in the FritzBox UI (System → FRITZ!Box-Benutzer). The password is stored encrypted at rest in <span className="font-mono">config.gateway.password</span>.
        </p>
      </div>
    </>
  );
}
