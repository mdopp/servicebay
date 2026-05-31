'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Github, Settings, Wrench } from 'lucide-react';
import ServiceBayLogo from './ServiceBayLogo';
import { NAVIGATION_ENTRIES, isNavActive } from '@/config/navigation';
import { useToast } from '@/providers/ToastProvider';

const FIRST_VISIT_KEY = 'sb.mobileHintShown.v1';

export function MobileTopBar() {
  const router = useRouter();
  const pathname = usePathname() || '';
  const searchParams = useSearchParams();
  const node = searchParams?.get('node');
  const { addToast } = useToast();
  const hintFired = useRef(false);
  // Mirror of the desktop Sidebar's hasActiveInstall pill — mobile
  // users who pressed "Minimize" on the wizard would otherwise have
  // no way back to /setup since the Sidebar is hidden < md.
  const [hasActiveInstall, setHasActiveInstall] = useState(false);
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

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/install/status', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json() as {
          jobIsActive?: boolean;
          stackSetupPending?: boolean;
        };
        if (cancelled) return;
        setHasActiveInstall(Boolean(data.jobIsActive) || Boolean(data.stackSetupPending));
      } catch { /* offline / mid-redeploy — keep the previous value */ }
    };
    void tick();
    const handle = setInterval(tick, 5000);
    return () => { cancelled = true; clearInterval(handle); };
  }, []);

  const setupActive = pathname.startsWith('/setup');

  return (
    <div className="h-14 bg-gray-100 dark:bg-black border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-4 shrink-0 md:hidden z-20">
       {/* Left: Logo + Text */}
       <div className="flex items-center gap-2">
          <ServiceBayLogo size={24} className="text-blue-600 dark:text-blue-400" />
          <div className="flex flex-col">
             <span className="font-bold text-gray-900 dark:text-white text-sm leading-none">
                ServiceBay
             </span>
             <span className="text-[10px] text-gray-500 dark:text-gray-400">by Korgraph.io{appVersion ? ` - v${appVersion}` : ''}</span>
          </div>
       </div>
       {/* Right: Icons */}
       <div className="flex items-center gap-4">
          {hasActiveInstall && (
            <button
              onClick={() => router.push('/setup')}
              className={`relative transition-colors ${
                setupActive
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300'
              }`}
              aria-label="Resume setup"
              title="Resume setup"
            >
              <Wrench size={20} />
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            </button>
          )}
          <button
            onClick={() => router.push(`/settings${node ? `?node=${node}` : ''}`)}
            className="text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
            aria-label="Open settings"
          >
             <Settings size={20} />
          </button>
          <a href="https://github.com/mdopp/servicebay" target="_blank" rel="noreferrer" className="text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
             <Github size={20} />
          </a>
       </div>
    </div>
  );
}

export function MobileBottomBar() {
   const pathname = usePathname() || '';
  const router = useRouter();
  const searchParams = useSearchParams();
  const node = searchParams?.get('node');

  // Honor the per-entry `hiddenOnMobileBottom` flag from the navigation
  // schema — Settings opts out (it's in the mobile top bar's icon row).
  const bottomDashboards = NAVIGATION_ENTRIES.filter(p => !p.hiddenOnMobileBottom);

  return (
    <div className="h-[72px] bg-gray-100 dark:bg-black border-t border-gray-200 dark:border-gray-800 flex items-center justify-around px-2 shrink-0 md:hidden z-20 pb-2">
       {bottomDashboards.map(p => {
          const Icon = p.icon;
          const isActive = isNavActive(pathname, p.path);
          return (
             <button
                key={p.id}
                onClick={() => router.push(`${p.path}${node ? `?node=${node}` : ''}`)}
                title={p.name}
                aria-label={p.name}
                className={`p-2 rounded-xl flex flex-col items-center justify-center gap-1 transition-all ${
                    isActive
                    ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20'
                    : 'text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800'
                }`}
             >
                <Icon size={20} strokeWidth={isActive ? 2.5 : 2} />
                <span className={`text-[9px] leading-none font-medium ${isActive ? '' : 'opacity-70'}`}>{p.shortLabel}</span>
             </button>
          )
       })}
    </div>
  );
}
