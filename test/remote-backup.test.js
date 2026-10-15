'use strict';

const assert = require('node:assert/strict');
const {
    copyBackupToRemote,
    hexToFingerprint,
    hostKeyMatches,
    normalizeRemoteDirectory,
    remoteBackupName,
    remoteSettingsProblems,
    selectRemoteCopiesToPrune,
    selectStalePartials,
    settingsForConnectionTest,
    testRemoteConnection,
} = require('../lib/remote-backup');

const DIR = '/backups/fingerprint';
const settings = {
    enabled: true,
    host: 'nas.local',
    port: 22,
    username: 'backup',
    password: 'secret',
    directory: DIR,
    keep: 0,
};

/**
 * An SFTP server in memory: every path is a key, a directory is a path in `directories`.
 *
 * @param {object} [options] failure switches
 * @param {boolean} [options.failWrite] writeFile throws
 * @param {boolean} [options.shortWrite] writeFile stores only one byte
 * @param {string} [options.failRemove] remove throws for paths ending with this text
 * @returns {object} files, directories, connects, closed and the connector
 */
function fakeServer(options = {}) {
    const files = new Map();
    const directories = new Set();
    const connects = [];
    const closed = { count: 0 };
    const session = {
        makeDirectories: async directory => {
            let current = '';
            for (const part of directory.split('/').filter(Boolean)) {
                current += `/${part}`;
                directories.add(current);
            }
        },
        writeFile: async (path, data) => {
            if (options.failWrite) {
                throw new Error('Permission denied');
            }
            files.set(path, options.shortWrite ? data.subarray(0, 1) : data);
        },
        size: async path => {
            const file = files.get(path);
            if (!file) {
                throw new Error('No such file');
            }
            return file.length;
        },
        rename: async (from, to) => {
            files.set(to, files.get(from));
            files.delete(from);
        },
        list: async directory =>
            [...files.keys()]
                .filter(path => path.startsWith(`${directory}/`))
                .map(path => path.slice(directory.length + 1)),
        remove: async path => {
            if (options.failRemove && path.endsWith(options.failRemove)) {
                throw new Error('Permission denied');
            }
            files.delete(path);
        },
        close: () => {
            closed.count++;
        },
    };
    const connect = async connection => {
        connects.push(connection);
        connection.onHostKey('SHA256:abc');
        return session;
    };
    return { files, directories, connects, closed, connect };
}

// the tests use the timers of Node.js; the adapter hands in its own
const timers = {
    start: (callback, ms) => globalThis.setTimeout(callback, ms),
    stop: handle => globalThis.clearTimeout(handle),
};
const quiet = { info: () => undefined, warn: () => undefined };
const backup = { name: 'fingerprint-auto-2026-10-12T08-00-00.json', data: Buffer.from('[{"id":1}]') };
const names = server => [...server.files.keys()].map(path => path.slice(DIR.length + 1)).sort();

describe('remote backup => names and settings', () => {
    it('builds the file name with the time stamp', () => {
        const date = new Date('2026-10-15T08:09:10.123Z');
        assert.equal(remoteBackupName('auto', date), 'fingerprint-auto-2026-10-15T08-09-10.json');
        assert.equal(remoteBackupName('manual', date), 'fingerprint-backup-2026-10-15T08-09-10.json');
    });

    it('normalizes the directory and refuses ..', () => {
        assert.equal(normalizeRemoteDirectory('/backups//fingerprint/'), '/backups/fingerprint');
        assert.equal(normalizeRemoteDirectory('backups\\fingerprint'), 'backups/fingerprint');
        assert.equal(normalizeRemoteDirectory('/'), '/');
        assert.equal(normalizeRemoteDirectory(''), '');
        assert.equal(normalizeRemoteDirectory('/backups/../etc'), null);
    });

    it('names what is missing', () => {
        assert.deepEqual(remoteSettingsProblems(settings), []);
        assert.equal(remoteSettingsProblems({ enabled: true }).length, 3);
        assert.deepEqual(remoteSettingsProblems({ ...settings, port: 70000 }), [
            'the port must be between 1 and 65535',
        ]);
        assert.deepEqual(remoteSettingsProblems({ ...settings, directory: '../x' }), [
            'the directory must not contain ".."',
        ]);
        // no port entered = 22
        assert.deepEqual(remoteSettingsProblems({ ...settings, port: undefined }), []);
    });
});

