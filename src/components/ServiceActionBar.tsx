'use client';

import Link from 'next/link';
import { Activity, Edit, MoreVertical, Trash2 } from 'lucide-react';
import { ServiceViewModel } from '@/types/serviceView';

type ServiceActionHandlers = {
  onMonitor?: (service: ServiceViewModel) => void;
  onEdit?: (service: ServiceViewModel) => void;
  onActions?: (service: ServiceViewModel) => void;
  onEditLink?: (service: ServiceViewModel) => void;
  onDelete?: (service: ServiceViewModel) => void;
};

interface ServiceActionBarProps extends ServiceActionHandlers {
  service: ServiceViewModel;
  className?: string;
}

export function ServiceActionBar({ service, onMonitor, onEdit, onActions, onEditLink, onDelete, className }: ServiceActionBarProps) {
  const isGateway = service.type === 'gateway';
  const isLink = service.type === 'link';

  return (
    <div className={`flex items-center gap-1 shrink-0 ml-auto bg-gray-50 dark:bg-gray-800/50 p-1 rounded-lg border border-gray-100 dark:border-gray-800 ${className || ''}`}>
      {isGateway ? (
        <>
          <Link
            href="/monitor/gateway"
            className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 rounded transition-colors"
            title="Monitor Gateway"
          >
            <Activity size={16} />
          </Link>
          <Link
            href="/registry?selected=gateway"
            className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
            title="Edit Gateway"
          >
            <Edit size={16} />
          </Link>
        </>
      ) : isLink ? (
        <>
          <button
            type="button"
            onClick={() => onEditLink?.(service)}
            className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
            title="Edit Link"
          >
            <Edit size={16} />
          </button>
          <button
            type="button"
            onClick={() => onDelete?.(service)}
            className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 rounded transition-colors"
            title="Delete"
          >
            <Trash2 size={16} />
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => onMonitor?.(service)}
            className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 rounded transition-colors"
            title="Monitor"
          >
            <Activity size={16} />
          </button>
          {service.type === 'kube' ? (
            <button
              type="button"
              onClick={() => onEdit?.(service)}
              className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
              title="Edit Configuration"
            >
              <Edit size={16} />
            </button>
          ) : (
            <div className="p-1.5 text-gray-300 dark:text-gray-700 cursor-not-allowed opacity-50" title="Not Managed via Quadlet Kube">
              <Edit size={16} />
            </div>
          )}
          <button
            type="button"
            onClick={() => onActions?.(service)}
            className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-900/30 rounded transition-colors"
            title="Actions"
          >
            <MoreVertical size={16} />
          </button>
        </>
      )}
    </div>
  );
}
