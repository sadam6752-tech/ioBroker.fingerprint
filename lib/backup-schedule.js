'use strict';

/**
 * When the next automatic fingerprint backup is due.
 *
 * The time of the last backup (by hand or automatic) is kept in the state `info.lastBackup`, so a
 * restart of the adapter does not reset the clock: a weekly backup still runs although the
 * instance is restarted every few days. A backup that is overdue (or was never made) runs a few
 * minutes after the start, when the device connection has settled.
 */

/** Wait at least this long after the start before an overdue backup runs. */
const MIN_DELAY_MS = 5 * 60_000;

/** Longest delay for one timer (the limit of `setTimeout` is about 24.8 days). */
const MAX_DELAY_MS = 24 * 24 * 3_600_000;

/** Intervals offered in the settings, in hours (0 = off). */
const AUTO_BACKUP_INTERVALS = [0, 24, 168];

/**
 * Milliseconds until the next automatic backup.
 *
 * @param {number|string|undefined} intervalHours configured interval in hours, 0 or empty = off
 * @param {number|null|undefined} lastBackup time of the last backup (ms since 1970), empty = never
 * @param {number} [now] current time (ms since 1970)
 * @returns {number|null} delay in ms, or null when the automatic backup is switched off
 */
function autoBackupDelay(intervalHours, lastBackup, now = Date.now()) {
    const hours = Number(intervalHours);
    if (!Number.isFinite(hours) || hours <= 0) {
        return null;
    }
    const interval = hours * 3_600_000;
    const last = Number(lastBackup);
    if (!Number.isFinite(last) || last <= 0) {
        return MIN_DELAY_MS;
    }
    // a time stamp in the future (the clock was set back): count from now
    const due = (last > now ? now : last) + interval;
    return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, due - now));
}

module.exports = { autoBackupDelay, AUTO_BACKUP_INTERVALS, MIN_DELAY_MS, MAX_DELAY_MS };
