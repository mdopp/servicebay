'use client';

import { useState, useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ChevronLeft, Code, Users, ExternalLink, Sparkles, Home, User as UserIcon, LogOut, MessageCircle } from 'lucide-react';
import ServiceBayLogo from './ServiceBayLogo';
import SectionHelp from './SectionHelp';
import DomainTag from './DomainTag';
import { NAVIGATION_ENTRIES, isNavActive } from '@/config/navigation';
import { useDigitalTwin } from '@/hooks/useDigitalTwin';

// Back-compat re-export — MobileNav imports `dashboards` from here.
// New code should import NAVIGATION_ENTRIES directly from
// `@/config/navigation`. (#845)
export const dashboards = NAVIGATION_ENTRIES;

// Renders nothing — lets SectionHelp act as a plain text link (no icon) in the
// tidied footer's inline secondary-link row.
const NoIcon = () => null;

// Shared nav-item chrome on semantic tokens (#2100 ds-migrate-shell). Active
// rows take the accent surface/border/text; idle rows are transparent with a
// surface-2 hover. One source of truth so the four link variants stay in sync.
const navItemClass = (active: boolean, collapsed: boolean) =>
  `w-full text-left px-3.5 py-3 rounded-card flex items-center transition-all border ${
    active
      ? 'bg-accent/10 border-accent/20 text-accent font-bold shadow-sm shadow-accent/5'
      : 'border-transparent hover:bg-surface-2 text-text-muted hover:text-text'
  } ${collapsed ? 'justify-center' : 'gap-3.5'}`;

