'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, ChevronUp, ExternalLink, Smartphone } from 'lucide-react';
import type { PortalCard } from '@/lib/portal/services';

/**
 * Renders the portal card grid + per-card collapsible Getting-started
 * section. Server passes the per-card payload pre-built (incl. parsed
 * markdown body) — this component handles only the UI state.
 */
export default function PortalGrid({ cards }: { cards: PortalCard[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
      {cards.map(card => {
        const isExpanded = !!expanded[card.name];
        return (
          <div
            key={card.name}
            className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm overflow-hidden flex flex-col"
          >
            <div className="p-6 flex-1">
              <div className="text-5xl mb-3" aria-hidden>{card.icon || '📦'}</div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">{card.label}</h2>
              {card.tagline && (
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{card.tagline}</p>
              )}
            </div>

            <div className="px-6 pb-6 space-y-3">
              <a
                href={card.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full bg-violet-600 hover:bg-violet-700 text-white font-medium py-2.5 rounded-lg transition-colors"
              >
                Open <ExternalLink size={16} />
              </a>

              {card.mobileApps.length > 0 && (
                <div className="flex flex-wrap gap-2 justify-center pt-1">
                  {card.mobileApps.map(app => (
                    <a
                      key={app.url}
                      href={app.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-400 hover:text-violet-700 dark:hover:text-violet-300 underline"
                    >
                      <Smartphone size={12} /> {app.name}
                    </a>
                  ))}
                </div>
              )}

              {card.body.trim().length > 0 && (
                <div>
                  <button
                    onClick={() => setExpanded(s => ({ ...s, [card.name]: !s[card.name] }))}
                    className="flex items-center gap-1 text-sm text-violet-700 dark:text-violet-300 hover:underline mt-2"
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    {isExpanded ? 'Hide getting-started' : 'How do I use this?'}
                  </button>
                  {isExpanded && (
                    <div className="prose prose-sm dark:prose-invert mt-3 max-w-none text-gray-700 dark:text-gray-300">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{card.body}</ReactMarkdown>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
