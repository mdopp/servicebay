'use client';

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import PluginHelp from './PluginHelp';
import ConnectionIndicator from './ConnectionIndicator';
import LocalOnlyBadge from './LocalOnlyBadge';

interface PageHeaderProps {
  title: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  showBack?: boolean;
  helpId?: string;
}

export default function PageHeader({ title, children, actions, showBack = false, helpId }: PageHeaderProps) {
  const router = useRouter();

  const handleBack = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      router.back();
    } else {
      router.push('/services');
    }
  };

  return (
    <div className="flex items-center gap-4 p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
      <div className="flex items-center gap-4 shrink-0">
        {showBack && (
          <button
            onClick={handleBack}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
            title="Go Back"
            aria-label="Go back"
          >
            <ArrowLeft size={24} className="text-gray-600 dark:text-gray-300" />
          </button>
        )}
        <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{title}</h1>
        {helpId && <PluginHelp helpId={helpId} />}
      </div>

      {children && (
        <div className="flex-1 min-w-0 mx-2 md:mx-4">
            {children}
        </div>
      )}

      <div className={`flex items-center gap-3 shrink-0 ${children ? '' : 'ml-auto'}`}>
        {actions}
        <LocalOnlyBadge />
        <ConnectionIndicator inline />
      </div>
    </div>
  );
}
