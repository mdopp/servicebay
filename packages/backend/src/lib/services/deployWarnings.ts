/**
 * The return channel for a deploy's NON-blocking preflight findings (#3020).
 *
 * The refusal path needs no channel — it throws, and the caller sees why. The
 * warnings did: the first cut logged them and returned the usual "deployed
 * successfully", so a caller had no way to learn that a health probe went
 * unchecked. That is the same silent success the preflight exists to end,
 * reproduced one layer up, and it is how the check could fail on the box for
 * twelve minutes with nothing to read (#3020, reopened).
 *
 * In-memory and last-write-wins on purpose: this is a return value for the call
 * that just happened, not a record. The caller reads it immediately after its
 * own deploy returns and clears it. Anything durable belongs in the journal,
 * which already has these lines.
 *
 * It lives outside `services/lifecycle/` so a caller may read it without
 * reaching past the ServiceManager facade (`service-manager-single-mutation-path`).
 */
const warnings = new Map<string, string[]>();

export function setDeployWarnings(service: string, messages: string[]): void {
  if (messages.length === 0) warnings.delete(service);
  else warnings.set(service, messages);
}

/** Read and clear — a warning delivered twice would outlive its deploy. */
export function takeDeployWarnings(service: string): string[] {
  const found = warnings.get(service) ?? [];
  warnings.delete(service);
  return found;
}
