'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { searchSettings, type SearchHit } from './ia';

/**
 * Global settings search / command palette (#1956).
 *
 * Type any setting's name and jump straight to it — the result navigates to
 * the owning goal-group and the URL hash auto-expands the (possibly Advanced)
 * setting via SettingDisclosure. Keyboard: ↑/↓ to move, Enter to jump, Esc to
 * close. This is the "any setting findable by name" acceptance.
 */
function handleSearchKeyDown(
  e: React.KeyboardEvent,
  ctx: {
    open: boolean;
    hits: SearchHit[];
    activeIndex: number;
    setActive: (fn: (a: number) => number) => void;
    setOpen: (v: boolean) => void;
    jump: (hit: SearchHit) => void;
  },
) {
  const { open, hits, activeIndex, setActive, setOpen, jump } = ctx;
  if (!open || hits.length === 0) {
    if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setActive(a => (a + 1) % hits.length);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setActive(a => (a - 1 + hits.length) % hits.length);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    jump(hits[activeIndex]);
  } else if (e.key === 'Escape') {
    setOpen(false);
  }
}

function SearchResults({
  query,
  hits,
  activeIndex,
  onHover,
  onPick,
}: {
  query: string;
  hits: SearchHit[];
  activeIndex: number;
  onHover: (i: number) => void;
  onPick: (hit: SearchHit) => void;
}) {
  return (
    <div className="absolute z-30 mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg overflow-hidden">
      {hits.length === 0 ? (
        <div className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">No settings match “{query}”.</div>
      ) : (
        hits.map((hit, i) => (
          <button
            key={hit.href}
            type="button"
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(hit)}
            className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left text-sm transition-colors ${
              i === activeIndex
                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/40'
            }`}
          >
            <span className="font-medium">{hit.entry.label}</span>
            <span className="text-xs text-gray-400 dark:text-gray-500">{hit.group.label}</span>
          </button>
        ))
      )}
    </div>
  );
}

export default function SettingsSearch() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const hits = useMemo<SearchHit[]>(() => searchSettings(query).slice(0, 8), [query]);

  // Clamp the active index to the current results during render — avoids an
  // effect+setState (cascading-render lint) when the query narrows the list.
  const activeIndex = hits.length === 0 ? 0 : Math.min(active, hits.length - 1);

  // Close on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const jump = (hit: SearchHit) => {
    setOpen(false);
    setQuery('');
    router.push(hit.href);
  };

  const onKeyDown = (e: React.KeyboardEvent) =>
    handleSearchKeyDown(e, { open, hits, activeIndex, setActive, setOpen, jump });

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search settings…"
          aria-label="Search settings"
          className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        />
      </div>

      {open && query.trim() !== '' && (
        <SearchResults
          query={query}
          hits={hits}
          activeIndex={activeIndex}
          onHover={setActive}
          onPick={jump}
        />
      )}
    </div>
  );
}
