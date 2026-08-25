'use client';

import { AlertTriangle, ArrowRight, Layers, Loader2, RefreshCw } from 'lucide-react';
import { StackInstallProgress } from '@/components/StackInstallFlow';
import { Button, Input, Panel } from '@/components/ui';
import {
  useBulkTemplateUpgrade,
  type BulkTemplateUpgradeState,
  type BulkUpgradePlan,
  type PlanEntry,
  type UpgradeSummary,
} from '@/hooks/useBulkTemplateUpgrade';

/**
 * Bulk template upgrade — Settings → Updates (#2602).
 *
 * The gap this fills: container *images* renew themselves through the update
 * window, and ServiceBay updates itself, but a **template** upgrade (new
 * `servicebay.schema-version`, new post-deploy.py, new pod definition) needs a
 * redeploy — and the only way to get one was the install dialog, per service.
 * Nobody clicks through that twenty-one times, so most services never move.
 *
 * Three deliberate properties, each a consequence of an earlier bug:
 *
 *  - **A preview, not an apply-all button.** A template upgrade runs
 *    migrations, and #2595 made a wipe-config reinstall of `auth`/`media`
 *    genuinely destructive. The run is gated on a preview that names every
 *    service, its version hop, the migration scripts that will run and the
 *    ones that *cannot* — plus an explicit acknowledgement when any selected
 *    upgrade is flagged breaking.
 *  - **Dependency order comes from the runner, not from here.** The plan is
 *    built by `planBulkTemplateUpgrade`, which calls the very
 *    `topoSortByDependencies` the install runner calls, so the preview shows
 *    the order the job will actually use.
 *  - **One outcome report — the one #2600/#2601 built.** The run renders
 *    `<StackInstallProgress>`, so a bulk run gets the same per-service rows,
 *    the same `Failed` state and the same "N of M requested services rolled
 *    out" banner as a single upgrade. A bulk path with its own quieter
 *    reporting would be "success reported, nothing done" at twenty times the
 *    scale.
 */