describe('remote backup => host key', () => {
    const hex = '0f'.repeat(32);
    const fingerprint = hexToFingerprint(hex);

    it('writes the fingerprint like OpenSSH', () => {
        assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
    });

    it('accepts the matching key in every notation and nothing else', () => {
        assert.equal(hostKeyMatches('', hex), true);
        assert.equal(hostKeyMatches(fingerprint, hex), true);
        assert.equal(hostKeyMatches(fingerprint.replace('SHA256:', ''), hex), true);
        assert.equal(hostKeyMatches(hex, hex), true);
        assert.equal(hostKeyMatches(hex.replace(/(..)/g, '$1:').slice(0, -1).toUpperCase(), hex), true);
        assert.equal(hostKeyMatches(hexToFingerprint('1e'.repeat(32)), hex), false);
        assert.equal(hostKeyMatches('1e'.repeat(32), hex), false);
        assert.equal(hostKeyMatches('nonsense', hex), false);
    });
});

describe('remote backup => keeping the copies', () => {
    const list = [
        'fingerprint-auto-2026-10-10T08-00-00.json',
        'fingerprint-auto-2026-10-12T08-00-00.json',
        'fingerprint-auto-2026-10-11T08-00-00.json',
        'fingerprint-backup-2026-10-01T08-00-00.json',
        'notes.txt',
    ];

    it('picks the oldest automatic copies and nothing else', () => {
        assert.deepEqual(selectRemoteCopiesToPrune(list, 2), ['fingerprint-auto-2026-10-10T08-00-00.json']);
        assert.deepEqual(selectRemoteCopiesToPrune(list, 1), [
            'fingerprint-auto-2026-10-11T08-00-00.json',
            'fingerprint-auto-2026-10-10T08-00-00.json',
        ]);
    });

    it('keeps everything for 0 or a broken number', () => {
        assert.deepEqual(selectRemoteCopiesToPrune(list, 0), []);
        assert.deepEqual(selectRemoteCopiesToPrune(list, Number.NaN), []);
        assert.deepEqual(selectRemoteCopiesToPrune(list, -3), []);
    });
});

