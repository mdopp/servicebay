'use client';

import React, { createContext, useContext, useState, useCallback } from 'react';
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
}

interface ToastContextType {
  addToast: (type: ToastType, title: string, message?: string) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: ToastType, title: string, message?: string) => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, type, title, message }]);

    // Auto remove after 5 seconds
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 w-full max-w-sm pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start gap-3 p-4 rounded-lg shadow-lg border animate-in slide-in-from-right-full duration-300 ${
              toast.type === 'success' ? 'bg-white dark:bg-gray-900 border-green-200 dark:border-green-900' :
              toast.type === 'error' ? 'bg-white dark:bg-gray-900 border-red-200 dark:border-red-900' :
              toast.type === 'warning' ? 'bg-white dark:bg-gray-900 border-yellow-200 dark:border-yellow-900' :
              'bg-white dark:bg-gray-900 border-blue-200 dark:border-blue-900'
            }`}
          >
            <div className="shrink-0 mt-0.5">
              {toast.type === 'success' && <CheckCircle size={20} className="text-green-500" />}
              {toast.type === 'error' && <AlertCircle size={20} className="text-red-500" />}
              {toast.type === 'warning' && <AlertTriangle size={20} className="text-yellow-500" />}
              {toast.type === 'info' && <Info size={20} className="text-blue-500" />}
            </div>
            <div className="flex-1 min-w-0">
              <h4 className={`font-semibold text-sm ${
                 toast.type === 'success' ? 'text-green-900 dark:text-green-100' :
                 toast.type === 'error' ? 'text-red-900 dark:text-red-100' :
                 toast.type === 'warning' ? 'text-yellow-900 dark:text-yellow-100' :
                 'text-blue-900 dark:text-blue-100'
              }`}>
                {toast.title}
              </h4>
              {toast.message && (
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {toast.message}
                </p>
              )}
            </div>
            <button
              onClick={() => removeToast(toast.id)}
              className="shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
