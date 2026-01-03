import { Box, Layers, Activity, Terminal, Network } from 'lucide-react';
import { Plugin } from './types';
import ServicesPlugin from './ServicesPlugin';
import ContainersPlugin from './ContainersPlugin';
import MonitoringPlugin from './MonitoringPlugin';
import SystemInfoPlugin from './SystemInfoPlugin';
import NetworkPlugin from './NetworkPlugin';
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
    name: 'Containers',
    icon: Box,
    component: <ContainersPlugin />,
  },
  {
    id: 'network',
    name: 'Network Map',
    icon: Network,
    component: <NetworkPlugin />,
  },
  {
    id: 'monitoring',
    name: 'Monitoring',
    icon: Activity,
    component: <MonitoringPlugin />,
  },
  {
    id: 'system',
    name: 'System Info',
    icon: Activity, // Or HardDrive, but Activity covers CPU/Net too
    component: <SystemInfoPlugin />,
  },
  {
    id: 'terminal',
    name: 'SSH Terminal',
    icon: Terminal,
    component: <TerminalPlugin />,
  },
];
