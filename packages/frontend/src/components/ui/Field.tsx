'use client';

import { useId } from 'react';
import { cn } from './cn';

/**
 * <Field> — the shared label+control wrapper (#2076, epic #2071).
 *
 * Unifies the uneven label/control/help/error combos into one accessible
 * layout: a real <label> wired to the control via a generated id, an optional
 * help line, and an error line announced with role="alert" + aria-invalid on
 * the control. Pass the control as a render-prop so the field owns the id and
 * aria wiring without cloning children.
 */
export interface FieldProps {
  label: React.ReactNode;
  /** Render-prop receiving the wired control props (id + aria-*). */
  children: (props: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: boolean;
  }) => React.ReactNode;
  /** Help text under the control. */
  help?: React.ReactNode;
  /** Error message — shown in status-fail and announced. Overrides help tone. */
  error?: React.ReactNode;
  /** Mark the label with a required asterisk. */
  required?: boolean;
  className?: string;
}

export function Field({
  label,
  children,
  help,
  error,
  required,
  className,
}: FieldProps) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, helpId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-space-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-text-muted">
        {label}
        {required && <span className="ml-space-1 text-status-fail" aria-hidden="true">*</span>}
      </label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
      })}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-status-fail">
          {error}
        </p>
      ) : (
        help && (
          <p id={helpId} className="text-xs text-text-subtle">
            {help}
          </p>
        )
      )}
    </div>
  );
}

