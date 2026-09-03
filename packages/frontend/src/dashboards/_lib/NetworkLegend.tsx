'use client';

/**
 * The graph's bottom-left legend panel and the MiniMap colour lookups.
 * Lifted verbatim out of NetworkDashboard.tsx (#2743).
 */
import { useState } from 'react';
import { Panel } from '@xyflow/react';
import { Info, Globe, ChevronDown, Lock } from 'lucide-react';
import { Button } from '@/components/ui';
import { MINIMAP_NODE_COLORS, MINIMAP_STROKE_COLORS } from './networkDashboard';

// Helper: get MiniMap color for node type
export function getMiniMapNodeColor(type: string): string {
  return MINIMAP_NODE_COLORS[type] ?? MINIMAP_NODE_COLORS.internet;
}

// Helper: get MiniMap stroke color for node type
export function getMiniMapStrokeColor(type: string): string {
  return MINIMAP_STROKE_COLORS[type] ?? MINIMAP_STROKE_COLORS.internet;
}

// Legend body extracted from NetworkLegend so the panel wrapper stays under
// the max-lines-per-function budget after the #1785 badge rows landed.
function LegendBody() {
    return (
        <div className="px-3 pb-2 space-y-1.5 border-t border-border pt-2">
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-status-info" /><span>Service / Pod</span></div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-accent" /><span>Container</span></div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-accent-secondary" /><span>Gateway</span></div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-accent" /><span>External Link</span></div>
            <div className="flex items-center gap-2"><div className="w-3 h-3 rounded bg-border" /><span>Group / Node</span></div>
            <div className="border-t border-border pt-1.5 mt-1.5">
                <div className="flex items-center gap-2"><div className="w-2.5 h-2.5 rounded-full bg-status-ok" /><span>Active / Running</span></div>
                <div className="flex items-center gap-2 mt-1"><div className="w-2.5 h-2.5 rounded-full bg-status-fail" /><span>Stopped / Error</span></div>
            </div>
            <div className="border-t border-border pt-1.5 mt-1.5 space-y-1">
                <div className="flex items-center gap-2">
                    <svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="var(--status-info)" strokeWidth="2" /></svg>
                    <span>Observed TCP flow</span>
                </div>
                <div className="flex items-center gap-2">
                    <svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="var(--status-warn)" strokeWidth="2" strokeDasharray="4 4" /></svg>
                    <span>Declared dependency</span>
                </div>
                <div className="flex items-center gap-2">
                    <svg width="20" height="6"><line x1="0" y1="3" x2="20" y2="3" stroke="var(--accent-secondary)" strokeWidth="2" strokeDasharray="2 3" /></svg>
                    <span>Inferred (env / host)</span>
                </div>
            </div>
            {/* Ubiquitous-dependency badges (#1785). Hub-spoke edges to
                auth/LLDAP and AdGuard DNS are collapsed into these node
                badges to keep the map planar. */}
            <div className="border-t border-border pt-1.5 mt-1.5 space-y-1">
                <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1 py-0.5 rounded bg-surface-2 text-text border border-border"><Lock size={9} /> SSO</span>
                    <span>Hinter Authelia/LLDAP</span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1 py-0.5 rounded bg-surface-2 text-text border border-border"><Globe size={9} /> DNS</span>
                    <span>DNS über AdGuard</span>
                </div>
            </div>
        </div>
    );
}

export function NetworkLegend() {
    const [isOpen, setIsOpen] = useState(false);
    return (
        <Panel position="bottom-left">
            <div className="bg-surface border border-border rounded-card shadow-sm text-xs">
                <Button
                    variant="ghost"
                    onClick={() => setIsOpen(!isOpen)}
                    className="!h-auto !px-3 !py-1.5 flex items-center gap-1.5 text-text-muted hover:text-text font-medium w-full"
                >
                    <Info size={12} />
                    Legend
                    <ChevronDown size={12} className={`ml-auto transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </Button>
                {isOpen && <LegendBody />}
            </div>
        </Panel>
    );
}

