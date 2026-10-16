'use strict';

/**
 * The real SFTP connection for `remote-backup.js`, made with the `ssh2` library (pure JavaScript,
 * no subprocess, no mount). Ported from ioBroker.e-invoices.
 */

const { Client } = require('ssh2');
const { hexToFingerprint, hostKeyMatches } = require('./remote-backup');

/** Longest time the server may take to answer the SSH handshake. */
const READY_TIMEOUT_MS = 20_000;

/**
 * Calls an SFTP method that reports through a node-style callback.
 *
 * @param {(done: (error: Error|null|undefined, value?: T) => void) => void} run the call
 * @returns {Promise<T>} the value
 * @template T
 */
function call(run) {
    return new Promise((resolve, reject) => {
        run((error, value) => (error ? reject(error) : resolve(value)));
    });
}

/**
 * The session on top of an opened SFTP channel.
 *
 * @param {import('ssh2').Client} client SSH client
 * @param {import('ssh2').SFTPWrapper} sftp SFTP channel
 * @returns {object} session
 */
function sessionOf(client, sftp) {
    return {
        async makeDirectories(directory) {
            const absolute = directory.startsWith('/');
            let current = absolute ? '' : '.';
            for (const part of directory.split('/').filter(Boolean)) {
                current = current === '.' ? part : `${current}/${part}`;
                const path = absolute && !current.startsWith('/') ? `/${current}` : current;
                try {
                    await call(done => sftp.stat(path, done));
                } catch {
                    // missing: create it (a failure here is a real one, e.g. no permission)
                    await call(done => sftp.mkdir(path, done));
                }
            }
        },
        writeFile: (path, data) => call(done => sftp.writeFile(path, data, done)),
        size: async path => (await call(done => sftp.stat(path, done))).size,
        rename: (from, to) => call(done => sftp.rename(from, to, done)),
        list: async directory => (await call(done => sftp.readdir(directory, done))).map(entry => entry.filename),
        remove: path => call(done => sftp.unlink(path, done)),
        readFile: path => call(done => sftp.readFile(path, done)),
        close: () => {
            client.end();
        },
    };
}

/**
 * Connects to an SFTP server with user name and password.
 *
 * A fingerprint entered in the settings is checked while the connection is made: a different
 * server is refused before the password is sent.
 *
 * @param {{host: string, port: number, username: string, password: string, hostKey: string,
 *     onHostKey: (fingerprint: string) => void}} settings server, login and the expected host key
 * @returns {Promise<object>} the open session
 */
const connectSsh2 = settings =>
    new Promise((resolve, reject) => {
        const client = new Client();
        let refused;
        client.on('ready', () => {
            client.sftp((error, sftp) => {
                if (error) {
                    client.end();
                    reject(error);
                    return;
                }
                resolve(sessionOf(client, sftp));
            });
        });
        client.on('error', error => {
            reject(refused ?? error);
        });
        client.on('close', () => {
            reject(refused ?? new Error('the server closed the connection'));
        });
        client.connect({
            host: settings.host,
            port: settings.port,
            username: settings.username,
            password: settings.password,
            readyTimeout: READY_TIMEOUT_MS,
            keepaliveInterval: 15_000,
            hostHash: 'sha256',
            hostVerifier: hash => {
                settings.onHostKey(hexToFingerprint(hash));
                if (hostKeyMatches(settings.hostKey, hash)) {
                    return true;
                }
                refused = new Error(
                    `the host key of the server does not match the fingerprint in the settings (the server shows ${hexToFingerprint(hash)})`,
                );
                return false;
            },
        });
    });

module.exports = { connectSsh2 };
