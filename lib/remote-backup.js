'use strict';

/**
 * Copy of the fingerprint backups to an external server over SFTP.
 *
 * The adapter keeps its backup on the ioBroker host. A copy on another machine (a NAS, a root
 * server) survives the loss of that host. The copy is made with the SFTP protocol itself — no
 * mount, no `sudo`, no shell command: the adapter opens an SSH connection, writes the file and
 * closes it again.
 *
 * What is guaranteed:
 * - the local backup is never touched, a failed copy is reported and nothing else happens;
 * - a copy appears under its final name only when it is complete (upload as `.part`, then
 *   rename) and has the size of the original;
 * - old copies are only deleted when asked for, and only the automatic backups of this adapter.
 *
 * This file holds the logic and works against the small `SftpSession` interface, so it is tested
 * without a server. The real connection is in `sftp-ssh2.js`. Ported from ioBroker.e-invoices.
 */

/*
 * Shapes used in this file (plain objects):
 *
 * - settings of the copy: `enabled`, `host`, `port` (22 when empty), `username`, `password`,
 *   `directory` (e.g. `/backups/fingerprint`), `hostKey` (`SHA256:…` or hex, empty = not
 *   verified), `keep` (automatic copies kept on the server, 0 = keep all);
 * - session: one open SFTP connection with `makeDirectories(dir)`, `writeFile(path, data)`,
 *   `size(path)`, `rename(from, to)`, `list(dir)` (file names), `remove(path)`, `readFile(path)`
 *   (Buffer), `close()`;
 * - connector: `connect({host, port, username, password, hostKey, onHostKey})` → session;
 *   `onHostKey` hears the fingerprint of the server (`SHA256:…`);
 * - timers: the adapter's `start(callback, ms)` / `stop(handle)`, so a pending timeout ends with
 *   the adapter.
 */

const { isBackupName, sortBackupsNewestFirst } = require('./backup-store');

/** Default SSH port. */
const DEFAULT_PORT = 22;

/** The whole copy (connect, upload, check, tidy) must not take longer than this. */
const REMOTE_COPY_TIMEOUT_MS = 10 * 60_000;

/** Name of the automatic backups: `fingerprint-auto-2026-10-15T08-00-00.json`. */
const AUTO_PREFIX = 'fingerprint-auto-';

/** Name of the backups made by hand: `fingerprint-backup-2026-10-15T08-00-00.json`. */
const MANUAL_PREFIX = 'fingerprint-backup-';

/** Ending of a backup file. */
const EXTENSION = '.json';

/** Ending of a file while it is being uploaded. */
const PARTIAL_SUFFIX = '.part';

/**
 * File name of a backup on the server, with the time stamp in the name (the alphabetical order
 * is the age).
 *
 * @param {'auto'|'manual'} kind automatic or made by hand
 * @param {Date} [date] time of the backup
 * @returns {string} e.g. `fingerprint-auto-2026-10-15T08-00-00.json`
 */
function remoteBackupName(kind, date = new Date()) {
    const stamp = date.toISOString().slice(0, 19).replace(/:/g, '-');
    return `${kind === 'auto' ? AUTO_PREFIX : MANUAL_PREFIX}${stamp}${EXTENSION}`;
}

/**
 * Normalizes the target directory: forward slashes, no trailing slash, no `.` or empty segments.
 *
 * @param {string|undefined} directory directory as typed by the user
 * @returns {string|null} the directory, `/` or a path; null when it holds a `..` segment
 */
function normalizeRemoteDirectory(directory) {
    const text = String(directory ?? '')
        .trim()
        .replace(/\\/g, '/');
    const absolute = text.startsWith('/');
    const parts = [];
    for (const part of text.split('/')) {
        if (part === '' || part === '.') {
            continue;
        }
        if (part === '..') {
            return null;
        }
        parts.push(part);
    }
    const joined = parts.join('/');
    return absolute ? `/${joined}` : joined;
}

