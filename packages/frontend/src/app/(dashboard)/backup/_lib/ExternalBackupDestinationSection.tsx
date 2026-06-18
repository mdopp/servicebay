'use client';

import { useEffect, useState } from 'react';
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useToast } from '@/providers/ToastProvider';
import type { ExternalBackupTarget } from '@/lib/config';

type TargetType = 'fritzbox' | 'ftp' | 'ssh';

interface TargetView {
  type: TargetType;
  host: string;
  username: string;
  hasPassword: boolean;
  hasPrivateKey: boolean;
  port?: number;
  secure?: boolean;
  dir?: string;
  inheritsGateway: boolean;
}

const INPUT_CLASS =
  'w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white';
const LABEL_CLASS = 'block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1';

function Field({
  label,
  optional,
  children,
  full,
}: {
  label: string;
  optional?: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={full ? 'sm:col-span-2' : undefined}>
      <label className={LABEL_CLASS}>
        {label} {optional && <span className="text-gray-400">{optional}</span>}
      </label>
      {children}
    </div>
  );
}

const TYPE_OPTIONS = [
  { val: 'fritzbox', label: 'FritzBox NAS (FTP)' },
  { val: 'ftp', label: 'FTP server' },
  { val: 'ssh', label: 'SSH / SFTP' },
] as const;

