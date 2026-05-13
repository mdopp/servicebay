'use client';

import { useState, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { LayoutDashboard, Box, Terminal, Activity, ChevronLeft, Github, Settings, Network, Users, ExternalLink, Sparkles, Home, Wrench } from 'lucide-react';
import ServiceBayLogo from './ServiceBayLogo';
import PluginHelp from './PluginHelp';
import pkg from '../../package.json';

export const plugins = [
    { id: 'services', name: 'Services', shortLabel: 'Services', icon: Box, path: '/services' },
    { id: 'containers', name: 'Container Engine', shortLabel: 'Containers', icon: LayoutDashboard, path: '/containers' },
    { id: 'network', name: 'Network Map', shortLabel: 'Network', icon: Network, path: '/network' },
    { id: 'health', name: 'Health', shortLabel: 'Health', icon: Activity, path: '/health' },
    { id: 'terminal', name: 'SSH Terminal', shortLabel: 'Terminal', icon: Terminal, path: '/terminal' },
    { id: 'settings', name: 'Settings', shortLabel: 'Settings', icon: Settings, path: '/settings' },
];

export default function Sidebar() {
    const pathname = usePathname() || '';
  const searchParams = useSearchParams();
  const node = searchParams?.get('node');
  const router = useRouter();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showCollapsedNodeLabel, setShowCollapsedNodeLabel] = useState(false);
  const [lldapUrl, setLldapUrl] = useState<string | null>(null);
  // Conditional sidebar entry for /setup. Visible whenever the server
  // reports an active install job (running / needs_credentials) OR a
  // recently-finished job that hasn't been acknowledged yet (terminal
  // phases with stackSetupPending still set). This way "Setup" is a
  // first-class destination during the 10-minute install window — the
  // operator can navigate to Services / Terminal / Health and still
  // come back to watch progress.
  const [hasActiveInstall, setHasActiveInstall] = useState(false);

  useEffect(() => {
    if (window.innerWidth < 768) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsCollapsed(true);
    }
  }, []);

  useEffect(() => {
    fetch('/api/auth/lldap-url')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.url) setLldapUrl(data.url); })
      .catch(() => {});
  }, []);

  // Poll the install-job singleton so every connected client picks up
  // (and drops) the "Setup" entry within 5 s — the operator on a
  // second tab/phone should see the same affordance as the operator
  // who clicked Install. Short interval is fine: payload is tiny and
  // it pauses naturally when there's no active job.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/install/status', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json() as { job: { phase?: string } | null };
        if (!cancelled) setHasActiveInstall(Boolean(data.job));
      } catch { /* offline / mid-redeploy — keep the previous value */ }
    };
    void tick();
    const handle = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(handle); };
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
                            by Korgraph.io - v{pkg.version}
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
        {node && !isCollapsed && (
            <div className="mx-2 mb-1 px-3 py-1.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-md flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                <span className="text-xs font-medium text-amber-700 dark:text-amber-400 truncate">{node}</span>
            </div>
        )}
        {node && isCollapsed && (
            <button
                type="button"
                onClick={() => setShowCollapsedNodeLabel(v => !v)}
                title={`Node: ${node}`}
                aria-label={`Active node: ${node}. Tap for details.`}
                className="mx-auto mb-1 flex flex-col items-center gap-0.5 focus:outline-none"
            >
                <span className="w-3 h-3 rounded-full bg-amber-500 animate-pulse" />
                {showCollapsedNodeLabel && (
                    <span className="text-[9px] font-mono text-amber-600 dark:text-amber-400 max-w-[3.5rem] truncate">{node}</span>
                )}
            </button>
        )}
        <div className="overflow-y-auto flex-1 p-2 space-y-1">
            {hasActiveInstall && (() => {
                const isActive = pathname?.startsWith('/setup') ?? false;
                return (
                    <button
                        type="button"
                        onClick={() => router.push('/setup')}
                        className={`w-full text-left px-3 py-3 rounded-md flex items-center transition-colors ${
                            isActive
                            ? 'bg-white dark:bg-gray-800 text-blue-600 dark:text-blue-400 shadow-sm'
                            : 'bg-blue-50 dark:bg-blue-900/30 hover:bg-blue-100 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-300'
                        } ${isCollapsed ? 'justify-center' : 'gap-3'}`}
                        title={isCollapsed ? 'Setup in progress' : ''}
                    >
                        <div className="relative shrink-0">
                            <Wrench size={20} className={isActive ? 'text-blue-500 dark:text-blue-400' : 'text-blue-600 dark:text-blue-400'} />
                            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                        </div>
                        {!isCollapsed && <span className="font-medium whitespace-nowrap overflow-hidden">Setup</span>}
                    </button>
                );
            })()}
            {plugins.map(p => {
                const Icon = p.icon;
                const isActive = pathname?.startsWith(p.path) ?? false;
                return (
                    <button
                        key={p.id}
                        onClick={() => router.push(`${p.path}${node ? `?node=${node}` : ''}`)}
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
            {lldapUrl && (
                <a
                    href={lldapUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`w-full text-left px-3 py-3 rounded-md flex items-center transition-colors hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400 ${isCollapsed ? 'justify-center' : 'gap-3'}`}
                    title={isCollapsed ? 'Users & Groups (LLDAP)' : ''}
                >
                    <Users size={20} className="shrink-0 text-gray-500 dark:text-gray-500" />
                    {!isCollapsed && (
                        <span className="font-medium whitespace-nowrap overflow-hidden flex items-center gap-1.5">
                            Users & Groups
                            <ExternalLink size={12} className="text-gray-400" />
                        </span>
                    )}
                </a>
            )}
            {/* "View as user" — preview the family-facing /portal that
                lists every running service with a friendly card and
                user-guide. Opens in a new tab so the admin's session
                stays put. */}
            <a
                href="/portal"
                target="_blank"
                rel="noopener noreferrer"
                className={`w-full text-left px-3 py-3 rounded-md flex items-center transition-colors hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400 ${isCollapsed ? 'justify-center' : 'gap-3'}`}
                title={isCollapsed ? 'View as user' : ''}
            >
                <Home size={20} className="shrink-0 text-gray-500 dark:text-gray-500" />
                {!isCollapsed && (
                    <span className="font-medium whitespace-nowrap overflow-hidden flex items-center gap-1.5">
                        View as user
                        <ExternalLink size={12} className="text-gray-400" />
                    </span>
                )}
            </a>
        </div>

        <div className="p-2 space-y-1">
            {/* "What's new" — opens the same modal PluginHelp uses, but loads
              CHANGELOG.md instead of a per-plugin help file. Available
              independent of "is there an update pending?". */}
            <div className={isCollapsed ? 'flex justify-center' : ''}>
                <PluginHelp
                    helpId="changelog"
                    title="What's new in ServiceBay"
                    icon={Sparkles}
                    label={isCollapsed ? undefined : "What's new"}
                    className={isCollapsed
                        ? 'p-2 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-md text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
                        : 'w-full flex items-center gap-3 px-3 py-3 rounded-md text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors !bg-transparent !border-0 !text-current font-medium'}
                />
            </div>
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
