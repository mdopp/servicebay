import { redirect } from 'next/navigation';

/**
 * `/health` → `/status` (IA redesign slice 2, spec §4.3/§8). Diagnostics is no
 * longer a top-nav noun: box-wide health, diagnose actions, and box-wide
 * containers all live on the single Status screen. The old `/health` and
 * `/health?tab=containers` surfaces are retired — this redirect keeps any deep
 * link or bookmark working and carries the query string through, so
 * `/health?tab=containers` lands on the box-wide containers view (now on Status)
 * and `/health?tab=logs` etc. keep working.
 */
export default async function HealthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, v);
    } else if (value !== undefined) {
      qs.set(key, value);
    }
  }
  const query = qs.toString();
  redirect(query ? `/status?${query}` : '/status');
}
