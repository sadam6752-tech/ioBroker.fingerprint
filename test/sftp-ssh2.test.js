'use strict';

/**
 * The real SSH/SFTP connection against a small SFTP server inside the test (ssh2 server side), so
 * the connector is exercised end to end: login, host key check, directories, upload, rename,
 * listing, delete. Ported from ioBroker.e-invoices.
 */

const assert = require('node:assert/strict');
const { copyBackupToRemote, testRemoteConnection } = require('../lib/remote-backup');
const { connectSsh2 } = require('../lib/sftp-ssh2');
const { startServer } = require('./helpers/sftp-server');

// the tests use the timers of Node.js; the adapter hands in its own
const timers = {
    start: (callback, ms) => globalThis.setTimeout(callback, ms),
    stop: handle => globalThis.clearTimeout(handle),
};
const quiet = { info: () => undefined, warn: () => undefined };

describe('sftp-ssh2 => against a real SFTP server', function () {
    this.timeout(30000);

    const DIR = '/backups/fingerprint';
    const settings = (port, extra = {}) => ({
        enabled: true,
        host: '127.0.0.1',
        port,
        username: 'backup',
        password: 'secret',
        directory: DIR,
        ...extra,
    });
    // a backup of 200 fingers has about 600 kB; several SFTP chunks are needed
    const backup = { name: 'fingerprint-auto-2026-10-12T08-00-00.json', data: Buffer.alloc(200_000, 7) };

    let disk;
    let server;
    beforeEach(async () => {
        disk = { files: new Map(), directories: new Set(['/']) };
        server = await startServer(disk);
    });
    afterEach(() => server.close());

    it('copies a backup of several chunks, creating the directories', async () => {
        const result = await copyBackupToRemote(connectSsh2, settings(server.port), backup, quiet, timers);
        assert.equal(result.ok, true, result.message);
        assert.equal(result.remoteFile, `${DIR}/fingerprint-auto-2026-10-12T08-00-00.json`);
        assert.ok(disk.files.get(result.remoteFile).equals(backup.data));
        assert.ok(disk.directories.has(DIR));
        assert.equal(
            [...disk.files.keys()].some(path => path.endsWith('.part')),
            false,
        );
    });

    it('accepts the right fingerprint and refuses another one before the password is used', async () => {
        const right = await copyBackupToRemote(
            connectSsh2,
            settings(server.port, { hostKey: server.fingerprint }),
            backup,
            quiet,
            timers,
        );
        assert.equal(right.ok, true, right.message);

        const wrong = await copyBackupToRemote(
            connectSsh2,
            settings(server.port, { hostKey: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
            backup,
            quiet,
            timers,
        );
        assert.equal(wrong.ok, false);
        assert.ok(wrong.message.includes('does not match'));
        assert.ok(wrong.message.includes(server.fingerprint));
    });

    it('reports a wrong password', async () => {
        const result = await copyBackupToRemote(
            connectSsh2,
            settings(server.port, { password: 'wrong' }),
            backup,
            quiet,
            timers,
        );
        assert.equal(result.ok, false);
        assert.match(result.message, /authentication/i);
    });

    it('reports a server that is not there', async () => {
        const port = server.port;
        server.close();
        const result = await copyBackupToRemote(connectSsh2, settings(port), backup, quiet, timers);
        assert.equal(result.ok, false);
    });

    it('tidies up the old automatic copies and leaves the rest', async () => {
        for (const name of [
            'fingerprint-auto-2026-10-09T08-00-00.json',
            'fingerprint-auto-2026-10-10T08-00-00.json',
            'other.txt',
        ]) {
            disk.files.set(`${DIR}/${name}`, Buffer.from('x'));
        }
        disk.directories.add('/backups');
        disk.directories.add(DIR);
        const result = await copyBackupToRemote(connectSsh2, settings(server.port, { keep: 2 }), backup, quiet, timers);
        assert.equal(result.ok, true, result.message);
        assert.deepEqual(result.deleted, ['fingerprint-auto-2026-10-09T08-00-00.json']);
        assert.ok(disk.files.has(`${DIR}/other.txt`));
    });

    it('removes the half file of an interrupted earlier upload', async () => {
        disk.directories.add('/backups');
        disk.directories.add(DIR);
        disk.files.set(`${DIR}/fingerprint-auto-2026-10-11T08-00-00.json.part`, Buffer.from('half'));
        const result = await copyBackupToRemote(connectSsh2, settings(server.port), backup, quiet, timers);
        assert.equal(result.ok, true, result.message);
        assert.deepEqual(result.partialsRemoved, ['fingerprint-auto-2026-10-11T08-00-00.json.part']);
        assert.deepEqual([...disk.files.keys()], [`${DIR}/fingerprint-auto-2026-10-12T08-00-00.json`]);
    });

    it('tests the connection and shows the fingerprint', async () => {
        const result = await testRemoteConnection(connectSsh2, settings(server.port), timers);
        assert.equal(result.ok, true, result.message);
        assert.equal(result.fingerprint, server.fingerprint);
        assert.deepEqual([...disk.files.keys()], []);
    });
});
