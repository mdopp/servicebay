'use client';

import { useState, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, Github, Users, ExternalLink, Sparkles, Home, Wrench, User as UserIcon, LogOut } from 'lucide-react';
import ServiceBayLogo from './ServiceBayLogo';
import SectionHelp from './SectionHelp';
import { typedFetch, InstallStatusResponseSchema } from '@servicebay/api-client';
import { NAVIGATION_ENTRIES } from '@/config/navigation';

// Back-compat re-export — MobileNav imports `dashboards` from here.
// New code should import NAVIGATION_ENTRIES directly from
// `@/config/navigation`. (#845)
export const dashboards = NAVIGATION_ENTRIES;

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
  // Workspace package.json stays at 0.0.0 (release-please only bumps the
  // root). Read the live version from the API instead. (#812)
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // #1001 — Current Authelia user from the forward-auth Remote-* headers.
  // null = not yet fetched, false = no session (LAN-direct or dev).
  const [currentUser, setCurrentUser] = useState<{ displayName: string; username: string; groups: string[]; source: 'forward-auth' | 'session' } | null | false>(null);

  useEffect(() => {
    if (window.innerWidth < 768) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsCollapsed(true);
    }
  }, []);

  useEffect(() => {
    fetch('/api/system/version')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.version) setAppVersion(d.version); })
      .catch(() => {});
  }, []);

  // #1001 — Identify the signed-in Authelia user via /api/auth/me. The
  // backend reads Remote-* headers from the forward-auth chain; on a
  // direct LAN hit those don't exist and the endpoint returns
  // `{ authenticated: false }`, which we render as "Not signed in".
  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.authenticated) {
          setCurrentUser({
            displayName: d.displayName || d.username,
            username: d.username,
            groups: Array.isArray(d.groups) ? d.groups : [],
            source: d.source === 'session' ? 'session' : 'forward-auth',
          });
        } else {
          setCurrentUser(false);
        }
      })
      .catch(() => setCurrentUser(false));
  }, []);

  // Derive the Authelia logout URL from the current hostname. Pattern:
  // admin.dopp.cloud → auth.dopp.cloud/logout. Falls back to /portal if
  // we can't parse the host (rare; e.g. raw IP). Operator can always
  // hit auth.<domain>/logout by hand.
  const logoutHref = (() => {
    if (typeof window === 'undefined') return '/portal';
    const host = window.location.host;
    const dotIdx = host.indexOf('.');
    if (dotIdx < 0) return '/portal';
    return `https://auth${host.slice(dotIdx)}/logout`;
  })();

  // Two logout paths: a ServiceBay session (LAN-direct) is cleared via the
  // backend then we bounce to /login; an Authelia forward-auth session is
  // dropped at auth.<domain>/logout.
  const handleLogout = async () => {
    if (currentUser && currentUser.source === 'session') {
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch {
        /* clear best-effort; redirect regardless so a stale cookie doesn't trap the user */
      }
      window.location.href = '/login';
      return;
    }
    window.location.href = logoutHref;
  };

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
  //
  // Visibility rule: show the pill whenever EITHER (a) an install job
  // is currently running, OR (b) the operator hasn't acknowledged a
  // terminal install yet (`stackSetupPending: true`). The second case
  // is what gives the operator a path back to /setup after they
  // minimised the wizard but never clicked "Finish".
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await typedFetch(
          '/api/install/status',
          InstallStatusResponseSchema,
          { cache: 'no-store' },
        );
        if (cancelled) return;
        setHasActiveInstall(data.jobIsActive);
      } catch { /* offline / mid-redeploy / schema drift — keep the previous value */ }
    };
    void tick();
    const handle = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(handle); };
  }, []);

  return (
    <div className={`${isCollapsed ? 'w-16' : 'w-64'} flex flex-col sidebar-transition h-full shrink-0`}>
        <div className="h-16 flex items-center justify-between px-4">
            {!isCollapsed && (
                <div className="flex items-center gap-3.5 overflow-hidden animate-in fade-in slide-in-from-left-2 duration-300">
                    <div className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20 shadow-inner shrink-0">
                        <ServiceBayLogo size={22} className="text-blue-600 dark:text-blue-400 shrink-0" />
                    </div>
                    <div className="flex flex-col overflow-hidden">
                        <h3 className="font-extrabold text-gray-800 dark:text-gray-100 leading-none whitespace-nowrap tracking-tight text-sm">
                            ServiceBay
                        </h3>
                        <span className="text-[9px] uppercase font-black text-gray-500 dark:text-gray-500 tracking-[0.15em] mt-1.5 whitespace-nowrap">
                            SYSTEM{appVersion ? ` - v${appVersion}` : ''}
                        </span>
                    </div>
                </div>
            )}
            <button
                onClick={() => setIsCollapsed(!isCollapsed)}
                className={`p-1.5 rounded-xl border border-transparent hover:bg-gray-200/60 dark:hover:bg-white/[0.02] text-gray-500 ${isCollapsed ? 'mx-auto' : ''}`}
                title={isCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
            >
                {isCollapsed ? <ServiceBayLogo size={20} /> : <ChevronLeft size={18} />}
            </button>
        </div>
        {node && !isCollapsed && (
            <div className="mx-2 mb-1 px-3 py-1.5 bg-amber-50 dark:bg-amber-900/10 border border-amber-200/50 dark:border-amber-800/40 rounded-xl flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                <span className="text-xs font-semibold text-amber-700 dark:text-amber-400 truncate">{node}</span>
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
            {/* Setup entry (#696). Only visible when there's an active install OR we are looking at the setup page. */}
            {(hasActiveInstall || (pathname?.startsWith('/setup') ?? false)) && (() => {
                const isActive = pathname?.startsWith('/setup') ?? false;
                const baseClass = `w-full text-left px-3.5 py-3 rounded-xl flex items-center transition-all border ${isCollapsed ? 'justify-center' : 'gap-3.5'} `;
                const tone = isActive
                    ? 'bg-blue-50 dark:bg-blue-600/10 border-blue-100 dark:border-blue-500/20 text-blue-600 dark:text-blue-400 font-bold shadow-sm shadow-blue-500/5'
                    : 'border-blue-100/50 dark:border-blue-500/10 bg-blue-50/50 dark:bg-blue-900/20 hover:bg-blue-100/60 dark:hover:bg-blue-900/40 text-blue-700 dark:text-blue-300';
                const iconColor = isActive
                    ? 'text-blue-500 dark:text-blue-400'
                    : 'text-blue-600 dark:text-blue-400';
                return (
                    <button
                        type="button"
                        onClick={() => router.push('/setup')}
                        className={baseClass + tone}
                        title={isCollapsed ? (hasActiveInstall ? 'Setup in progress' : 'Setup') : ''}
                    >
                        <div className="relative shrink-0">
                            <Wrench size={20} className={`shrink-0 ${iconColor}`} />
                            {hasActiveInstall && (
                                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                            )}
                        </div>
                        {!isCollapsed && <span className="font-semibold whitespace-nowrap overflow-hidden animate-in fade-in slide-in-from-left-2 duration-300">Setup</span>}
                    </button>
                );
            })()}
            {dashboards.map(p => {
                const Icon = p.icon;
                const isActive = pathname?.startsWith(p.path) ?? false;
                return (
                    <button
                        key={p.id}
                        onClick={() => router.push(`${p.path}${node ? `?node=${node}` : ''}`)}
                        className={`w-full text-left px-3.5 py-3 rounded-xl flex items-center transition-all border ${
                            isActive
                            ? 'bg-blue-50 dark:bg-blue-600/10 border-blue-100 dark:border-blue-500/20 text-blue-600 dark:text-blue-400 font-bold shadow-sm shadow-blue-500/5'
                            : 'border-transparent hover:bg-gray-200/60 dark:hover:bg-white/[0.02] text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                        } ${isCollapsed ? 'justify-center' : 'gap-3.5'}`}
                        title={isCollapsed ? p.name : ''}
                    >
                        <Icon size={20} className={`shrink-0 ${isActive ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-gray-500'}`} />
                        {!isCollapsed && <span className="font-semibold whitespace-nowrap overflow-hidden animate-in fade-in slide-in-from-left-2 duration-300">{p.name}</span>}
                    </button>
                );
            })}
            {lldapUrl && (
                <a
                    href={lldapUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`w-full text-left px-3.5 py-3 rounded-xl flex items-center transition-all border border-transparent hover:bg-gray-200/60 dark:hover:bg-white/[0.02] text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 ${isCollapsed ? 'justify-center' : 'gap-3.5'}`}
                    title={isCollapsed ? 'Users & Groups (LLDAP)' : ''}
                >
                    <Users size={20} className="shrink-0 text-gray-500 dark:text-gray-500" />
                    {!isCollapsed && (
                        <span className="font-semibold whitespace-nowrap overflow-hidden flex items-center gap-1.5 animate-in fade-in slide-in-from-left-2 duration-300">
                            Users & Groups
                            <ExternalLink size={12} className="text-gray-400" />
                        </span>
                    )}
                </a>
            )}
            <a
                href="/portal"
                target="_blank"
                rel="noopener noreferrer"
                className={`w-full text-left px-3.5 py-3 rounded-xl flex items-center transition-all border border-transparent hover:bg-gray-200/60 dark:hover:bg-white/[0.02] text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 ${isCollapsed ? 'justify-center' : 'gap-3.5'}`}
                title={isCollapsed ? 'View as user' : ''}
            >
                <Home size={20} className="shrink-0 text-gray-500 dark:text-gray-500" />
                {!isCollapsed && (
                    <span className="font-semibold whitespace-nowrap overflow-hidden flex items-center gap-1.5 animate-in fade-in slide-in-from-left-2 duration-300">
                        View as user
                        <ExternalLink size={12} className="text-gray-400" />
                    </span>
                )}
            </a>
        </div>

        <div className="p-2 space-y-1 border-t border-gray-200/40 dark:border-white/5 pt-3 mt-auto">
            {/* #1001 — Signed-in user chip + Logout. Falls back to a
                quiet "Not signed in" hint when the forward-auth
                headers are absent (direct LAN access). */}
            {currentUser && (
                <div className={`flex items-center gap-2.5 px-3.5 py-2 rounded-xl bg-gray-100/60 dark:bg-white/[0.03] ${isCollapsed ? 'justify-center' : ''}`}
                     title={isCollapsed ? `${currentUser.displayName} (${currentUser.groups.join(', ') || 'no groups'})` : ''}>
                    <div className="shrink-0 w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-700 dark:text-blue-300 font-bold text-xs">
                        {currentUser.displayName.charAt(0).toUpperCase() || <UserIcon size={14} />}
                    </div>
                    {!isCollapsed && (
                        <div className="flex flex-col min-w-0 flex-1">
                            <span className="text-sm font-semibold text-gray-800 dark:text-gray-200 truncate">{currentUser.displayName}</span>
                            <span className="text-xs text-gray-500 dark:text-gray-500 truncate">
                                {currentUser.source === 'session'
                                    ? 'ServiceBay admin'
                                    : (currentUser.groups.join(', ') || 'no groups')}
                            </span>
                        </div>
                    )}
                </div>
            )}
            {currentUser && (
                <button
                    type="button"
                    onClick={handleLogout}
                    className={`w-full flex items-center px-3.5 py-2.5 rounded-xl text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-200/60 dark:hover:bg-white/[0.02] transition-all border border-transparent ${isCollapsed ? 'justify-center' : 'gap-3.5'}`}
                    title={currentUser.source === 'session' ? 'Log out of ServiceBay' : 'Log out — drops the Authelia session'}
                >
                    <LogOut size={18} className="shrink-0" />
                    {!isCollapsed && <span className="text-sm font-semibold whitespace-nowrap overflow-hidden">Log out</span>}
                </button>
            )}
            <div className={isCollapsed ? 'flex justify-center' : ''}>
                <SectionHelp
                    helpId="changelog"
                    title="What's new in ServiceBay"
                    icon={Sparkles}
                    label={isCollapsed ? undefined : "What's new"}
                    className={isCollapsed
                        ? 'p-2 hover:bg-gray-200/60 dark:hover:bg-white/[0.02] rounded-xl text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
                        : 'w-full flex items-center gap-3.5 px-3.5 py-3 rounded-xl text-gray-500 hover:text-gray-950 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-200/60 dark:hover:bg-white/[0.02] transition-colors border border-transparent !bg-transparent font-semibold'}
                />
            </div>
            <a
                href="https://github.com/mdopp/servicebay"
                target="_blank"
                rel="noopener noreferrer"
                className={`w-full flex items-center px-3.5 py-3 rounded-xl text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-200/60 dark:hover:bg-white/[0.02] transition-all border border-transparent ${isCollapsed ? 'justify-center' : 'gap-3.5'}`}
                title="View on GitHub"
            >
                <Github size={20} className="shrink-0" />
                {!isCollapsed && <span className="font-semibold whitespace-nowrap overflow-hidden animate-in fade-in slide-in-from-left-2 duration-300">GitHub Repo</span>}
            </a>
        </div>
    </div>
  );
}