describe('remote backup => copy', () => {
    it('writes the file under its final name and creates the directory', async () => {
        const server = fakeServer();
        const result = await copyBackupToRemote(server.connect, settings, backup, quiet, timers);
        assert.equal(result.ok, true);
        assert.equal(result.remoteFile, `${DIR}/fingerprint-auto-2026-10-12T08-00-00.json`);
        assert.ok(server.files.get(result.remoteFile).equals(backup.data));
        assert.equal(
            [...server.files.keys()].some(path => path.endsWith('.part')),
            false,
        );
        assert.ok(server.directories.has(DIR));
        assert.ok(server.closed.count > 0);
    });

    it('passes the login and trims host and user', async () => {
        const server = fakeServer();
        await copyBackupToRemote(
            server.connect,
            { ...settings, host: ' nas.local ', port: undefined },
            backup,
            quiet,
            timers,
        );
        const { host, port, username, password } = server.connects[0];
        assert.deepEqual(
            { host, port, username, password },
            {
                host: 'nas.local',
                port: 22,
                username: 'backup',
                password: 'secret',
            },
        );
    });

    it('warns about the missing fingerprint, with the fingerprint, and is quiet with one', async () => {
        const warnings = [];
        await copyBackupToRemote(
            fakeServer().connect,
            settings,
            backup,
            { ...quiet, warn: m => warnings.push(m) },
            timers,
        );
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].includes('SHA256:abc'));
        const quietWarnings = [];
        await copyBackupToRemote(
            fakeServer().connect,
            { ...settings, hostKey: 'SHA256:abc' },
            backup,
            { ...quiet, warn: m => quietWarnings.push(m) },
            timers,
        );
        assert.deepEqual(quietWarnings, []);
    });

    it('reports a failed upload and leaves nothing under the final name', async () => {
        const server = fakeServer({ failWrite: true });
        const result = await copyBackupToRemote(server.connect, settings, backup, quiet, timers);
        assert.equal(result.ok, false);
        assert.ok(result.message.includes('Permission denied'));
        assert.equal(server.files.size, 0);
        assert.ok(server.closed.count > 0);
    });

    it('refuses an upload of the wrong size and does not rename it', async () => {
        const server = fakeServer({ shortWrite: true });
        const result = await copyBackupToRemote(server.connect, settings, backup, quiet, timers);
        assert.equal(result.ok, false);
        assert.ok(result.message.includes('incomplete'));
        assert.equal(server.files.size, 0);
    });

    it('does not even connect with incomplete settings', async () => {
        const server = fakeServer();
        const result = await copyBackupToRemote(server.connect, { enabled: true }, backup, quiet, timers);
        assert.equal(result.ok, false);
        assert.ok(result.message.includes('settings incomplete'));
        assert.equal(server.connects.length, 0);
    });

    it('turns a connection error into a result', async () => {
        const result = await copyBackupToRemote(
            async () => {
                throw new Error('All configured authentication methods failed');
            },
            settings,
            backup,
            quiet,
            timers,
        );
        assert.equal(result.ok, false);
        assert.equal(result.message, 'All configured authentication methods failed');
    });

    it('gives up on a server that never answers and closes the connection', async () => {
        const closed = { count: 0 };
        const hanging = async () => ({
            makeDirectories: () => new Promise(() => undefined),
            writeFile: async () => undefined,
            size: async () => 0,
            rename: async () => undefined,
            list: async () => [],
            remove: async () => undefined,
            close: () => {
                closed.count++;
            },
        });
        const result = await copyBackupToRemote(hanging, settings, backup, quiet, timers, 50);
        assert.equal(result.ok, false);
        assert.ok(result.message.includes('took longer'));
        assert.ok(closed.count > 0);
    });

    it('deletes old automatic copies when asked and only those', async () => {
        const server = fakeServer();
        for (const name of [
            'fingerprint-auto-2026-10-09T08-00-00.json',
            'fingerprint-auto-2026-10-10T08-00-00.json',
            'fingerprint-auto-2026-10-11T08-00-00.json',
            'fingerprint-backup-2026-09-01T08-00-00.json',
            'foreign.txt',
        ]) {
            server.files.set(`${DIR}/${name}`, Buffer.from('x'));
        }
        const result = await copyBackupToRemote(server.connect, { ...settings, keep: 2 }, backup, quiet, timers);
        assert.equal(result.ok, true);
        assert.deepEqual(result.deleted, [
            'fingerprint-auto-2026-10-10T08-00-00.json',
            'fingerprint-auto-2026-10-09T08-00-00.json',
        ]);
        assert.deepEqual(names(server), [
            'fingerprint-auto-2026-10-11T08-00-00.json',
            'fingerprint-auto-2026-10-12T08-00-00.json',
            'fingerprint-backup-2026-09-01T08-00-00.json',
            'foreign.txt',
        ]);
    });

    it('does not tidy up after a backup made by hand', async () => {
        const server = fakeServer();
        server.files.set(`${DIR}/fingerprint-auto-2026-10-09T08-00-00.json`, Buffer.from('x'));
        const result = await copyBackupToRemote(
            server.connect,
            { ...settings, keep: 1 },
            { name: 'fingerprint-backup-2026-10-12T08-00-00.json', data: backup.data },
            quiet,
            timers,
        );
        assert.equal(result.ok, true);
        assert.deepEqual(result.deleted, []);
    });

    it('keeps the copy and reports ok when an old copy cannot be deleted', async () => {
        const warnings = [];
        const server = fakeServer({ failRemove: '2026-10-09T08-00-00.json' });
        server.files.set(`${DIR}/fingerprint-auto-2026-10-09T08-00-00.json`, Buffer.from('x'));
        const result = await copyBackupToRemote(
            server.connect,
            { ...settings, keep: 1 },
            backup,
            { ...quiet, warn: m => warnings.push(m) },
            timers,
        );
        assert.equal(result.ok, true);
        assert.ok(warnings.join(' ').includes('Cannot delete the old copy'));
    });

    it('works in the root directory', async () => {
        const server = fakeServer();
        const result = await copyBackupToRemote(server.connect, { ...settings, directory: '/' }, backup, quiet, timers);
        assert.equal(result.remoteFile, '/fingerprint-auto-2026-10-12T08-00-00.json');
    });
});

