'use client';

import dynamic from 'next/dynamic';
import PageHeader from '@/components/PageHeader';

const Terminal = dynamic(() => import('@/components/Terminal'), { 
  ssr: false,
  loading: () => <div className="h-full w-full bg-black animate-pulse" />
});

export default function TerminalPlugin() {
  return (
    <div className="h-full flex flex-col">
      <PageHeader title="Terminal" showBack={false} helpId="terminal" />
      <div className="flex-1 min-h-0">
        <Terminal id="host" />
      </div>
    </div>
  );
}
