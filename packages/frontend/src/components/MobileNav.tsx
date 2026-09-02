'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Code, Wrench } from 'lucide-react';
import ServiceBayLogo from './ServiceBayLogo';
import DomainTag from './DomainTag';
import { isNavActive } from '@/config/navigation';
import { useInstallJob } from '@/hooks/useInstallJob';
import { useNavigationEntries } from '@/hooks/useNavigationEntries';
import { useToast } from '@/providers/ToastProvider';

const FIRST_VISIT_KEY = 'sb.mobileHintShown.v1';

export function MobileTopBar() {
  const router = useRouter();
  const pathname = usePathname() || '';
  const { addToast } = useToast();
  const hintFired = useRef(false);
  // Mirror of the desktop Sidebar's hasActiveInstall pill — mobile
  // users who pressed "Minimize" on the wizard would otherwise have
  // no way back to /setup since the Sidebar is hidden < md. Read from the
  // one install poll (#2732) so the badge and /setup never disagree.
  const { jobIsActive, stackSetupPending } = useInstallJob();
  const hasActiveInstall = jobIsActive || stackSetupPending;
  // Workspace package.json stays at 0.0.0 (release-please only bumps the
  // root). Read the live version from the API instead. (#812)
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/system/version')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.version) setAppVersion(d.version); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (hintFired.current) return;
    if (typeof window === 'undefined') return;
    if (window.innerWidth >= 768) return;
    if (window.localStorage.getItem(FIRST_VISIT_KEY)) return;
    hintFired.current = true;
    window.localStorage.setItem(FIRST_VISIT_KEY, '1');
    addToast(
      'info',
      'Welcome to ServiceBay',
      'Tap the Settings icon (top-right) to add SSH nodes and configure auth.',
      8000,
    );
  }, [addToast]);

  // #1992 — entries the bottom bar omits (Backup, Settings) must still be
  // reachable on a phone. Surface them as icons in the top bar's right row,
  // driven by the same navigation schema (no hand-coded duplication), so a
  // future `hiddenOnMobileBottom` entry stays reachable automatically.
  // #2521 — that now includes the app-leaving links (Users & Groups, View as
  // user), which the desktop sidebar used to show and mobile did not. They
  // render as real links after a divider, so the two groups stay readable.
  const topBarEntries = useNavigationEntries().filter(p => p.hiddenOnMobileBottom);
  const internalTopEntries = topBarEntries.filter(p => !p.external);
  const externalTopEntries = topBarEntries.filter(p => p.external);

  return (
    <div className="h-14 bg-surface border-b border-border flex items-center justify-between px-4 shrink-0 md:hidden z-20">
       {/* Left: Logo + Text */}
       <div className="flex items-center gap-2">
          <ServiceBayLogo size={24} className="text-accent" />
          <div className="flex flex-col">
             <span className="font-bold text-text text-sm leading-none">
                ServiceBay
             </span>
             <span className="text-[10px] text-text-muted">by Korgraph.io{appVersion ? ` - v${appVersion}` : ''}</span>
          </div>
       </div>
       {/* Center: where this ServiceBay lives — the desktop Sidebar is
           hidden < md, so the domain surfaces here on mobile (#249). */}
       <div className="flex-1 min-w-0 flex justify-center px-2">
          <DomainTag />
       </div>
       {/* Right: Icons. The row carries two groups now (in-app destinations,
           then the app-leaving links, #2521), so it can outgrow a 360px phone.
           Same degradation as the bottom bar (#1992): non-shrinking items in an
           x-scrollable row — it never clips an icon off the screen. */}
       <div className="flex items-center gap-3 min-w-0 overflow-x-auto no-scrollbar">
          {hasActiveInstall && (
            <button
              onClick={() => router.push('/setup')}
              className="relative transition-colors text-accent hover:text-accent-strong shrink-0"
              aria-label="Resume setup"
              title="Resume setup"
            >
              <Wrench size={20} />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-accent animate-pulse" />
            </button>
          )}
          {internalTopEntries.map(p => {
            const Icon = p.icon;
            const isActive = p.path ? isNavActive(pathname, p.path) : false;
            return (
              <button
                key={p.id}
                data-testid={`nav-${p.id}`}
                onClick={() => router.push(p.href)}
                className={`transition-colors shrink-0 ${
                  isActive
                    ? 'text-accent'
                    : 'text-text-muted hover:text-text'
                }`}
                aria-label={p.name}
                title={p.name}
              >
                <Icon size={20} />
              </button>
            );
          })}
          {/* App-leaving links, fenced off by a rule so they don't read as one
              more in-app icon (#2521). GitHub has always lived out here; it
              joins the group it belongs to. */}
          <div
              data-testid="external-nav-group"
              aria-label="Opens in a new tab"
              className="flex items-center gap-3 shrink-0 pl-3 border-l border-border"
            >
              {externalTopEntries.map(p => {
                const Icon = p.icon;
                return (
                  <a
                    key={p.id}
                    data-testid={`nav-${p.id}`}
                    href={p.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-text-muted hover:text-text transition-colors shrink-0"
                    aria-label={p.name}
                    title={`${p.name} — opens in a new tab`}
                  >
                    <Icon size={20} />
                  </a>
                );
              })}
              <a
                href="https://github.com/mdopp/servicebay"
                target="_blank"
                rel="noreferrer"
                className="text-text-muted hover:text-text transition-colors shrink-0"
                aria-label="ServiceBay on GitHub"
                title="ServiceBay on GitHub — opens in a new tab"
              >
                <Code size={20} />
              </a>
          </div>
       </div>
    </div>
  );
}

export function MobileBottomBar() {
   const pathname = usePathname() || '';
  const router = useRouter();

  // Honor the per-entry `hiddenOnMobileBottom` flag from the navigation
  // schema — Settings & Backup opt out of the bottom bar (they live in the
  // mobile top bar's icon row instead, so the bottom bar doesn't overflow).
  // Every external entry carries the flag too, so the bottom bar is the
  // in-app group only; nothing here leaves ServiceBay (#2521).
  const bottomDashboards = useNavigationEntries().filter(p => !p.hiddenOnMobileBottom);

  // #1992 — as top-level entries grow, a fixed `justify-around` row crowds the
  // labels and eventually overflows on narrow phones. Use an x-scrollable flex
  // row with non-shrinking, min-width items: it stays evenly spread when the
  // entries fit and degrades to a horizontal scroll (never a clipped/crushed
  // row) when they don't. `justify-around` centres the content while it fits.
  return (
    <nav
      aria-label="Primary"
      className="h-[72px] bg-surface border-t border-border flex items-center justify-around gap-1 px-2 shrink-0 md:hidden z-20 pb-2 overflow-x-auto no-scrollbar"
    >
       {bottomDashboards.map(p => {
          const Icon = p.icon;
          const isActive = p.path ? isNavActive(pathname, p.path) : false;
          return (
             <button
                key={p.id}
                data-testid={`nav-${p.id}`}
                onClick={() => router.push(p.href)}
                title={p.name}
                aria-label={p.name}
                className={`p-2 rounded-xl flex flex-col items-center justify-center gap-1 shrink-0 min-w-[3.5rem] transition-all ${
                    isActive
                    ? 'text-accent bg-surface-2'
                    : 'text-text-muted hover:bg-surface-2'
                }`}
             >
                <Icon size={20} strokeWidth={isActive ? 2.5 : 2} />
                <span className={`text-[9px] leading-none font-medium ${isActive ? '' : 'opacity-70'}`}>{p.shortLabel}</span>
             </button>
          )
       })}
    </nav>
  );
}
