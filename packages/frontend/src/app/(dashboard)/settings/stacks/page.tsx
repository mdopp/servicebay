'use client';

import { useEffect, useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';

import StackCard from '@/components/StackCard';
import type { StackManifest } from '@/lib/template/stackContract';
import type { StackHealth } from '@/lib/install/stackHealth';
import TemplateRegistriesSection from '../_lib/sections/TemplateRegistriesSection';
import TemplateVariablesSection from '../_lib/sections/TemplateVariablesSection';

interface StackSummary {
  name: string;
  manifest: StackManifest | null;
  health: StackHealth | null;
}

/**
 * Settings → Stacks (#634 / Phase 5B).
 *
 * Post-install management view for the stacks layer: per-stack health
 * + wipe action. The wizard's install flow still operates on flat
 * templates today — the stack-aware wizard rewrite is a Phase 5B
 * follow-up. This page is where the operator lives once everything's
 * deployed and they need to wipe / reinstall a single feature stack.
 */
export default function StacksPage() {
  return (
    <div className="space-y-6">
      <ManagedStacks />
      <TemplateRegistriesSection />
      <TemplateVariablesSection />
    </div>
  );
}

function ManagedStacks() {
  const [stacks, setStacks] = useState<StackSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/system/stacks');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json() as { stacks: StackSummary[] };
      setStacks(data.stacks);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async stacks load + poll, not a cascading-render anti-pattern
    void refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (error) {
    return (
      <div className="p-6 text-sm text-red-600 dark:text-red-400">
        Failed to load stacks: {error}
      </div>
    );
  }

  if (stacks === null) {
    return (
      <div className="p-6 text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" />
        Loading stacks…
      </div>
    );
  }

  if (stacks.length === 0) {
    return (
      <div className="p-6 text-sm text-gray-500 dark:text-gray-400">
        No stacks registered. Run the install wizard from the sidebar to set up your first stack.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        Stacks group templates with shared lifecycle. Wipe removes every template in a stack (data + cross-service registrations). The core stack is atomic-wipe — use <strong>System → Factory Reset</strong> for that path.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {stacks.map(s => (
          <StackCard
            key={s.name}
            name={s.name}
            manifest={s.manifest}
            health={s.health}
            onWiped={refresh}
          />
        ))}
      </div>
    </div>
  );
}
