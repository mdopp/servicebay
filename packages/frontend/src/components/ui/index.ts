/**
 * Design-system primitives (epic #2071, foundation tokens #2072).
 *
 * One shared, token-wired library for the app's surfaces — import from
 * `@/components/ui` rather than re-authoring ad-hoc class-chains. Migrations of
 * existing surfaces onto these land in #2078/#2079.
 */
export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

export { Card, Panel } from './Card';
export type { CardProps, PanelProps, CardPadding } from './Card';

export { DataTable } from './DataTable';
export type { DataTableProps, Column } from './DataTable';

export { Badge } from './Badge';
export type { BadgeProps, BadgeVariant } from './Badge';

export { StatusDot } from './StatusDot';
export type { StatusDotProps, StatusState } from './StatusDot';

export { SectionHeading } from './SectionHeading';
export type { SectionHeadingProps, SectionHeadingTone } from './SectionHeading';

export { Field } from './Field';
export type { FieldProps } from './Field';

export { cn } from './cn';
export type { ClassValue } from './cn';