export default function Sidebar() {
    const pathname = usePathname() || '';
  const searchParams = useSearchParams();
  const node = searchParams?.get('node');
  const router = useRouter();
  const { data: twin } = useDigitalTwin();
  // #1755 / #1781 — the maintenance chat link only appears once solilos-chat
  // is installed (the chat surface we embed). Gated on the live digital-twin
  // installedTemplates, like the rest of the service-aware UI.
  const chatInstalled = Boolean(twin?.installedTemplates?.includes('solilos-chat'));
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showCollapsedNodeLabel, setShowCollapsedNodeLabel] = useState(false);
  const [lldapUrl, setLldapUrl] = useState<string | null>(null);
  // The redundant /setup sidebar rider was removed (#1503): setup is now
  // integrated into the dashboard, which renders the live install
  // progress directly. The separate rider led operators to the wizard's
  // "Concurrent Pipeline Active" lock over the box's own install, so it's
  // gone — the dashboard's integrated install view is the single home.
  // Workspace package.json stays at 0.0.0 (release-please only bumps the
  // root). Read the live version from the API instead. (#812)
  const [appVersion, setAppVersion] = useState<string | null>(null);
  // #1001 — Current Authelia user from the forward-auth Remote-* headers.
  // null = not yet fetched, false = no session (LAN-direct or dev).
  const [currentUser, setCurrentUser] = useState<{ displayName: string; username: string; groups: string[]; source: 'forward-auth' | 'session' } | null | false>(null);

  useEffect(() => {
    if (window.innerWidth < 768) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async app-version fetch on mount
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

  return (
    <div className={`${isCollapsed ? 'w-16' : 'w-64'} flex flex-col sidebar-transition h-full shrink-0`}>
        <div className="h-16 flex items-center justify-between px-4">
            {!isCollapsed && (
                <div className="flex items-center gap-3.5 overflow-hidden animate-in fade-in slide-in-from-left-2 duration-300">
                    <div className="p-2.5 rounded-card bg-accent/10 border border-accent/20 shadow-inner shrink-0">
                        <ServiceBayLogo size={22} className="text-accent shrink-0" />
                    </div>
                    <div className="flex flex-col overflow-hidden">
                        <h3 className="font-extrabold text-text leading-none whitespace-nowrap tracking-tight text-sm">
                            ServiceBay
                        </h3>
                        <span className="text-[9px] uppercase font-black text-text-subtle tracking-[0.15em] mt-1.5 whitespace-nowrap">
                            SYSTEM{appVersion ? ` - v${appVersion}` : ''}
                        </span>
                    </div>
                </div>
            )}
            <button
                onClick={() => setIsCollapsed(!isCollapsed)}
                className={`p-1.5 rounded-card border border-transparent hover:bg-surface-2 text-text-muted ${isCollapsed ? 'mx-auto' : ''}`}
                title={isCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
            >
                {isCollapsed ? <ServiceBayLogo size={20} /> : <ChevronLeft size={18} />}
            </button>
        </div>
        {node && !isCollapsed && (
            <div className="mx-2 mb-1 px-3 py-1.5 bg-status-warn/10 border border-status-warn/30 rounded-card flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-status-warn animate-pulse" />
                <span className="text-xs font-semibold text-status-warn truncate">{node}</span>
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
                <span className="w-3 h-3 rounded-full bg-status-warn animate-pulse" />
                {showCollapsedNodeLabel && (
                    <span className="text-[9px] font-mono text-status-warn max-w-[3.5rem] truncate">{node}</span>
                )}
            </button>
        )}
        <div className="overflow-y-auto flex-1 p-2 space-y-1">
            {dashboards.map(p => {
                const Icon = p.icon;
                const isActive = isNavActive(pathname, p.path);
                return (
                    <button
                        key={p.id}
                        onClick={() => router.push(`${p.path}${node ? `?node=${node}` : ''}`)}
                        className={navItemClass(isActive, isCollapsed)}
                        title={isCollapsed ? p.name : ''}
                    >
                        <Icon size={20} className={`shrink-0 ${isActive ? 'text-accent' : 'text-text-subtle'}`} />
                        {!isCollapsed && <span className="font-semibold whitespace-nowrap overflow-hidden animate-in fade-in slide-in-from-left-2 duration-300">{p.name}</span>}
                    </button>
                );
            })}
            {chatInstalled && (
                <button
                    onClick={() => router.push(`/chat${node ? `?node=${node}` : ''}`)}
                    className={navItemClass(isNavActive(pathname, '/chat'), isCollapsed)}
                    title={isCollapsed ? 'Maintenance Chat' : ''}
                >
                    <MessageCircle size={20} className={`shrink-0 ${isNavActive(pathname, '/chat') ? 'text-accent' : 'text-text-subtle'}`} />
                    {!isCollapsed && <span className="font-semibold whitespace-nowrap overflow-hidden animate-in fade-in slide-in-from-left-2 duration-300">Maintenance Chat</span>}
                </button>
            )}
            {lldapUrl && (
                <a
                    href={lldapUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={navItemClass(false, isCollapsed)}
                    title={isCollapsed ? 'Users & Groups (LLDAP)' : ''}
                >
                    <Users size={20} className="shrink-0 text-text-subtle" />
                    {!isCollapsed && (
                        <span className="font-semibold whitespace-nowrap overflow-hidden flex items-center gap-1.5 animate-in fade-in slide-in-from-left-2 duration-300">
                            Users & Groups
                            <ExternalLink size={12} className="text-text-subtle" />
                        </span>
                    )}
                </a>
            )}
            <a
                href="/portal"
                target="_blank"
                rel="noopener noreferrer"
                className={navItemClass(false, isCollapsed)}
                title={isCollapsed ? 'View as user' : ''}
            >
                <Home size={20} className="shrink-0 text-text-subtle" />
                {!isCollapsed && (
                    <span className="font-semibold whitespace-nowrap overflow-hidden flex items-center gap-1.5 animate-in fade-in slide-in-from-left-2 duration-300">
                        View as user
                        <ExternalLink size={12} className="text-text-subtle" />
                    </span>
                )}
            </a>
        </div>

        <div className="p-2 space-y-1 border-t border-border pt-3 mt-auto">
            {/* #1001 — Signed-in user chip + Logout. Falls back to a
                quiet "Not signed in" hint when the forward-auth
                headers are absent (direct LAN access). */}
            {currentUser && (
                <div className={`flex items-center gap-2.5 px-3.5 py-2 rounded-card bg-surface-2 ${isCollapsed ? 'justify-center' : ''}`}
                     title={isCollapsed ? `${currentUser.displayName} (${currentUser.groups.join(', ') || 'no groups'})` : ''}>
                    <div className="shrink-0 w-7 h-7 rounded-full bg-accent/10 flex items-center justify-center text-accent font-bold text-xs">
                        {currentUser.displayName.charAt(0).toUpperCase() || <UserIcon size={14} />}
                    </div>
                    {!isCollapsed && (
                        <div className="flex flex-col min-w-0 flex-1">
                            <span className="text-sm font-semibold text-text truncate">{currentUser.displayName}</span>
                            <span className="text-xs text-text-subtle truncate">
                                {currentUser.source === 'session'
                                    ? 'ServiceBay admin'
                                    : (currentUser.groups.join(', ') || 'no groups')}
                            </span>
                        </div>
                    )}
                </div>
            )}
            {/* Where this ServiceBay lives — just the domain. The signed-in
                username is already shown in the chip above, so pass null to drop
                the redundant "<user> on " prefix (#1424). Explicit null is
                honoured (no self-fetch). */}
            <div className={isCollapsed ? '' : 'px-3.5 py-0.5'}>
                <DomainTag username={null} collapsed={isCollapsed} />
            </div>
            {/* Secondary links. Expanded: one compact inline text row (tidy,
                Solilos-style). Collapsed: the icon buttons, stacked. (#sidebar-footer) */}
            {!isCollapsed ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 pt-1.5 text-xs font-medium text-text-muted">
                    <SectionHelp
                        helpId="changelog"
                        title="What's new in ServiceBay"
                        icon={NoIcon}
                        label="What's new"
                        className="!p-0 !bg-transparent !border-0 !rounded-none !gap-0 text-xs font-medium text-text-muted hover:text-text hover:!no-underline hover:!opacity-100"
                    />
                    <span className="text-text-subtle select-none" aria-hidden>·</span>
                    <a
                        href="https://github.com/mdopp/servicebay"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-text transition-colors"
                    >
                        GitHub
                    </a>
                    {currentUser && (
                        <>
                            <span className="text-text-subtle select-none" aria-hidden>·</span>
                            <button
                                type="button"
                                onClick={handleLogout}
                                className="hover:text-text transition-colors"
                                title={currentUser.source === 'session' ? 'Log out of ServiceBay' : 'Log out — drops the Authelia session'}
                            >
                                Log out
                            </button>
                        </>
                    )}
                </div>
            ) : (
                <>
                    {currentUser && (
                        <button
                            type="button"
                            onClick={handleLogout}
                            className="w-full flex items-center justify-center px-3.5 py-2.5 rounded-card text-text-muted hover:text-text hover:bg-surface-2 transition-all border border-transparent"
                            title={currentUser.source === 'session' ? 'Log out of ServiceBay' : 'Log out — drops the Authelia session'}
                        >
                            <LogOut size={18} className="shrink-0" />
                        </button>
                    )}
                    <div className="flex justify-center">
                        <SectionHelp
                            helpId="changelog"
                            title="What's new in ServiceBay"
                            icon={Sparkles}
                            className="p-2 hover:bg-surface-2 rounded-card text-text-muted hover:text-text"
                        />
                    </div>
                    <a
                        href="https://github.com/mdopp/servicebay"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full flex items-center justify-center px-3.5 py-3 rounded-card text-text-muted hover:text-text hover:bg-surface-2 transition-all border border-transparent"
                        title="View on GitHub"
                    >
                        <Code size={20} className="shrink-0" />
                    </a>
                </>
            )}
        </div>
    </div>
  );
}
