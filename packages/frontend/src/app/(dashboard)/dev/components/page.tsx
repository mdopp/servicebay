'use client';

import { notFound } from 'next/navigation';
import {
  Button,
  Card,
  Panel,
  DataTable,
  Badge,
  StatusDot,
  SectionHeading,
  Field,
  PageScroll,
  type ButtonVariant,
  type ButtonSize,
  type BadgeVariant,
  type StatusState,
  type SectionHeadingTone,
  type CardPadding,
  type Column,
} from '@/components/ui';

/**
 * `/dev/components` — the living component catalog (discovery, issue 2354).
 *
 * "You can only reuse what you can find." The `@/components/ui` primitives
 * existed but were invisible — no gallery, no Storybook — so surfaces
 * re-authored ad-hoc class-chains instead of importing the shared library.
 * This route renders EVERY primitive off the barrel in its key states, so the
 * next author finds `<Badge variant="warn">` instead of inventing one.
 *
 * Lightweight on purpose (CLAUDE.md ethos: no heavy new dependency like
 * Storybook). It's an in-app dev/admin surface: the whole `(dashboard)` group
 * already sits behind the single-admin session, and this page is additionally
 * DEV-ONLY — a production build returns 404 (`notFound()`), so the catalog
 * never ships to an operator's box.
 *
 * The page is built from the primitives + `@theme` tokens (no raw
 * `<button>`/`<table>`/color literals), so it stays honest: if a primitive
 * regresses, its gallery entry regresses with it. The one exception is the
 * <Field> demo, which by design wraps a raw form control via its render-prop
 * (there is no companion Input primitive) — that raw <input> is the correct
 * usage, so the lint rule is disabled there with justification.
 */

const BUTTON_VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger'];
const BUTTON_SIZES: ButtonSize[] = ['sm', 'md'];
const BADGE_VARIANTS: BadgeVariant[] = ['neutral', 'ok', 'warn', 'fail', 'info', 'accent'];
const STATUS_STATES: StatusState[] = ['ok', 'warn', 'fail', 'unknown'];
const HEADING_TONES: SectionHeadingTone[] = ['default', 'muted', 'danger'];
const CARD_PADDINGS: CardPadding[] = ['none', 'sm', 'md', 'lg'];

/** A named block in the gallery — the id doubles as a section anchor + test hook. */
function Entry({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <Panel title={title} data-catalog-entry={id}>
      <div className="flex flex-wrap items-start gap-space-4">{children}</div>
    </Panel>
  );
}

/** A single labelled specimen (variant/state name over the rendered primitive). */
function Specimen({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-space-2">
      <span className="text-xs font-mono text-text-subtle">{label}</span>
      {children}
    </div>
  );
}

/** The <Field> control: a raw <input> is the intended payload of Field's
 *  render-prop (Field owns the id/aria wiring; there is no Input primitive), so
 *  the raw-ui-primitive rule is correctly disabled for this single element. */
function DemoInput(
  props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean } & {
    className: string;
    placeholder?: string;
    defaultValue?: string;
  },
) {
  // eslint-disable-next-line sb/no-raw-ui-primitive -- Field's render-prop wraps a raw control by design; no Input primitive exists.
  return <input {...props} />;
}

interface DemoRow {
  service: string;
  state: StatusState;
  containers: number;
}

const DEMO_ROWS: DemoRow[] = [
  { service: 'media', state: 'ok', containers: 3 },
  { service: 'immich', state: 'warn', containers: 2 },
  { service: 'vaultwarden', state: 'fail', containers: 1 },
];

const DEMO_COLUMNS: Column<DemoRow>[] = [
  { key: 'service', header: 'Service', cell: (r) => <span className="font-medium text-text">{r.service}</span> },
  { key: 'state', header: 'Health', cell: (r) => <StatusDot state={r.state} showLabel /> },
  { key: 'containers', header: 'Containers', align: 'right', cell: (r) => r.containers },
];

function ButtonEntry() {
  return (
    <Entry id="button" title="Button">
      {BUTTON_VARIANTS.map((variant) => (
        <Specimen key={variant} label={`variant="${variant}"`}>
          <div className="flex items-center gap-space-2">
            {BUTTON_SIZES.map((size) => (
              <Button key={size} variant={variant} size={size}>
                {size}
              </Button>
            ))}
          </div>
        </Specimen>
      ))}
      <Specimen label="disabled">
        <Button disabled>disabled</Button>
      </Specimen>
    </Entry>
  );
}

