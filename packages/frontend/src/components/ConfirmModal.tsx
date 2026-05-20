'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
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

  useEscapeKey(() => { if (!isLoading) handleCancel(); }, isOpen);

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
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-md w-full border border-gray-200 dark:border-gray-800 overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className={`p-3 rounded-full shrink-0 ${isDestructive ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400' : 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'}`}>
              <AlertTriangle size={24} />
            </div>
            <div className="flex-1 min-w-0">
              <h3 id="confirm-modal-title" className="text-lg font-bold text-gray-900 dark:text-white mb-2">{title}</h3>
              <p className="text-gray-600 dark:text-gray-300 text-sm leading-relaxed">
                {message}
              </p>
              {resourceName && (
                <p className="mt-2 font-mono text-sm text-gray-900 dark:text-gray-100 break-all bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                  {resourceName}
                </p>
              )}
              {requireTypedConfirm && resourceName && (
                <div className="mt-3">
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                    Type <span className="font-mono">{resourceName}</span> to confirm
                  </label>
                  <input
                    type="text"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    autoComplete="off"
                    autoFocus
                    className="w-full px-3 py-2 text-sm font-mono rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-red-500 focus:border-transparent outline-none"
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="bg-gray-50 dark:bg-gray-900/50 px-6 py-4 flex justify-end gap-3 border-t border-gray-200 dark:border-gray-800">
          <button
            ref={cancelButtonRef}
            onClick={handleCancel}
            disabled={isLoading}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-md transition-colors font-medium text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            ref={confirmButtonRef}
            onClick={handleConfirm}
            disabled={!canConfirm}
            aria-label={confirmText}
            className={`px-4 py-2 text-white rounded-md transition-colors font-medium text-sm shadow-sm flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-offset-1 ${
              isDestructive
                ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500'
                : 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {isLoading && <Loader2 size={14} className="animate-spin" />}
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