describe('remote backup => interrupted uploads', () => {
    it('picks only the half files of this adapter', () => {
        assert.deepEqual(
            selectStalePartials([
                'fingerprint-auto-2026-10-11T08-00-00.json.part',
                'fingerprint-backup-2026-10-11T08-00-00.json.part',
                'fingerprint-auto-2026-10-11T08-00-00.json',
                'holiday.json.part',
                'notes.part',
            ]),
            ['fingerprint-auto-2026-10-11T08-00-00.json.part', 'fingerprint-backup-2026-10-11T08-00-00.json.part'],
        );
    });

    it('removes the leftovers of earlier interrupted uploads after a good copy, and nothing else', async () => {
        const server = fakeServer();
        for (const name of [
            'fingerprint-auto-2026-10-10T08-00-00.json.part',
            'fingerprint-backup-2026-10-09T08-00-00.json.part',
            'fingerprint-auto-2026-10-10T07-00-00.json',
            'holiday.json.part',
        ]) {
            server.files.set(`${DIR}/${name}`, Buffer.from('x'));
        }
        const result = await copyBackupToRemote(server.connect, settings, backup, quiet, timers);
        assert.equal(result.ok, true);
        assert.deepEqual(result.partialsRemoved.sort(), [
            'fingerprint-auto-2026-10-10T08-00-00.json.part',
            'fingerprint-backup-2026-10-09T08-00-00.json.part',
        ]);
        assert.deepEqual(names(server), [
            'fingerprint-auto-2026-10-10T07-00-00.json',
            'fingerprint-auto-2026-10-12T08-00-00.json',
            'holiday.json.part',
        ]);
    });

    it('keeps the copy ok when a leftover cannot be deleted', async () => {
        const warnings = [];
        const server = fakeServer({ failRemove: '.json.part' });
        server.files.set(`${DIR}/fingerprint-auto-2026-10-10T08-00-00.json.part`, Buffer.from('x'));
        const result = await copyBackupToRemote(
            server.connect,
            settings,
            backup,
            { ...quiet, warn: m => warnings.push(m) },
            timers,
        );
        assert.equal(result.ok, true);
        assert.ok(warnings.join(' ').includes('Cannot delete the interrupted upload'));
    });
});

describe('remote backup => late connection after the time limit', () => {
    it('closes a connection that arrives after the limit and writes nothing', async () => {
        const server = fakeServer();
        let release = () => undefined;
        const slow = async connection => {
            // the server answers only after the copy has given up
            await new Promise(resolve => {
                release = resolve;
            });
            return server.connect(connection);
        };
        const result = await copyBackupToRemote(slow, settings, backup, quiet, timers, 20);
        assert.equal(result.ok, false);
        assert.ok(result.message.includes('took longer'));
        release();
        await new Promise(resolve => globalThis.setTimeout(resolve, 20));
        assert.equal(server.files.size, 0);
        assert.ok(server.closed.count > 0);
    });
});

describe('remote backup => settings of the connection test', () => {
    const saved = { ...settings, hostKey: 'SHA256:saved' };

    it('takes the values of the form, also unsaved ones', () => {
        const test = settingsForConnectionTest(
            {
                remoteHost: 'other.local',
                remoteUser: 'u',
                remotePassword: 'typed',
                remotePort: 2222,
                remoteDirectory: '/x',
            },
            saved,
        );
        const { host, username, password, port, directory } = test;
        assert.deepEqual(
            { host, username, password, port, directory },
            { host: 'other.local', username: 'u', password: 'typed', port: 2222, directory: '/x' },
        );
    });

    it('uses the saved password for the saved server when the field is empty', () => {
        const test = settingsForConnectionTest(
            { remoteHost: 'nas.local', remoteUser: 'backup', remotePassword: '' },
            saved,
        );
        assert.equal(test.password, 'secret');
        assert.equal(settingsForConnectionTest({}, saved).password, 'secret');
    });

    it('never sends the saved password to another server, user or port', () => {
        assert.equal(settingsForConnectionTest({ remoteHost: 'evil.example' }, saved).password, undefined);
        assert.equal(settingsForConnectionTest({ remoteUser: 'root' }, saved).password, undefined);
        assert.equal(settingsForConnectionTest({ remotePort: 2200 }, saved).password, undefined);
        // without a password the test stops before it connects
        assert.ok(
            remoteSettingsProblems(settingsForConnectionTest({ remoteHost: 'evil.example' }, saved)).includes(
                'the password is missing',
            ),
        );
    });
});

describe('remote backup => connection test', () => {
    it('writes and deletes a small test file and reports the fingerprint', async () => {
        const server = fakeServer();
        const result = await testRemoteConnection(server.connect, settings, timers);
        assert.equal(result.ok, true);
        assert.equal(result.fingerprint, 'SHA256:abc');
        assert.equal(server.files.size, 0);
        assert.ok(server.directories.has(DIR));
    });

    it('says why it failed', async () => {
        const result = await testRemoteConnection(fakeServer({ failWrite: true }).connect, settings, timers);
        assert.equal(result.ok, false);
        assert.ok(result.message.includes('Permission denied'));
        const incomplete = await testRemoteConnection(fakeServer().connect, { enabled: true }, timers);
        assert.ok(incomplete.message.includes('settings incomplete'));
    });
});
