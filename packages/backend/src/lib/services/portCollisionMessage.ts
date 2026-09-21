/**
 * What a port collision actually means, and what actually resolves it (#2994).
 *
 * The message used to end *"Change the host port and retry."* That is advice
 * for one situation — you are adding a genuinely new service and picked a port
 * that happens to be taken — and it is wrong for the situation that produces
 * most collisions: **you are replacing what already serves that port.**
 *
 * On 2026-09-20 a session was told to publish a new game where an old one was
 * and that the old one could go. It could not remove the old service (destroy
 * tier, correctly), so it tried to deploy beside it and hit this message. The
 * message told it to change the port. It could not — the domain routes to that
 * port. So it "freed" the port by redeploying the holder with a placeholder
 * image. Two broken services, the domain dark.
 *
 * Two facts were missing from the message and both were known here:
 *
 *  1. **An installed service owns its port whether or not it is running.** That
 *     session had already STOPPED the holder and was still refused. Without
 *     being told, "already in use" by something you just stopped reads like a
 *     bug, and inviting a workaround is exactly what it got.
 *  2. **Replacing the holder is the normal case, and it has a name.** Rolling a
 *     new image onto the service that owns the port, or requesting its removal,
 *     are the two real exits. Changing the port is the third, and it is only
 *     right when the new thing is genuinely new.
 */
import type { HostPortCollision } from './serviceListing';

/** The recipe that covers "this service should serve something else now". */
const ROLL_RECIPE = 'recipe-roll-new-image-to-running-service';

export function describePortCollisions(nodeName: string, collisions: HostPortCollision[]): string {
  const detail = collisions
    .map(c => `port ${c.hostPort} is owned by ${c.serviceName} (${c.holderActive ? 'running' : 'installed but stopped'})`)
    .join('; ');

  const stopped = collisions.filter(c => !c.holderActive);
  const holders = [...new Set(collisions.map(c => c.serviceName))];
  const one = holders.length === 1 ? holders[0] : null;

  const lines = [`Port collision on node "${nodeName}": ${detail}.`];

  if (stopped.length > 0) {
    lines.push(
      'Stopping a service does NOT release its port — an installed service owns it either way, '
      + 'so starting it back up is safe and restarting it will not help here.',
    );
  }

  lines.push(
    one
      ? `If ${one} is what should be replaced, update ${one} itself instead of deploying beside it: `
        + `roll the new image onto it (\`servicebay assist ${ROLL_RECIPE}\`), or ask for its removal `
        + `(\`servicebay request-remove ${one} --reason "…"\`) and deploy once that is approved.`
      : 'If those services are what should be replaced, update them instead of deploying beside them: '
        + `roll the new image onto each (\`servicebay assist ${ROLL_RECIPE}\`), or ask for their removal `
        + '(`servicebay request-remove <service> --reason "…"`) and deploy once that is approved.',
  );

  lines.push(
    'Only if this really is a NEW service alongside the existing one, give it a different host port. '
    + 'Do not redeploy the holder with a placeholder to free the port: that takes down whatever it serves.',
  );

  return lines.join(' ');
}