export default function BulkTemplateUpgrade() {
  const s = useBulkTemplateUpgrade();
  const title = (
    <span className="flex items-center gap-2">
      <Layers size={16} className="text-accent" />
      Service template upgrades
    </span>
  );
  const terminal = s.controller.phase === 'done' || s.controller.phase === 'error';

  return (
    <Panel title={title} className="mt-6" data-testid="bulk-template-upgrade">
      {s.error && <p role="alert" className="mb-3 text-sm text-status-fail">{s.error}</p>}

      {s.step === 'select' && <SelectStep state={s} />}
      {s.step === 'preview' && s.plan && <PreviewStep state={s} plan={s.plan} />}

      {s.step === 'running' && (
        <div>
          <StackInstallProgress controller={s.controller} />
          {terminal && (
            <div className="mt-3 flex justify-end">
              <Button variant="secondary" onClick={s.restart}>Back to the list</Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

function SelectStep({ state }: { state: BulkTemplateUpgradeState }) {
  const { pending, selected } = state;
  if (pending === null) {
    return (
      <p className="text-sm text-text-muted flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Checking installed services…
      </p>
    );
  }
  if (pending.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        Every installed service is on its shipped template version. Container images update on their own
        schedule; this list only covers template upgrades, which need a redeploy.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-text-muted">
        {pending.length} service{pending.length === 1 ? ' is' : 's are'} behind the template version shipped in
        the registry. Pick the ones to bring forward — the next step previews exactly what the run would do
        before anything is deployed.
      </p>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={state.selectAll} className="!h-auto !px-2 py-1 text-xs">Select all</Button>
        <Button variant="ghost" onClick={state.selectNone} className="!h-auto !px-2 py-1 text-xs">Select none</Button>
      </div>
      <ul className="border border-border rounded-md divide-y divide-border">
        {pending.map(p => (
          <ChoiceRow key={p.name} entry={p} checked={selected.has(p.name)} onToggle={() => state.toggle(p.name)} />
        ))}
      </ul>
      <div className="flex justify-end">
        <Button variant="primary" onClick={state.preview} disabled={selected.size === 0 || state.planning}>
          {state.planning ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
          Preview {selected.size} upgrade{selected.size === 1 ? '' : 's'}
        </Button>
      </div>
    </div>
  );
}

function ChoiceRow({ entry, checked, onToggle }: { entry: UpgradeSummary; checked: boolean; onToggle: () => void }) {
  return (
    <li>
      <label className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-surface-2">
        <Input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={`Upgrade ${entry.name}`}
          className="w-4 h-4"
        />
        <span className="font-mono text-sm font-medium text-text flex-1 truncate">{entry.name}</span>
        <span className="text-xs text-text-subtle tabular-nums">v{entry.installedVersion} → v{entry.currentVersion}</span>
        {entry.hasBreakingChange && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-status-warn/20 text-status-warn">breaking</span>
        )}
      </label>
    </li>
  );
}

function PreviewStep({ state, plan }: { state: BulkTemplateUpgradeState; plan: BulkUpgradePlan }) {
  const blocked = (plan.hasBreakingChange && !state.acknowledged) || plan.order.length === 0;
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-text">
        {plan.order.length} service{plan.order.length === 1 ? '' : 's'} would be redeployed, in this order
      </h4>
      <PlannedRunList order={plan.order} />
      <ExclusionNotice excluded={plan.excluded} />
      <PreviewFootnote plan={plan} />

      {plan.hasBreakingChange && (
        <label className="flex items-start gap-2 text-sm text-status-warn">
          <Input
            type="checkbox"
            checked={state.acknowledged}
            onChange={e => state.setAcknowledged(e.target.checked)}
            className="w-4 h-4 mt-0.5"
          />
          <span>I have read the breaking-change notes for the services flagged above and want to upgrade them.</span>
        </label>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={state.backToSelect}>Back</Button>
        <Button variant="primary" onClick={state.run} disabled={blocked}>
          <RefreshCw size={14} />
          Upgrade {plan.order.length} service{plan.order.length === 1 ? '' : 's'}
        </Button>
      </div>
    </div>
  );
}

function PlannedRunList({ order }: { order: PlanEntry[] }) {
  if (order.length === 0) {
    return <p className="text-sm text-text-muted">Nothing in this selection can roll out — see the exclusions below.</p>;
  }
  return (
    <ol className="border border-border rounded-md divide-y divide-border">
      {order.map((e, i) => (
        <li key={e.name} className="px-3 py-2 text-sm">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-text-subtle tabular-nums w-5">{i + 1}.</span>
            <span className="font-mono font-medium text-text">{e.name}</span>
            <span className="text-xs text-text-subtle tabular-nums">v{e.installedVersion} → v{e.currentVersion}</span>
            {e.hasBreakingChange && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-status-warn/20 text-status-warn">breaking</span>
            )}
            {e.dependencies.length > 0 && (
              <span className="text-xs text-text-subtle">after {e.dependencies.join(', ')}</span>
            )}
          </div>
          <p className="text-xs text-text-muted mt-0.5 pl-7">
            {e.migrations.length === 0
              ? 'No migration script — redeploy only.'
              : `Runs ${e.migrations.length} migration${e.migrations.length === 1 ? '' : 's'}: ${e.migrations.map(m => m.filename).join(', ')}`}
          </p>
        </li>
      ))}
    </ol>
  );
}

/**
 * The services that are behind but cannot roll out, named BEFORE the run.
 * They are excluded on purpose: the runner stops the whole job at the first
 * failing item, so leaving one in would cost every service queued behind it —
 * and hide the reason in a collapsed row, which is exactly what #2601 was.
 */
function ExclusionNotice({ excluded }: { excluded: PlanEntry[] }) {
  if (excluded.length === 0) return null;
  return (
    <div className="border border-status-warn rounded-md p-3 text-sm">
      <p className="font-semibold text-status-warn flex items-center gap-1.5">
        <AlertTriangle size={14} className="shrink-0" />
        {excluded.length} service{excluded.length === 1 ? '' : 's'} cannot be upgraded and
        {excluded.length === 1 ? ' is' : ' are'} left out of this run
      </p>
      <ul className="mt-1 space-y-1 text-xs text-text-muted">
        {excluded.map(e => (
          <li key={e.name}>
            <span className="font-mono font-medium text-text">{e.name}</span> — {e.excludedReason}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreviewFootnote({ plan }: { plan: BulkUpgradePlan }) {
  const total = plan.order.reduce((n, e) => n + e.migrations.length, 0);
  return (
    <p className="text-xs text-text-muted">
      This redeploys each service from its current template and runs{' '}
      {total === 0 ? 'no migration scripts' : `${total} migration script${total === 1 ? '' : 's'}`}.
      Existing data and saved credentials are kept — this is not a wipe-config reinstall. Services restart as
      they are redeployed, so they are briefly unavailable.
      {plan.satisfiers.length > 0 && ` ${plan.satisfiers.length} other installed service${plan.satisfiers.length === 1 ? ' is' : 's are'} listed to the runner as already-installed dependencies and are not touched.`}
    </p>
  );
}
