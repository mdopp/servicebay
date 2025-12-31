import { Box, Layers, Activity, DownloadCloud, Terminal } from 'lucide-react';
import { Plugin } from './types';
import ServicesPlugin from './ServicesPlugin';
import ContainersPlugin from './ContainersPlugin';
import SystemInfoPlugin from './SystemInfoPlugin';
import UpdatesPlugin from './UpdatesPlugin';
import dynamic from 'next/dynamic';

const TerminalPlugin = dynamic(() => import('./TerminalPlugin'), { 
  ssr: false,
  loading: () => <div className="p-4 text-gray-500">Loading terminal...</div>
});

export const plugins: Plugin[] = [
  {
    id: 'services',
    name: 'Services',
    icon: Layers,
    component: <ServicesPlugin />,
  },
  {
    id: 'containers',
    name: 'Running Containers',
    icon: Box,
    component: <ContainersPlugin />,
  },
  {
    id: 'system',
    name: 'System Info',
    icon: Activity, // Or HardDrive, but Activity covers CPU/Net too
    component: <SystemInfoPlugin />,
  },
  {
    id: 'updates',
    name: 'System Updates',
    icon: DownloadCloud,
    component: <UpdatesPlugin />,
  },
  {
    id: 'terminal',
    name: 'SSH Terminal',
    icon: Terminal,
    component: <TerminalPlugin />,
  },
];
