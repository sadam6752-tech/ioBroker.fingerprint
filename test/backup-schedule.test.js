'use strict';

const assert = require('node:assert/strict');
const { autoBackupDelay, MIN_DELAY_MS, MAX_DELAY_MS } = require('../lib/backup-schedule');

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

describe('backup schedule', () => {
    it('is off for 0, empty or broken intervals', () => {
        for (const value of [0, '0', '', undefined, null, -24, 'abc', Number.NaN]) {
            assert.equal(autoBackupDelay(value, NOW - HOUR, NOW), null, `interval ${String(value)}`);
        }
    });

    it('runs a few minutes after the start when no backup was ever made', () => {
        assert.equal(autoBackupDelay(24, 0, NOW), MIN_DELAY_MS);
        assert.equal(autoBackupDelay(24, null, NOW), MIN_DELAY_MS);
        assert.equal(autoBackupDelay(24, undefined, NOW), MIN_DELAY_MS);
    });

    it('runs a few minutes after the start when the backup is overdue', () => {
        assert.equal(autoBackupDelay(24, NOW - 30 * HOUR, NOW), MIN_DELAY_MS);
    });

    it('waits for the rest of the interval since the last backup (a restart keeps the clock)', () => {
        assert.equal(autoBackupDelay(24, NOW - 20 * HOUR, NOW), 4 * HOUR);
        assert.equal(autoBackupDelay('168', NOW - 24 * HOUR, NOW), 144 * HOUR);
    });

    it('counts from now when the last backup lies in the future', () => {
        assert.equal(autoBackupDelay(24, NOW + 5 * HOUR, NOW), 24 * HOUR);
    });

    it('never exceeds the limit of a timer', () => {
        assert.equal(autoBackupDelay(24 * 60, NOW, NOW), MAX_DELAY_MS);
        assert.ok(MAX_DELAY_MS < 2 ** 31 - 1);
    });
});