/**
 * Names what is wrong with the settings, so the operator sees it before a copy fails.
 *
 * @param {object} settings instance settings of the copy
 * @returns {string[]} one text per problem, empty when the copy can be tried
 */
function remoteSettingsProblems(settings) {
    const problems = [];
    if (!String(settings.host ?? '').trim()) {
        problems.push('the host is missing');
    }
    if (!String(settings.username ?? '').trim()) {
        problems.push('the user name is missing');
    }
    if (!settings.password) {
        problems.push('the password is missing');
    }
    const port = settings.port === undefined || settings.port === 0 ? DEFAULT_PORT : Number(settings.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        problems.push('the port must be between 1 and 65535');
    }
    if (normalizeRemoteDirectory(settings.directory) === null) {
        problems.push('the directory must not contain ".."');
    }
    return problems;
}

/**
 * Writes a hex digest the way OpenSSH and the Synology show it: `SHA256:` and base64 without padding.
 *
 * @param {string} hexHash SHA-256 digest as hex
 * @returns {string} `SHA256:…`
 */
function hexToFingerprint(hexHash) {
    return `SHA256:${Buffer.from(hexHash, 'hex').toString('base64').replace(/=+$/, '')}`;
}

/**
 * Checks the fingerprint of a server against the one the operator entered.
 *
 * @param {string} expected `SHA256:…` (base64, as `ssh-keygen -l` and the Synology show it) or the
 *     hex digest, with or without colons. Empty = nothing to compare.
 * @param {string} hexHash SHA-256 of the host key as a hex digest, as ssh2 delivers it
 * @returns {boolean} true when they are the same key
 */
function hostKeyMatches(expected, hexHash) {
    const wanted = String(expected ?? '').trim();
    if (!wanted) {
        return true;
    }
    const hex = hexHash.toLowerCase();
    const asHex = wanted.replace(/^sha256:/i, '').replace(/:/g, '');
    if (/^[0-9a-f]{64}$/i.test(asHex)) {
        return asHex.toLowerCase() === hex;
    }
    return wanted.replace(/^sha256:/i, '').replace(/=+$/, '') === hexToFingerprint(hex).replace(/^SHA256:/, '');
}

/**
 * Fails a promise that takes too long (a server that accepts the connection and then says nothing).
 *
 * @param {object} timers the adapter's timers
 * @param {Promise<T>} work the work
 * @param {number} ms time limit
 * @param {string} what name for the message
 * @param {() => void} onTimeout called when the time is up
 * @returns {Promise<T>} the result of the work
 * @template T
 */
