'use strict';

const assert = require('node:assert/strict');
const {
    backupName,
    isBackupName,
    sortBackupsNewestFirst,
    selectLocalBackupsToPrune,
    validateBackupContent,
    backupLabel,
} = require('../lib/backup-store');

const DATE = new Date('2026-10-16T08:09:10.500Z');

describe('backup store => names', () => {
    it('builds the names of the three kinds', () => {
        assert.equal(backupName('manual', DATE), 'fingerprint-backup-2026-10-16T08-09-10.json');
        assert.equal(backupName('auto', DATE), 'fingerprint-auto-2026-10-16T08-09-10.json');
        assert.equal(backupName('prerestore', DATE), 'fingerprint-prerestore-2026-10-16T08-09-10.json');
    });

    it('accepts only backup names of this adapter', () => {
        for (const kind of ['manual', 'auto', 'prerestore']) {
            assert.equal(isBackupName(backupName(kind, DATE)), true, kind);
        }
        for (const bad of [
            'fingerprint-backup-2026-10-16T08-09-10.json.part',
            '../fingerprint-backup-2026-10-16T08-09-10.json',
            'backups/fingerprint-backup-2026-10-16T08-09-10.json',
            'fingerprint-other-2026-10-16T08-09-10.json',
            'fingerprints-backup.json',
            'notes.txt',
            '',
            undefined,
            42,
        ]) {
            assert.equal(isBackupName(bad), false, String(bad));
        }
    });
});

describe('backup store => order and pruning', () => {
    const names = [
        'fingerprint-auto-2026-10-10T08-00-00.json',
        'fingerprint-backup-2026-10-12T08-00-00.json',
        'fingerprint-auto-2026-10-14T08-00-00.json',
        'fingerprint-prerestore-2026-10-11T08-00-00.json',
        'fingerprint-auto-2026-10-12T08-00-00.json',
        'fingerprint-auto-2026-10-13T08-00-00.json.part',
        'notes.txt',
    ];

    it('sorts the backups newest first and drops everything else', () => {
        assert.deepEqual(sortBackupsNewestFirst(names), [
            'fingerprint-auto-2026-10-14T08-00-00.json',
            'fingerprint-backup-2026-10-12T08-00-00.json',
            'fingerprint-auto-2026-10-12T08-00-00.json',
            'fingerprint-prerestore-2026-10-11T08-00-00.json',
            'fingerprint-auto-2026-10-10T08-00-00.json',
        ]);
    });

    it('prunes only the oldest automatic backups', () => {
        assert.deepEqual(selectLocalBackupsToPrune(names, 1), [
            'fingerprint-auto-2026-10-12T08-00-00.json',
            'fingerprint-auto-2026-10-10T08-00-00.json',
        ]);
        assert.deepEqual(selectLocalBackupsToPrune(names, 2), ['fingerprint-auto-2026-10-10T08-00-00.json']);
    });

    it('keeps everything for 0, a negative or a broken number', () => {
        for (const keep of [0, -1, Number.NaN, undefined, 'x']) {
            assert.deepEqual(selectLocalBackupsToPrune(names, keep), [], String(keep));
        }
    });
});

describe('backup store => content check', () => {
    const good = JSON.stringify([
        { id: 1, name: 'Alice', size: 1536, template: 'AAAA' },
        { id: 7, name: 'Bob', size: 1536, template: 'BBBB' },
    ]);

    it('accepts a valid backup (string or Buffer)', () => {
        assert.deepEqual(validateBackupContent(good), { ok: true, count: 2, json: good, message: '2 finger(s)' });
        assert.equal(validateBackupContent(Buffer.from(good)).ok, true);
    });

    it('refuses broken content with a reason', () => {
        const cases = [
            ['{', 'not valid JSON'],
            ['{"id":1}', 'does not contain a list'],
            ['[]', 'contains no fingerprints'],
            ['[{"id":0,"template":"A"}]', 'no valid finger id'],
            ['[{"id":201,"template":"A"}]', 'no valid finger id'],
            ['[{"id":"3","template":"A"}]', 'no valid finger id'],
            ['[{"id":3,"template":"A"},{"id":3,"template":"B"}]', 'appears twice'],
            ['[{"id":3}]', 'has no template'],
        ];
        for (const [content, reason] of cases) {
            const result = validateBackupContent(content);
            assert.equal(result.ok, false, content);
            assert.ok(result.message.includes(reason), `${content}: ${result.message}`);
        }
    });
});

describe('backup store => label', () => {
    it('shows time, kind and size', () => {
        assert.equal(
            backupLabel('fingerprint-auto-2026-10-16T08-09-10.json', 12_800),
            '2026-10-16 08:09:10 UTC · automatic · 13 kB',
        );
        assert.equal(
            backupLabel('fingerprint-prerestore-2026-10-16T08-09-10.json'),
            '2026-10-16 08:09:10 UTC · before restore',
        );
        assert.equal(backupLabel('other.json'), 'other.json');
    });
});
