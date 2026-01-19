'use client';

import { Activity, MoreVertical, Terminal as TerminalIcon } from 'lucide-react';
import { EnrichedContainer } from '@/lib/agent/types';

interface AttachedContainerListProps {
  containers?: EnrichedContainer[];
  onLogs?: (container: EnrichedContainer) => void;
  onTerminal?: (container: EnrichedContainer) => void;
  onActions?: (container: EnrichedContainer) => void;
  className?: string;
}

export function AttachedContainerList({ containers, onLogs, onTerminal, onActions, className }: AttachedContainerListProps) {
  if (!containers || containers.length === 0) {
    return null;
  }

  const hasActions = Boolean(onLogs || onTerminal || onActions);

  return (
    <div className={`mt-3 border-t border-gray-100 dark:border-gray-800/50 pt-3 flex flex-col gap-2 ${className || ''}`}>
      <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Containers</span>
      <div className="flex flex-col gap-2">
        {containers.map(container => {
          const displayName = container.names?.[0]?.replace(/^\//, '') || container.id.slice(0, 12);
          return (
            <div
              key={container.id}
              className="flex items-center justify-between rounded-lg border border-gray-100 dark:border-gray-800 bg-gray-50/70 dark:bg-gray-900/20 px-2 py-1.5"
            >
              <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate" title={displayName}>
                {displayName}
              </div>
              {hasActions && (
                <div className="flex items-center gap-1.5">
                  {onLogs && (
                    <button
                      type="button"
                      onClick={() => onLogs(container)}
                      className="p-1 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded"
                      title="Logs & Info"
                    >
                      <Activity size={16} />
                    </button>
                  )}
                  {onTerminal && (
                    <button
                      type="button"
                      onClick={() => onTerminal(container)}
                      className="p-1 text-gray-500 dark:text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 rounded"
                      title="Terminal"
                    >
                      <TerminalIcon size={16} />
                    </button>
                  )}
                  {onActions && (
                    <button
                      type="button"
                      onClick={() => onActions(container)}
                      className="p-1 text-gray-500 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/30 rounded"
                      title="Container Actions"
                    >
                      <MoreVertical size={16} />
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