async function withTimeout(timers, work, ms, what, onTimeout) {
    let timer;
    const limit = new Promise((_resolve, reject) => {
        timer = timers.start(() => {
            onTimeout();
            reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`));
        }, ms);
    });
    try {
        return await Promise.race([work, limit]);
    } finally {
        timers.stop(timer);
    }
}

/**
 * Picks the automatic copies that exceed the number to keep (the oldest ones).
 *
 * Only files with the name of an automatic backup qualify: copies of backups made by hand and
 * every other file in the directory are never touched. `keep` 0 (or less) keeps everything.
 *
 * @param {string[]} names file names in the target directory
 * @param {number} keep automatic copies to keep
 * @returns {string[]} the names to delete
 */
function selectRemoteCopiesToPrune(names, keep) {
    if (!Number.isFinite(keep) || keep <= 0) {
        return [];
    }
    const automatic = names
        .filter(name => name.startsWith(AUTO_PREFIX) && name.endsWith(EXTENSION))
        .sort()
        .reverse();
    return automatic.slice(Math.floor(keep));
}

/**
 * Picks the leftovers of interrupted uploads of this adapter (`fingerprint-auto-….json.part`,
 * `fingerprint-backup-….json.part`). Every other file in the directory is left alone.
 *
 * @param {string[]} names file names in the target directory
 * @returns {string[]} the names to delete
 */
function selectStalePartials(names) {
    return names.filter(
        name =>
            (name.startsWith(AUTO_PREFIX) || name.startsWith(MANUAL_PREFIX)) &&
            name.endsWith(`${EXTENSION}${PARTIAL_SUFFIX}`),
    );
}

/**
 * Connection data for the connector, from checked settings.
 *
 * @param {object} settings checked settings
 * @param {(fingerprint: string) => void} onHostKey hears the fingerprint of the server
 * @returns {object} connection data
 */
function connectionOf(settings, onHostKey) {
    return {
        host: String(settings.host).trim(),
        port: settings.port ? Number(settings.port) : DEFAULT_PORT,
        username: String(settings.username).trim(),
        password: String(settings.password),
        hostKey: String(settings.hostKey ?? '').trim(),
        onHostKey,
    };
}

/**
 * Copies one backup to the server.
 *
 * @param {(connection: object) => Promise<object>} connect opens the SFTP connection
 * @param {object} settings instance settings of the copy
 * @param {{name: string, data: Buffer}} backup file name on the server and the bytes
 * @param {{info: (msg: string) => void, warn: (msg: string) => void}} log logger
 * @param {object} timers the adapter's timers
 * @param {number} [limitMs] longest time for the whole copy
 * @returns {Promise<{ok: boolean, message: string, remoteFile?: string, deleted: string[],
 *     partialsRemoved: string[]}>} the result; it never throws
 */
async function copyBackupToRemote(connect, settings, backup, log, timers, limitMs = REMOTE_COPY_TIMEOUT_MS) {
    const problems = remoteSettingsProblems(settings);
    if (problems.length > 0) {
        return { ok: false, message: `settings incomplete: ${problems.join(', ')}`, deleted: [], partialsRemoved: [] };
    }
    const directory = normalizeRemoteDirectory(settings.directory) ?? '';
    const inDirectory = file => (directory === '/' ? `/${file}` : directory ? `${directory}/${file}` : file);
    const name = backup.name;
    const target = inDirectory(name);
    let session;
    let expired = false;
    const deleted = [];
    const partialsRemoved = [];
    try {
        const work = (async () => {
            const opened = await connect(
                connectionOf(settings, fingerprint => {
                    if (!String(settings.hostKey ?? '').trim()) {
                        log.warn(
                            `The host key of the external server is not verified. To trust only this server, enter its fingerprint in the settings: ${fingerprint}`,
                        );
                    }
                }),
            );
            session = opened;
            // the time ran out while connecting: close at once instead of uploading after the failure was reported
            if (expired) {
                opened.close();
                return;
            }
            if (directory) {
                await opened.makeDirectories(directory);
            }
            const partial = `${target}${PARTIAL_SUFFIX}`;
            try {
                await opened.writeFile(partial, backup.data);
                const written = await opened.size(partial);
                if (written !== backup.data.length) {
                    throw new Error(`the upload is incomplete (${written} of ${backup.data.length} bytes)`);
                }
                await opened.rename(partial, target);
            } catch (error) {
                // remove the half file while the connection still works; when it does not, the next copy does it
                if (!expired) {
                    await opened.remove(partial).catch(() => undefined);
                }
                throw error;
            }
            const names = await opened.list(directory || '.');
            for (const stale of selectStalePartials(names)) {
                try {
                    await opened.remove(inDirectory(stale));
                    partialsRemoved.push(stale);
                } catch (error) {
                    log.warn(`Cannot delete the interrupted upload ${stale} on the external server: ${error.message}`);
                }
            }
            if (name.startsWith(AUTO_PREFIX)) {
                for (const old of selectRemoteCopiesToPrune(names, Number(settings.keep ?? 0))) {
                    try {
                        await opened.remove(inDirectory(old));
                        deleted.push(old);
                    } catch (error) {
                        log.warn(`Cannot delete the old copy ${old} on the external server: ${error.message}`);
                    }
                }
            }
        })();
        await withTimeout(timers, work, limitMs, 'The copy to the external server', () => {
            expired = true;
            if (session) {
                session.close();
            }
        });
        return { ok: true, message: `copied ${name}`, remoteFile: target, deleted, partialsRemoved };
    } catch (error) {
        return { ok: false, message: error.message, deleted, partialsRemoved };
    } finally {
        if (session) {
            session.close();
        }
    }
}

/**
 * Opens a session, runs `work` on it within a time limit and always closes it again.
 *
 * @param {(connection: object) => Promise<object>} connect opens the SFTP connection
 * @param {object} settings checked settings of the copy
 * @param {object} timers the adapter's timers
 * @param {number} limitMs longest time
 * @param {string} what name for the timeout message
 * @param {(session: object, directory: string) => Promise<T>} work the work on the open session
 * @returns {Promise<T>} the result of the work; throws on failure
 * @template T
 */
async function withSession(connect, settings, timers, limitMs, what, work) {
    const directory = normalizeRemoteDirectory(settings.directory) ?? '';
    let session;
    let expired = false;
    try {
        const run = (async () => {
            const opened = await connect(connectionOf(settings, () => undefined));
            session = opened;
            if (expired) {
                opened.close();
                return undefined;
            }
            return work(opened, directory);
        })();
        return await withTimeout(timers, run, limitMs, what, () => {
            expired = true;
            if (session) {
                session.close();
            }
        });
    } finally {
        if (session) {
            session.close();
        }
    }
}

/**
 * Lists the backups of this adapter on the server, newest first. Only file names that match a
 * backup of this adapter are returned (no `.part` leftovers, no foreign files).
 *
 * @param {(connection: object) => Promise<object>} connect opens the SFTP connection
 * @param {object} settings instance settings of the copy
 * @param {object} timers the adapter's timers
 * @param {number} [limitMs] longest time
 * @returns {Promise<{ok: boolean, message: string, names: string[]}>} the result; it never throws
 */
async function listRemoteBackups(connect, settings, timers, limitMs = 60_000) {
    const problems = remoteSettingsProblems(settings);
    if (problems.length > 0) {
        return { ok: false, message: `settings incomplete: ${problems.join(', ')}`, names: [] };
    }
    try {
        const names = await withSession(
            connect,
            settings,
            timers,
            limitMs,
            'Listing the backups on the external server',
            (session, directory) => session.list(directory || '.'),
        );
        const backups = sortBackupsNewestFirst(names || []);
        return { ok: true, message: `${backups.length} backup(s) on the server`, names: backups };
    } catch (error) {
        return { ok: false, message: error.message, names: [] };
    }
}

/**
 * Downloads one backup of this adapter from the server.
 *
 * @param {(connection: object) => Promise<object>} connect opens the SFTP connection
 * @param {object} settings instance settings of the copy
 * @param {string} name file name on the server (must be a backup name of this adapter)
 * @param {object} timers the adapter's timers
 * @param {number} [limitMs] longest time
 * @returns {Promise<{ok: boolean, message: string, data?: Buffer}>} the result; it never throws
 */
async function fetchRemoteBackup(connect, settings, name, timers, limitMs = REMOTE_COPY_TIMEOUT_MS) {
    if (!isBackupName(name)) {
        return { ok: false, message: 'choose a backup of this adapter from the list' };
    }
    const problems = remoteSettingsProblems(settings);
    if (problems.length > 0) {
        return { ok: false, message: `settings incomplete: ${problems.join(', ')}` };
    }
    try {
        const data = await withSession(
            connect,
            settings,
            timers,
            limitMs,
            'The download from the external server',
            (session, directory) =>
                session.readFile(directory === '/' ? `/${name}` : directory ? `${directory}/${name}` : name),
        );
        if (!Buffer.isBuffer(data)) {
            return { ok: false, message: 'the server sent no data' };
        }
        return { ok: true, message: `downloaded ${name}`, data };
    } catch (error) {
        return { ok: false, message: error.message };
    }
}

/**
 * The settings for the connection test of the admin page, from the values of the form.
 *
 * The form may hold unsaved values. An empty password field means "the saved one" — but only for
 * the saved server, user and port: otherwise any script could send this message with its own host
 * and receive the stored password at the login (the password is protected for a reason).
 *
 * @param {Record<string, unknown>} form values of the form (`native` of the instance as the admin sends it)
 * @param {object} saved the saved instance settings
 * @returns {object} settings for the test
 */
function settingsForConnectionTest(form, saved) {
    const text = value => (typeof value === 'string' ? value : undefined);
    const host = text(form.remoteHost) ?? saved.host ?? '';
    const username = text(form.remoteUser) ?? saved.username ?? '';
    const port = Number(form.remotePort ?? saved.port) || DEFAULT_PORT;
    const sameServer =
        host.trim() === String(saved.host ?? '').trim() &&
        username.trim() === String(saved.username ?? '').trim() &&
        port === (Number(saved.port) || DEFAULT_PORT);
    return {
        enabled: true,
        host,
        port,
        username,
        password: text(form.remotePassword) || (sameServer ? saved.password : undefined),
        directory: text(form.remoteDirectory) ?? saved.directory,
        hostKey: text(form.remoteHostKey) ?? saved.hostKey,
    };
}

/**
 * Tries the connection without writing a backup: connects, makes sure the directory exists and
 * writes and deletes a small test file, so a wrong password or a directory without permission
 * shows up now and not at the first backup.
 *
 * @param {(connection: object) => Promise<object>} connect opens the SFTP connection
 * @param {object} settings instance settings of the copy
 * @param {object} timers the adapter's timers
 * @param {number} [limitMs] longest time for the test
 * @returns {Promise<{ok: boolean, message: string, fingerprint?: string}>} the result; it never throws
 */
async function testRemoteConnection(connect, settings, timers, limitMs = 60_000) {
    const problems = remoteSettingsProblems(settings);
    if (problems.length > 0) {
        return { ok: false, message: `settings incomplete: ${problems.join(', ')}` };
    }
    const directory = normalizeRemoteDirectory(settings.directory) ?? '';
    let session;
    let expired = false;
    let fingerprint;
    try {
        const work = (async () => {
            const opened = await connect(
                connectionOf(settings, found => {
                    fingerprint = found;
                }),
            );
            session = opened;
            if (expired) {
                opened.close();
                return;
            }
            if (directory) {
                await opened.makeDirectories(directory);
            }
            const probe = `${directory === '/' ? '/' : directory ? `${directory}/` : ''}.fingerprint-connection-test`;
            await opened.writeFile(probe, Buffer.from('ok'));
            await opened.remove(probe);
        })();
        await withTimeout(timers, work, limitMs, 'The connection test', () => {
            expired = true;
            if (session) {
                session.close();
            }
        });
        return { ok: true, message: 'connected, the directory is writable', fingerprint };
    } catch (error) {
        return { ok: false, message: error.message, fingerprint };
    } finally {
        if (session) {
            session.close();
        }
    }
}

module.exports = {
    AUTO_PREFIX,
    MANUAL_PREFIX,
    REMOTE_COPY_TIMEOUT_MS,
    remoteBackupName,
    normalizeRemoteDirectory,
    remoteSettingsProblems,
    hexToFingerprint,
    hostKeyMatches,
    selectRemoteCopiesToPrune,
    selectStalePartials,
    copyBackupToRemote,
    settingsForConnectionTest,
    testRemoteConnection,
    listRemoteBackups,
    fetchRemoteBackup,
};
