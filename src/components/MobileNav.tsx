'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Github, Settings } from 'lucide-react';
import ServiceBayLogo from './ServiceBayLogo';
import { plugins } from './Sidebar';
import { useToast } from '@/providers/ToastProvider';
import pkg from '../../package.json';

const FIRST_VISIT_KEY = 'sb.mobileHintShown.v1';

export function MobileTopBar() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const node = searchParams?.get('node');
  const { addToast } = useToast();
  const hintFired = useRef(false);

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

  return (
    <div className="h-14 bg-gray-100 dark:bg-black border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-4 shrink-0 md:hidden z-20">
       {/* Left: Logo + Text */}
       <div className="flex items-center gap-2">
          <ServiceBayLogo size={24} className="text-blue-600 dark:text-blue-400" />
          <div className="flex flex-col">
             <span className="font-bold text-gray-900 dark:text-white text-sm leading-none">
                ServiceBay
             </span>
             <span className="text-[10px] text-gray-500 dark:text-gray-400">by Korgraph.io - v{pkg.version}</span>
          </div>
       </div>
       {/* Right: Icons */}
       <div className="flex items-center gap-4">
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

  // Exclude settings as it is in the top bar
  const bottomPlugins = plugins.filter(p => p.id !== 'settings');

  return (
    <div className="h-[72px] bg-gray-100 dark:bg-black border-t border-gray-200 dark:border-gray-800 flex items-center justify-around px-2 shrink-0 md:hidden z-20 pb-2">
       {bottomPlugins.map(p => {
          const Icon = p.icon;
          const isActive = pathname?.startsWith(p.path);
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
