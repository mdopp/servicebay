'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { Button, Input } from '@/components/ui';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  isDestructive?: boolean;
  confirmDisabled?: boolean;
  isLoading?: boolean;
  /** Resource name shown in the dialog and (when requireTypedConfirm is set) required to be typed to enable Confirm. */
  resourceName?: string;
  /** Force the user to type resourceName before Confirm enables. Implies isDestructive UX. */
  requireTypedConfirm?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  isDestructive = false,
  confirmDisabled = false,
  isLoading = false,
  resourceName,
  requireTypedConfirm = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const [typed, setTyped] = useState('');
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  const handleCancel = () => {
    setTyped('');
    onCancel();
  };
  const handleConfirm = () => {
    setTyped('');
    onConfirm();
  };

  // `topMostOnly` joins the shared overlay stack instead of registering an
  // independent window listener, so one Escape pops exactly this layer and the
  // panel that opened the confirmation stays put until the next press (#2774).
  useEscapeKey(() => { if (!isLoading) handleCancel(); }, isOpen, true);

  useEffect(() => {
    if (!isOpen) return;
    // Move focus to a safe default (cancel) so Enter doesn't accidentally fire confirm.
    cancelButtonRef.current?.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  const typedOk = !requireTypedConfirm || typed.trim() === (resourceName ?? '').trim();
  const canConfirm = !confirmDisabled && !isLoading && typedOk;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Enter submits when no type-to-confirm is required, action enabled, and focus
    // isn't currently on the cancel button (avoid hijacking the Cancel default).
    if (e.key !== 'Enter') return;
    if (requireTypedConfirm) return;
    if (!canConfirm) return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active === cancelButtonRef.current) return;
    e.preventDefault();
    handleConfirm();
  };

  return (
    <div
      className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4 animate-in fade-in duration-200"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      onKeyDown={handleKeyDown}
    >
      <div className="bg-surface rounded-lg shadow-xl max-w-md w-full border border-border overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className={`p-3 rounded-full shrink-0 ${isDestructive ? 'bg-surface-2 text-status-fail' : 'bg-surface-2 text-accent'}`}>
              <AlertTriangle size={24} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 id="confirm-modal-title" className="text-lg font-bold text-text mb-2">{title}</h3>
              <p className="text-text-muted text-sm leading-relaxed">
                {message}
              </p>
              {resourceName && (
                <p className="mt-2 font-mono text-sm text-text break-all bg-surface-2 px-2 py-1 rounded">
                  {resourceName}
                </p>
              )}
              {requireTypedConfirm && resourceName && (
                <div className="mt-3">
                  <label className="block text-xs text-text-subtle mb-1">
                    Type <span className="font-mono">{resourceName}</span> to confirm
                  </label>
                  <Input
                    type="text"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                    autoFocus
                    className="w-full px-3 py-2 text-sm font-mono rounded-md border border-border bg-surface-2 text-text focus:ring-2 focus:ring-status-fail focus:border-transparent outline-none"
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="bg-surface-muted px-6 py-4 flex justify-end gap-3 border-t border-border">
          <Button
            ref={cancelButtonRef}
            onClick={handleCancel}
            disabled={isLoading}
            variant="secondary"
          >
            {cancelText}
          </Button>
          <Button
            ref={confirmButtonRef}
            onClick={handleConfirm}
            disabled={!canConfirm}
            aria-label={confirmText}
            variant={isDestructive ? 'danger' : 'primary'}
            className="flex items-center gap-2"
          >
            {isLoading && <Loader2 size={14} className="animate-spin" />}
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}
