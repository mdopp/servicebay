'use client';

import dynamic from 'next/dynamic';

const Terminal = dynamic(() => import('@/components/Terminal'), { 
  ssr: false,
  loading: () => <div className="h-full w-full bg-black animate-pulse" />
});

export default function TerminalPlugin() {
  return <Terminal id="host" />;
}
