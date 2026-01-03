'use client';

import { useState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LayoutDashboard, Box, Terminal, Activity, ChevronLeft, Github, Settings, Server, Network } from 'lucide-react';
import ServiceBayLogo from './ServiceBayLogo';

export const plugins = [
    { id: 'services', name: 'Services', icon: Box, path: '/services' },
    { id: 'containers', name: 'Running Containers', icon: LayoutDashboard, path: '/containers' },
    { id: 'network', name: 'Network Map', icon: Network, path: '/network' },
    { id: 'monitoring', name: 'Monitoring', icon: Activity, path: '/monitoring' },
    { id: 'system', name: 'System Info', icon: Server, path: '/system' },
    { id: 'terminal', name: 'SSH Terminal', icon: Terminal, path: '/terminal' },
    { id: 'settings', name: 'Settings', icon: Settings, path: '/settings' },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    if (window.innerWidth < 768) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsCollapsed(true);
    }
  }, []);

  return (
    <div className={`${isCollapsed ? 'w-16' : 'w-64'} flex flex-col transition-all duration-300 h-full shrink-0`}>
        <div className="h-16 flex items-center justify-between px-4">
            {!isCollapsed && (
                <div className="flex items-center gap-3 overflow-hidden">
                    <ServiceBayLogo size={24} className="text-blue-600 dark:text-blue-400 shrink-0" />
                    <div className="flex flex-col overflow-hidden">
                        <h3 className="font-bold text-gray-800 dark:text-gray-100 leading-none whitespace-nowrap">
                            ServiceBay
                        </h3>
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 font-medium whitespace-nowrap">
                            by Korgraph.io
                        </span>
                    </div>
                </div>
            )}
            <button 
                onClick={() => setIsCollapsed(!isCollapsed)}
                className={`p-1.5 rounded-md hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 ${isCollapsed ? 'mx-auto' : ''}`}
                title={isCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
            >
                {isCollapsed ? <ServiceBayLogo size={20} /> : <ChevronLeft size={18} />}
            </button>
        </div>
        <div className="overflow-y-auto flex-1 p-2 space-y-1">
            {plugins.map(p => {
                const Icon = p.icon;
                const isActive = pathname?.startsWith(p.path) ?? false;
                return (
                    <button
                        key={p.id}
                        onClick={() => router.push(p.path)}
                        className={`w-full text-left px-3 py-3 rounded-md flex items-center transition-colors ${
                            isActive 
                            ? 'bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 shadow-sm' 
                            : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400'
                        } ${isCollapsed ? 'justify-center' : 'gap-3'}`}
                        title={isCollapsed ? p.name : ''}
                    >
                        <Icon size={20} className={`shrink-0 ${isActive ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-gray-500'}`} />
                        {!isCollapsed && <span className="font-medium whitespace-nowrap overflow-hidden">{p.name}</span>}
                    </button>
                );
            })}
        </div>
        
        <div className="p-2">
            <a 
                href="https://github.com/mdopp/servicebay" 
                target="_blank" 
                rel="noopener noreferrer"
                className={`w-full flex items-center px-3 py-3 rounded-md text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors ${isCollapsed ? 'justify-center' : 'gap-3'}`}
                title="View on GitHub"
            >
                <Github size={20} className="shrink-0" />
                {!isCollapsed && <span className="font-medium whitespace-nowrap overflow-hidden">GitHub Repo</span>}
            </a>
        </div>
    </div>
  );
}
