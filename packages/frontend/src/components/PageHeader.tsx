'use client';

import { ArrowLeft } from 'lucide-react';
import { useRouter } from 'next/navigation';
import SectionHelp from './SectionHelp';
import { Button } from '@/components/ui';

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
    <div className="flex items-center gap-4 p-4 border-b border-border bg-surface">
      <div className="flex items-center gap-4 shrink-0">
        {showBack && (
          <Button
            variant="ghost"
            onClick={handleBack}
            className="h-auto w-auto p-2 rounded-full"
            title="Go Back"
            aria-label="Go back"
          >
            <ArrowLeft size={24} className="text-text-muted" />
          </Button>
        )}
        <h1 className="text-xl font-bold text-text">{title}</h1>
        {helpId && <SectionHelp helpId={helpId} />}
      </div>

      {children && (
        <div className="flex-1 min-w-0 mx-2 md:mx-4">
            {children}
        </div>
      )}

      {actions && (
        <div className={`flex items-center gap-3 shrink-0 ${children ? '' : 'ml-auto'}`}>
          {actions}
        </div>
      )}
    </div>
  );
}
