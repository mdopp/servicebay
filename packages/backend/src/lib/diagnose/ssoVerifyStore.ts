/**
 * Persistence for the most-recent SSO verification report (#1454).
 *
 * `verifySso` (#1453) runs the full create→login→domain→admin-reject→delete
 * spine and returns a structured report, but the report lives only in the
 * call's return value. #1454 fires that verification automatically after a
 * successful install and #1455 surfaces it in the diagnose UI — both need
 * the report to survive past the call that produced it.
 *
 * This is a deliberately tiny single-slot store: we only ever care about
 * the *latest* run (the install that just finished, or the operator's last
 * on-demand click). A single JSON file under DATA_DIR, atomic-written the
 * same way jobStore writes its job state, is enough — no history, no
 * indexing. A missing/corrupt file reads back as `null` so a fresh box (or
 * a box that has never run the verification) simply reports "not run yet".
 */

import fs from 'fs/promises';
import path from 'path';
import { DATA_DIR } from '@/lib/dirs';
import { logger } from '@/lib/logger';
import type { SsoVerifyReport } from '@/lib/diagnose/ssoVerify';

const STORE_PATH = path.join(DATA_DIR, 'sso-verify-report.json');

/** The latest report plus when it was produced. `at` is an ISO string so
 *  the UI can show "ran 3 minutes ago" without a separate mtime stat. */
export interface StoredSsoVerifyReport {
  at: string;
  report: SsoVerifyReport;
}

/**
 * Persist `report` as the latest SSO verification result. Atomic
 * (write-tmp + rename) so a concurrent read never sees a half-written
 * file. Best-effort: a write failure is logged and swallowed — the
 * verification itself already ran; failing to cache it must not bubble
 * into the install runner or the on-demand action.
 */
export async function saveSsoVerifyReport(report: SsoVerifyReport): Promise<void> {
  const payload: StoredSsoVerifyReport = { at: new Date().toISOString(), report };
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${STORE_PATH}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
    await fs.rename(tmp, STORE_PATH);
  } catch (e) {
    logger.warn('ssoVerifyStore', `could not persist SSO verify report: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Read the latest persisted report, or `null` if none exists yet (fresh
 * box) or the file is unreadable/corrupt. Never throws — the diagnose
 * probe treats `null` as "not run yet".
 */
export async function loadSsoVerifyReport(): Promise<StoredSsoVerifyReport | null> {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as StoredSsoVerifyReport;
    if (parsed && typeof parsed.at === 'string' && parsed.report) return parsed;
    return null;
  } catch {
    return null;
  }
}
