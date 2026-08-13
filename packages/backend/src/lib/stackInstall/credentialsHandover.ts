/**
 * Forced credential hand-over (#2560).
 *
 * ServiceBay hands the freshly-generated passwords to the operator exactly
 * once, as a downloaded file, and drops its own copy in the same operation.
 * This module owns the server half: it issues the file and it is the only
 * thing that can delete a password.
 *
 * ## Why deletion is not gated on a button
 *
 * "The user clicked Download" is not evidence the file arrived — the
 * browser can refuse the save, the tab can be closed mid-write, the
 * response can be truncated. Deleting on a click would turn a blocked
 * download into permanently lost credentials, which is the one outcome
 * this whole feature exists to prevent.
 *
 * So the hand-over is two calls with a **proof of receipt** between them:
 *
 *  1. `issueHandover()` builds the CSV, remembers its receipt
 *     (`credentialReceipt` — byte count + hash) and exactly which entries
 *     went into it, and returns the file with a one-shot token.
 *  2. The browser saves the file. Only if the save call returns without
 *     throwing does it come back with the token plus the receipt **it
 *     computed over the bytes it wrote**.
 *  3. `redeemHandover()` deletes only if that receipt equals the one this
 *     module recorded, and only for the entries the ticket names.
 *
 * A caller cannot produce the receipt without holding the complete,
 * uncorrupted file, so an optimistic "success" path cannot fake it: a
 * truncated download, a swapped file, a replayed token, or a `catch` that
 * skipped the save all fail the comparison and nothing is deleted. The
 * honest limit of the evidence: no browser API can prove bytes reached the
 * disk, so what is proven is that the whole file reached the page that
 * asked for it and that the page's save call did not fail. That is the
 * strongest available signal, and it fails **closed** — every failure mode
 * leaves the password exactly where it was.
 *
 * Entries added by an install that finishes between step 1 and step 3 are
 * not in the ticket and therefore survive: they are simply still pending.
 */
import { randomBytes } from 'node:crypto';
import { getConfig, saveConfig, type InstalledCredential, type InstallManifest } from '@/lib/config';
import { withCredentialsLock } from '@/lib/stackInstall/credentialsLock';
import {
  buildBitwardenCsv,
  credentialKey,
  credentialReceipt,
  dropDeliveredPasswords,
  isCredentialSecured,
  type Credential,
  type CredentialUrlContext,
} from '@/lib/stackInstall/credentialsManifest';

/** A ticket outlives a slow save but not an abandoned tab. */
const TICKET_TTL_MS = 15 * 60 * 1000;
/** Enough for a couple of retries; a bound so a scripted caller can't grow the map. */
const MAX_TICKETS = 8;

interface Ticket {
  /** `credentialReceipt` of the CSV exactly as it was handed out. */
  receipt: string;
  /** `credentialKey`s of the entries that went into that CSV. */
  keys: string[];
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();

function prune(now: number): void {
  for (const [token, t] of tickets) if (t.expiresAt <= now) tickets.delete(token);
  while (tickets.size >= MAX_TICKETS) {
    const oldest = tickets.keys().next();
    if (oldest.done) break;
    tickets.delete(oldest.value);
  }
}

/** URL-rewrite context so the file's links match what the UI shows (#1626). */
function urlContext(config: Awaited<ReturnType<typeof getConfig>>): CredentialUrlContext {
  return {
    hosts: (config.reverseProxy?.hosts ?? []).map(h => ({ domain: h.domain, service: h.service })),
    publicDomain: config.reverseProxy?.publicDomain ?? undefined,
  };
}

export interface HandoverOffer {
  token: string;
  /** The whole file, inline — the caller must hold the bytes to confirm. */
  csv: string;
  filename: string;
  /** Entries in this file. */
  count: number;
}

/** Every entry ServiceBay is still the only copy of. */
export function pendingCredentials(creds: readonly Credential[]): Credential[] {
  return creds.filter(c => !isCredentialSecured(c));
}

/**
 * Build the hand-over file and remember what was in it.
 *
 * Returns `null` when nothing is pending — there is nothing to hand over,
 * so there is nothing to force.
 */
export async function issueHandover(now = Date.now()): Promise<HandoverOffer | null> {
  const config = await getConfig();
  const pending = pendingCredentials((config.installManifest?.credentials ?? []) as Credential[]);
  if (pending.length === 0) return null;

  const csv = buildBitwardenCsv(pending, urlContext(config));
  const token = randomBytes(24).toString('hex');
  prune(now);
  tickets.set(token, {
    receipt: credentialReceipt(csv),
    keys: pending.map(credentialKey),
    expiresAt: now + TICKET_TTL_MS,
  });

  return {
    token,
    csv,
    filename: `servicebay-credentials-${new Date(now).toISOString().slice(0, 10)}.csv`,
    count: pending.length,
  };
}

export type RedeemResult =
  | { ok: true; dropped: number }
  | { ok: false; reason: 'unknown_token' | 'receipt_mismatch' };

/**
 * Delete ServiceBay's copy of the delivered passwords — and only on proof.
 *
 * The ticket is consumed on success only. A receipt mismatch leaves it
 * alive so the browser can retry the save with the same file; nothing is
 * deleted in the meantime.
 */
export async function redeemHandover(
  token: string,
  receipt: string,
  now = Date.now(),
): Promise<RedeemResult> {
  prune(now);
  const ticket = tickets.get(token);
  // An expired or never-issued token is the same answer: we have no record
  // that this file was ever handed out, so we have no grounds to delete.
  if (!ticket) return { ok: false, reason: 'unknown_token' };
  if (ticket.receipt !== receipt) return { ok: false, reason: 'receipt_mismatch' };

  const keys = new Set(ticket.keys);
  let dropped = 0;
  await withCredentialsLock(async () => {
    const config = await getConfig();
    const existing = (config.installManifest?.credentials ?? []) as Credential[];
    const next = dropDeliveredPasswords(existing, keys);
    dropped = existing.filter((c, i) => !isCredentialSecured(c) && isCredentialSecured(next[i])).length;
    if (dropped === 0) return;
    const manifest: InstallManifest = {
      savedAt: new Date(now).toISOString(),
      credentials: next as unknown as InstalledCredential[],
    };
    await saveConfig({ ...config, installManifest: manifest });
  });

  tickets.delete(token);
  return { ok: true, dropped };
}

/** Test seam: drop every outstanding ticket. */
export function resetHandoverTickets(): void {
  tickets.clear();
}
