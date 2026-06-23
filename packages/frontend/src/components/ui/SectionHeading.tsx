import { cn } from './cn';

/**
 * <SectionHeading> — the shared in-page section label (#2076, epic #2071).
 *
 * Unifies the audited 33 ad-hoc section-heading styles ('Lifecycle',
 * 'Danger zone', 'Configuration', …) into one component. A `tone="danger"`
 * variant tints destructive sections via status-fail instead of an ad-hoc
 * red literal. Renders a real heading element (default <h2>) for document
 * outline / a11y; override via `as`.
 */
export type SectionHeadingTone = 'default' | 'muted' | 'danger';

const tones: Record<SectionHeadingTone, string> = {
  default: 'text-text',
  muted: 'text-text-muted',
  danger: 'text-status-fail',
};

export interface SectionHeadingProps
  extends React.HTMLAttributes<HTMLHeadingElement> {
  tone?: SectionHeadingTone;
  /** Optional secondary description under the heading. */
  description?: React.ReactNode;
  /** Optional right-aligned actions on the heading row. */
  actions?: React.ReactNode;
  /** Heading level element. Default h2. */
  as?: 'h1' | 'h2' | 'h3' | 'h4';
}

export function SectionHeading({
  tone = 'default',
  description,
  actions,
  as: Heading = 'h2',
  className,
  children,
  ...rest
}: SectionHeadingProps) {
  return (
    <div className={cn('flex items-start justify-between gap-space-3', className)}>
      <div className="min-w-0">
        <Heading
          className={cn(
            'text-sm font-semibold uppercase tracking-wide',
            tones[tone],
          )}
          {...rest}
        >
          {children}
        </Heading>
        {description && (
          <p className="mt-space-1 text-xs text-text-muted">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-space-2 shrink-0">{actions}</div>}
    </div>
  );
}