function TypePicker({ type, onChange }: { type: TargetType; onChange: (t: TargetType) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {TYPE_OPTIONS.map(opt => (
        <button
          key={opt.val}
          type="button"
          onClick={() => onChange(opt.val)}
          className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
            type === opt.val
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
              : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Settings → Backups: where config-survival backups go (#1525/#1527).
 *
 * Two issues, one panel:
 *  - #1525 — one place to enter FritzBox NAS/FTP creds, defaulting to the
 *    gateway creds (the FritzBox is both the gateway and the USB-NAS host). The
 *    `fritzbox` type leaves host/user/password blank to inherit `config.gateway`,
 *    or overrides them for a dedicated FRITZ.NAS user.
 *  - #1527 — the destination is configurable (separate FTP host, or SSH), not
 *    hardcoded to the FritzBox. Defaults to FritzBox FTP so existing boxes are
 *    unaffected.
 *
 * Mirrors GatewaySection's "Test connection & save" affordance. `onSaved`
 * lets the parent refresh its NAS overview after a save.
 */
interface FormState {
  type: TargetType;
  host: string;
  port: string;
  username: string;
  password: string;
  privateKey: string;
  secure: boolean;
  dir: string;
}

const EMPTY_FORM: FormState = {
  type: 'fritzbox',
  host: '',
  port: '',
  username: '',
  password: '',
  privateKey: '',
  secure: false,
  dir: '',
};

/** Map the form state to the API target shape. Blank secrets are dropped so the
 *  backend keeps the stored value (or, for fritzbox, inherits the gateway). */
function buildTarget(f: FormState): ExternalBackupTarget {
  if (f.type === 'fritzbox') {
    return {
      type: 'fritzbox',
      host: f.host.trim() || undefined,
      username: f.username.trim() || undefined,
      password: f.password || undefined,
      secure: f.secure,
    };
  }
  if (f.type === 'ftp') {
    return {
      type: 'ftp',
      host: f.host.trim(),
      port: f.port ? Number(f.port) : undefined,
      username: f.username.trim(),
      password: f.password,
      secure: f.secure,
      dir: f.dir.trim() || undefined,
    };
  }
  return {
    type: 'ssh',
    host: f.host.trim(),
    port: f.port ? Number(f.port) : undefined,
    username: f.username.trim(),
    password: f.password || undefined,
    privateKey: f.privateKey || undefined,
    dir: f.dir.trim() || undefined,
  };
}

/** The destination form fields (presentational) — split out to keep the
 *  stateful section small. */
/** Placeholder copy precomputed off the type + masked view, so the JSX below
 *  stays free of nested ternaries (keeps complexity down). */
function placeholders(form: FormState, view: TargetView | null) {
  const isFritz = form.type === 'fritzbox';
  return {
    host: isFritz ? view?.host || 'fritz.box (from gateway)' : form.type === 'ssh' ? 'nas.local' : 'ftp.example.com',
    user: isFritz ? view?.username || 'fritz user (from gateway)' : 'backup-user',
    password: view?.hasPassword ? '•••••••• (leave blank to keep)' : isFritz ? '(from gateway)' : '(set a password)',
    privateKey: view?.hasPrivateKey ? '(key stored — leave blank to keep)' : '-----BEGIN OPENSSH PRIVATE KEY-----',
  };
}

type FieldsProps = {
  form: FormState;
  view: TargetView | null;
  set: (patch: Partial<FormState>) => void;
};

/** Host / port / username / password (+ key + dir for non-fritzbox). */
function CredentialGrid({ form, view, set }: FieldsProps) {
  const isFritz = form.type === 'fritzbox';
  const optHint = isFritz ? '(optional)' : undefined;
  const ph = placeholders(form, view);
  return (
    <div className="grid sm:grid-cols-2 gap-3">
      <Field label="Host" optional={optHint}>
        <input type="text" className={INPUT_CLASS} value={form.host} onChange={e => set({ host: e.target.value })} placeholder={ph.host} autoComplete="off" />
      </Field>
      {!isFritz && (
        <Field label="Port">
          <input type="number" className={INPUT_CLASS} value={form.port} onChange={e => set({ port: e.target.value })} placeholder={form.type === 'ssh' ? '22' : '21'} />
        </Field>
      )}
      <Field label="Username" optional={optHint}>
        <input type="text" className={INPUT_CLASS} value={form.username} onChange={e => set({ username: e.target.value })} placeholder={ph.user} autoComplete="off" />
      </Field>
      <Field label="Password" optional={optHint}>
        <input type="password" className={INPUT_CLASS} value={form.password} onChange={e => set({ password: e.target.value })} placeholder={ph.password} autoComplete="new-password" />
      </Field>
      {form.type === 'ssh' && (
        <Field label="Private key" optional="(optional — for key auth)" full>
          <textarea className={`${INPUT_CLASS} font-mono text-xs`} rows={3} value={form.privateKey} onChange={e => set({ privateKey: e.target.value })} placeholder={ph.privateKey} />
        </Field>
      )}
      {!isFritz && (
        <Field label="Remote directory" optional="(optional)" full>
          <input type="text" className={INPUT_CLASS} value={form.dir} onChange={e => set({ dir: e.target.value })} placeholder="/backups (defaults to the login directory)" />
        </Field>
      )}
    </div>
  );
}

function DestinationFields({ form, view, set }: FieldsProps) {
  const isFritz = form.type === 'fritzbox';
  return (
    <>
      <TypePicker type={form.type} onChange={t => set({ type: t })} />
      {isFritz && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          Leave the fields blank to use the gateway FritzBox credentials. Override them for a dedicated FRITZ.NAS / file-access user.
        </p>
      )}
      <CredentialGrid form={form} view={view} set={set} />
      {(isFritz || form.type === 'ftp') && (
        <label className="inline-flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
          <input type="checkbox" checked={form.secure} onChange={e => set({ secure: e.target.checked })} className="w-4 h-4" />
          Use FTPS (explicit AUTH TLS) — uncommon on a LAN FritzBox
        </label>
      )}
    </>
  );
}

export default function ExternalBackupDestinationSection({ onSaved }: { onSaved?: () => void }) {
  const { addToast } = useToast();
  const [view, setView] = useState<TargetView | null>(null);
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | null>('load');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const set = (patch: Partial<FormState>) => setForm(prev => ({ ...prev, ...patch }));

  useEffect(() => {
    fetch('/api/system/external-backup/target')
      .then(r => (r.ok ? r.json() : null))
      .then((data: { target: TargetView } | null) => {
        if (!data?.target) return;
        const t = data.target;
        setView(t);
        setForm({
          ...EMPTY_FORM,
          type: t.type,
          host: t.host ?? '',
          port: t.port ? String(t.port) : '',
          username: t.username ?? '',
          secure: !!t.secure,
          dir: t.dir ?? '',
        });
      })
      .finally(() => setBusy(null));
  }, []);

  const submit = async (action: 'save' | 'test') => {
    if (form.type !== 'fritzbox' && !form.host.trim()) {
      addToast('error', 'Host is required');
      return;
    }
    setBusy(action);
    try {
      const res = await fetch('/api/system/external-backup/target', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, target: buildTarget(form) }),
      });
      const data = await res.json().catch(() => ({}));
      if (action === 'test') {
        if (data.ok) addToast('success', 'Connected to the backup destination');
        else addToast('error', 'Connection test failed', data.error || `HTTP ${res.status}`);
        return;
      }
      if (!res.ok) {
        addToast('error', 'Could not save destination', data.error || `HTTP ${res.status}`);
        return;
      }
      addToast('success', 'Backup destination saved');
      set({ password: '', privateKey: '' });
      // Refresh the masked view + let the parent re-probe.
      const refreshed = await fetch('/api/system/external-backup/target').then(r => (r.ok ? r.json() : null));
      if (refreshed?.target) setView(refreshed.target);
      onSaved?.();
    } finally {
      setBusy(null);
    }
  };

  if (busy === 'load') {
    return (
      <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
        <Loader2 className="animate-spin" size={16} /> Loading destination…
      </div>
    );
  }

  const isFritz = form.type === 'fritzbox';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Destination</h4>
        {view?.inheritsGateway && isFritz ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400">
            <CheckCircle2 size={12} /> Using gateway FritzBox credentials
          </span>
        ) : null}
      </div>

      <DestinationFields form={form} view={view} set={set} />

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          onClick={() => submit('test')}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50"
        >
          {busy === 'test' && <Loader2 size={14} className="animate-spin" />} Test connection
        </button>
        <button
          onClick={() => submit('save')}
          disabled={busy !== null}
          className="inline-flex items-center gap-2 px-4 py-2 border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-800 dark:text-gray-200 text-sm font-medium rounded-lg disabled:opacity-50"
        >
          {busy === 'save' && <Loader2 size={14} className="animate-spin" />} Save destination
        </button>
      </div>

      {form.type !== 'fritzbox' && !view?.hasPassword && !view?.hasPrivateKey && (
        <p className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-300">
          <AlertCircle size={12} /> Secrets are stored encrypted at rest.
        </p>
      )}
    </div>
  );
}