function CardEntry() {
  return (
    <Entry id="card" title="Card / Panel">
      {CARD_PADDINGS.map((padding) => (
        <Specimen key={padding} label={`Card padding="${padding}"`}>
          <Card padding={padding} className="w-40">
            <span className="text-sm text-text-muted">Surface</span>
          </Card>
        </Specimen>
      ))}
      <Specimen label="Panel (title + actions)">
        <Panel title="Panel" actions={<Badge variant="accent">beta</Badge>} className="w-56">
          <span className="text-sm text-text-muted">Body region</span>
        </Panel>
      </Specimen>
    </Entry>
  );
}

function BadgeEntry() {
  return (
    <Entry id="badge" title="Badge">
      {BADGE_VARIANTS.map((variant) => (
        <Specimen key={variant} label={`variant="${variant}"`}>
          <Badge variant={variant}>{variant}</Badge>
        </Specimen>
      ))}
    </Entry>
  );
}

function StatusDotEntry() {
  return (
    <Entry id="status-dot" title="StatusDot">
      {STATUS_STATES.map((state) => (
        <Specimen key={state} label={`state="${state}"`}>
          <StatusDot state={state} showLabel />
        </Specimen>
      ))}
      <Specimen label="dot only (SR label)">
        <StatusDot state="ok" />
      </Specimen>
    </Entry>
  );
}

function SectionHeadingEntry() {
  return (
    <Entry id="section-heading" title="SectionHeading">
      {HEADING_TONES.map((tone) => (
        <Specimen key={tone} label={`tone="${tone}"`}>
          <SectionHeading tone={tone} description="Optional description line.">
            {tone} heading
          </SectionHeading>
        </Specimen>
      ))}
    </Entry>
  );
}

function FieldEntry() {
  return (
    <Entry id="field" title="Field">
      <Specimen label="with help">
        <Field label="Service name" help="Lowercase, used as the systemd unit id.">
          {(props) => (
            <DemoInput
              {...props}
              className="h-10 rounded-card border border-border bg-surface-2 px-space-3 text-sm text-text"
              placeholder="media"
            />
          )}
        </Field>
      </Specimen>
      <Specimen label="required + error">
        <Field label="Domain" required error="Not a valid hostname.">
          {(props) => (
            <DemoInput
              {...props}
              className="h-10 rounded-card border border-status-fail bg-surface-2 px-space-3 text-sm text-text"
              defaultValue="not a host"
            />
          )}
        </Field>
      </Specimen>
    </Entry>
  );
}

function DataTableEntry() {
  return (
    <Entry id="data-table" title="DataTable">
      <div className="w-full">
        <DataTable columns={DEMO_COLUMNS} rows={DEMO_ROWS} rowKey={(r) => r.service} empty="No services." />
      </div>
      <Specimen label="empty state">
        <div className="w-64">
          <DataTable columns={DEMO_COLUMNS} rows={[]} rowKey={(r) => r.service} empty="No services yet." />
        </div>
      </Specimen>
    </Entry>
  );
}

function PageScrollEntry() {
  return (
    <Entry id="page-scroll" title="PageScroll">
      <span className="text-sm text-text-muted">
        This very page is wrapped in <span className="font-mono">&lt;PageScroll&gt;</span> — the single
        flex-chain scroll region primitive (also exports{' '}
        <span className="font-mono">PageShell</span> / <span className="font-mono">PageScrollRegion</span>{' '}
        for a pinned header).
      </span>
    </Entry>
  );
}

export default function ComponentCatalogPage() {
  // Dev-only discovery surface — never ship the gallery to a production box.
  if (process.env.NODE_ENV === 'production') {
    notFound();
  }

  return (
    <PageScroll className="px-space-6 py-space-6">
      <SectionHeading
        as="h1"
        description="A living gallery of every @/components/ui primitive in its key states — import these instead of re-authoring class-chains. Dev-only route."
      >
        Component catalog
      </SectionHeading>
      <ButtonEntry />
      <CardEntry />
      <BadgeEntry />
      <StatusDotEntry />
      <SectionHeadingEntry />
      <FieldEntry />
      <DataTableEntry />
      <PageScrollEntry />
    </PageScroll>
  );
}
