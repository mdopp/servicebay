/**
 * The scheduler's next-run calculation (#2770).
 *
 * `getNextRunTime` built `next` = today's date at the configured HH:MM and
 * then passed that SAME anchor as `getNextDateForSchedule`'s `now`, so every
 * `next <= now` comparison compared the anchor to itself — always true. Every
 * schedule therefore rolled forward a full cycle even when today's slot was
 * still ahead on the real clock. With the agent updater restarting the backend
 * nightly, a restart landing before the daily slot pushed the daily backup out
 * by another day, every day.
 *
 * These tests freeze the real clock either side of the configured slot and
 * assert the real wall-clock time — not the anchor — decides.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getNextRunTime } from './service';
import type { BackupConfig } from './types';

const base: Omit<BackupConfig, 'schedule'> = {
    enabled: true,
    time: '02:00',
    target: { type: 'local', path: '/mnt/backup' },
};

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('getNextRunTime — today\'s slot is not skipped (#2770)', () => {
    it('schedules a daily run for TODAY when the clock is still before the slot', () => {
        // 01:00 UTC, slot 02:00 UTC — the run is ~1 hour away, not 25.
        vi.setSystemTime(new Date('2026-09-03T01:00:00.000Z'));

        expect(getNextRunTime({ ...base, schedule: 'daily' }).toISOString())
            .toBe('2026-09-03T02:00:00.000Z');
    });

    it('rolls a daily run to tomorrow only once today\'s slot has passed', () => {
        vi.setSystemTime(new Date('2026-09-03T03:00:00.000Z'));

        expect(getNextRunTime({ ...base, schedule: 'daily' }).toISOString())
            .toBe('2026-09-04T02:00:00.000Z');
    });

    it('schedules a weekly run for TODAY when today matches and the slot is ahead', () => {
        // 2026-09-03 is a Thursday (UTC day 4).
        vi.setSystemTime(new Date('2026-09-03T01:00:00.000Z'));

        expect(getNextRunTime({ ...base, schedule: 'weekly', dayOfWeek: 4 }).toISOString())
            .toBe('2026-09-03T02:00:00.000Z');
    });

    it('rolls a weekly run a week out once its slot has passed on the matching day', () => {
        vi.setSystemTime(new Date('2026-09-03T03:00:00.000Z'));

        expect(getNextRunTime({ ...base, schedule: 'weekly', dayOfWeek: 4 }).toISOString())
            .toBe('2026-09-10T02:00:00.000Z');
    });

    it('schedules a monthly run for TODAY when today matches and the slot is ahead', () => {
        vi.setSystemTime(new Date('2026-09-03T01:00:00.000Z'));

        expect(getNextRunTime({ ...base, schedule: 'monthly', dayOfMonth: 3 }).toISOString())
            .toBe('2026-09-03T02:00:00.000Z');
    });

    it('rolls a monthly run to next month once its slot has passed', () => {
        vi.setSystemTime(new Date('2026-09-03T03:00:00.000Z'));

        expect(getNextRunTime({ ...base, schedule: 'monthly', dayOfMonth: 3 }).toISOString())
            .toBe('2026-10-03T02:00:00.000Z');
    });
});

describe('getNextRunTime — hourly always lands in the future', () => {
    // The configured hour is meaningless for an hourly schedule; only the
    // minute is. Anchoring on the configured hour and comparing against the
    // real clock would return a time in the PAST for most of the day, and a
    // negative setTimeout delay fires immediately — a tight backup loop.
    it('uses the current hour and the configured minute when the minute is ahead', () => {
        vi.setSystemTime(new Date('2026-09-03T09:05:00.000Z'));

        expect(getNextRunTime({ ...base, schedule: 'hourly', time: '02:15' }).toISOString())
            .toBe('2026-09-03T09:15:00.000Z');
    });

    it('rolls to the next hour once this hour\'s minute has passed', () => {
        vi.setSystemTime(new Date('2026-09-03T09:20:00.000Z'));

        expect(getNextRunTime({ ...base, schedule: 'hourly', time: '02:15' }).toISOString())
            .toBe('2026-09-03T10:15:00.000Z');
    });

    it('never returns a time in the past, whatever the configured hour', () => {
        vi.setSystemTime(new Date('2026-09-03T15:30:00.000Z'));

        const next = getNextRunTime({ ...base, schedule: 'hourly', time: '02:15' });

        expect(next.getTime()).toBeGreaterThan(Date.now());
    });
});
