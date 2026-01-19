import { useEffect } from 'react';

type OverlayListener = {
  id: number;
  callback: () => void;
};

const overlayListeners: OverlayListener[] = [];
let overlayListenerId = 0;

const handleOverlayEscape = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return;
  const top = overlayListeners[overlayListeners.length - 1];
  top?.callback();
};

const addOverlayListener = (callback: () => void) => {
  const id = ++overlayListenerId;
  overlayListeners.push({ id, callback });
  if (overlayListeners.length === 1) {
    window.addEventListener('keydown', handleOverlayEscape);
  }
  return id;
};

const removeOverlayListener = (id: number) => {
  const index = overlayListeners.findIndex(listener => listener.id === id);
  if (index !== -1) {
    overlayListeners.splice(index, 1);
  }
  if (overlayListeners.length === 0) {
    window.removeEventListener('keydown', handleOverlayEscape);
  }
};

export function useEscapeKey(callback: () => void, enabled = true, topMostOnly = false) {
  useEffect(() => {
    if (!enabled) return undefined;

    if (!topMostOnly) {
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          callback();
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }

    const listenerId = addOverlayListener(callback);
    return () => removeOverlayListener(listenerId);
  }, [callback, enabled, topMostOnly]);
}
