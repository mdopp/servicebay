'use client';

import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui';

export type ToastType = 'success' | 'error' | 'info' | 'warning' | 'loading';

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

interface ToastContextType {
  addToast: (type: ToastType, title: string, message?: string, duration?: number) => string;
  removeToast: (id: string) => void;
  updateToast: (id: string, type: ToastType, title: string, message?: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

/**
 * Toast type → semantic status token (design-system, #2099). One status accent
 * per type drives the left border, the icon colour and the StatusDot — no raw
 * green-200/red-900/bg-white literals. The surface is the shared <Card>.
 */
type StatusTone = 'ok' | 'warn' | 'fail' | 'info';

const toneByType: Record<ToastType, StatusTone> = {
  success: 'ok',
  error: 'fail',
  warning: 'warn',
  info: 'info',
  loading: 'info',
};

const accentBorderByTone: Record<StatusTone, string> = {
  ok: 'border-l-status-ok',
  warn: 'border-l-status-warn',
  fail: 'border-l-status-fail',
  info: 'border-l-status-info',
};

const accentTextByTone: Record<StatusTone, string> = {
  ok: 'text-status-ok',
  warn: 'text-status-warn',
  fail: 'text-status-fail',
  info: 'text-status-info',
};

const accentDotByTone: Record<StatusTone, string> = {
  ok: 'bg-status-ok',
  warn: 'bg-status-warn',
  fail: 'bg-status-fail',
  info: 'bg-status-info',
};

function ToastIcon({ type, tone }: { type: ToastType; tone: StatusTone }) {
  const className = `${accentTextByTone[tone]}`;
  if (type === 'success') return <CheckCircle size={20} className={className} />;
  if (type === 'error') return <AlertCircle size={20} className={className} />;
  if (type === 'warning') return <AlertTriangle size={20} className={className} />;
  if (type === 'loading') return <Loader2 size={20} className={`${className} animate-spin`} />;
  return <Info size={20} className={className} />;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timerMap = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const existing = timerMap.current.get(id);
    if (existing) {
      clearTimeout(existing);
      timerMap.current.delete(id);
    }
  }, []);

  const setTimer = useCallback((id: string, duration: number, onExpire: () => void) => {
    clearTimer(id);
    if (duration > 0) {
      timerMap.current.set(id, setTimeout(onExpire, duration));
    }
  }, [clearTimer]);

  const removeToast = useCallback((id: string) => {
    clearTimer(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, [clearTimer]);

  const addToast = useCallback((type: ToastType, title: string, message?: string, duration: number = 5000) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, type, title, message, duration }]);
    setTimer(id, duration, () => removeToast(id));
    return id;
  }, [removeToast, setTimer]);

  const updateToast = useCallback((id: string, type: ToastType, title: string, message?: string, duration: number = 5000) => {
    setToasts((prev) => prev.map(t => t.id === id ? { ...t, type, title, message, duration } : t));
    setTimer(id, duration, () => removeToast(id));
  }, [removeToast, setTimer]);

  return (
    <ToastContext.Provider value={{ addToast, removeToast, updateToast }}>
      {children}
      <div
        className="fixed top-4 right-4 left-4 sm:left-auto z-[200] flex flex-col gap-space-2 w-auto sm:w-full sm:max-w-sm pointer-events-none"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((toast) => {
          const tone = toneByType[toast.type];
          return (
            <Card
              key={toast.id}
              role="status"
              data-type={toast.type}
              data-tone={tone}
              padding="sm"
              className={`pointer-events-auto flex items-start gap-space-3 border-l-4 shadow-lg animate-in slide-in-from-right-full duration-300 ${accentBorderByTone[tone]}`}
            >
              <div className="shrink-0 mt-0.5">
                <ToastIcon type={toast.type} tone={tone} />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="flex items-center gap-space-2 font-semibold text-sm text-text">
                  <span
                    className={`inline-block h-2 w-2 rounded-chip shrink-0 ${accentDotByTone[tone]}`}
                    aria-hidden="true"
                  />
                  {toast.title}
                </h4>
                {toast.message && (
                  <p className="text-sm text-text-muted mt-1">
                    {toast.message}
                  </p>
                )}
              </div>
              <button
                onClick={() => removeToast(toast.id)}
                className="shrink-0 text-text-subtle hover:text-text transition-colors"
                aria-label="Dismiss notification"
              >
                <X size={18} />
              </button>
            </Card>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
