'use strict';

/**
 * A small SFTP server for tests (ssh2 server side, files in memory). Used by the unit test of the
 * connector and by the integration test of the adapter.
 */

const { createHash } = require('node:crypto');
const { Server, utils } = require('ssh2');

const { STATUS_CODE, OPEN_MODE } = utils.sftp;

/**
 * Starts an SFTP server on a free port; `fingerprint` is its host key as OpenSSH shows it.
 *
 * @param {{files: Map<string, Buffer>, directories: Set<string>}} disk what the in-memory server holds
 * @param {{username: string, password: string}} [login] accepted login
 * @returns {Promise<{port: number, fingerprint: string, close: () => void}>} the running server
 */
async function startServer(disk, login = { username: 'backup', password: 'secret' }) {
    const keys = utils.generateKeyPairSync('ed25519');
    const parsed = utils.parseKey(keys.public);
    const publicBlob = (Array.isArray(parsed) ? parsed[0] : parsed).getPublicSSH();
    const fingerprint = `SHA256:${createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '')}`;
    const clients = new Set();

    const server = new Server({ hostKeys: [keys.private] }, client => {
        clients.add(client);
        client.on('close', () => clients.delete(client));
        client.on('authentication', context => {
            if (
                context.method === 'password' &&
                context.username === login.username &&
                context.password === login.password
            ) {
                context.accept();
            } else {
                context.reject(['password']);
            }
        });
        client.on('error', () => undefined);
        client.on('ready', () => {
            client.on('session', accept => {
                const session = accept();
                session.on('sftp', acceptSftp => {
                    const sftp = acceptSftp();
                    const handles = new Map();
                    let next = 1;
                    const open = (path, kind) => {
                        const id = next++;
                        handles.set(id, { path, kind });
                        const handle = Buffer.alloc(4);
                        handle.writeUInt32BE(id);
                        return handle;
                    };
                    const of = handle => handles.get(handle.readUInt32BE(0));
                    const attrsOf = path => {
                        const stamp = Math.floor(Date.now() / 1000);
                        const file = disk.files.get(path);
                        if (file) {
                            return { mode: 0o100644, size: file.length, uid: 0, gid: 0, atime: stamp, mtime: stamp };
                        }
                        if (disk.directories.has(path)) {
                            return { mode: 0o040755, size: 0, uid: 0, gid: 0, atime: stamp, mtime: stamp };
                        }
                        return null;
                    };
                    const ok = id => sftp.status(id, STATUS_CODE.OK);
                    const missing = id => sftp.status(id, STATUS_CODE.NO_SUCH_FILE);

                    sftp.on('REALPATH', (id, path) => {
                        sftp.name(id, [{ filename: path, longname: path, attrs: {} }]);
                    });
                    sftp.on('OPEN', (id, path, flags) => {
                        if (flags & OPEN_MODE.WRITE) {
                            disk.files.set(path, Buffer.alloc(0));
                        } else if (!disk.files.has(path)) {
                            missing(id);
                            return;
                        }
                        sftp.handle(id, open(path, 'file'));
                    });
                    sftp.on('READ', (id, handle, offset, length) => {
                        const entry = of(handle);
                        const file = entry && disk.files.get(entry.path);
                        if (!file) {
                            sftp.status(id, STATUS_CODE.FAILURE);
                            return;
                        }
                        if (offset >= file.length) {
                            sftp.status(id, STATUS_CODE.EOF);
                            return;
                        }
                        sftp.data(id, file.subarray(offset, offset + length));
                    });
                    sftp.on('WRITE', (id, handle, offset, data) => {
                        const entry = of(handle);
                        if (!entry) {
                            sftp.status(id, STATUS_CODE.FAILURE);
                            return;
                        }
                        const old = disk.files.get(entry.path) ?? Buffer.alloc(0);
                        const grown = Buffer.alloc(Math.max(old.length, offset + data.length));
                        old.copy(grown);
                        data.copy(grown, offset);
                        disk.files.set(entry.path, grown);
                        ok(id);
                    });
                    sftp.on('CLOSE', (id, handle) => {
                        handles.delete(handle.readUInt32BE(0));
                        ok(id);
                    });
                    const stat = (id, path) => {
                        const attrs = attrsOf(path);
                        if (attrs) {
                            sftp.attrs(id, attrs);
                        } else {
                            missing(id);
                        }
                    };
                    sftp.on('STAT', stat);
                    sftp.on('LSTAT', stat);
                    sftp.on('FSTAT', (id, handle) => {
                        const entry = of(handle);
                        if (entry) {
                            stat(id, entry.path);
                        } else {
                            missing(id);
                        }
                    });
                    sftp.on('MKDIR', (id, path) => {
                        if (disk.directories.has(path) || disk.files.has(path)) {
                            sftp.status(id, STATUS_CODE.FAILURE);
                            return;
                        }
                        disk.directories.add(path);
                        ok(id);
                    });
                    sftp.on('RENAME', (id, from, to) => {
                        const file = disk.files.get(from);
                        if (!file) {
                            missing(id);
                            return;
                        }
                        disk.files.set(to, file);
                        disk.files.delete(from);
                        ok(id);
                    });
                    sftp.on('REMOVE', (id, path) => {
                        if (disk.files.delete(path)) {
                            ok(id);
                        } else {
                            missing(id);
                        }
                    });
                    sftp.on('OPENDIR', (id, path) => {
                        if (disk.directories.has(path)) {
                            sftp.handle(id, open(path, 'dir'));
                        } else {
                            missing(id);
                        }
                    });
                    sftp.on('READDIR', (id, handle) => {
                        const entry = of(handle);
                        if (!entry || entry.listed) {
                            sftp.status(id, STATUS_CODE.EOF);
                            return;
                        }
                        entry.listed = true;
                        const found = [...disk.files.keys()]
                            .filter(
                                path =>
                                    path.startsWith(`${entry.path}/`) &&
                                    !path.slice(entry.path.length + 1).includes('/'),
                            )
                            .map(path => path.slice(entry.path.length + 1));
                        sftp.name(
                            id,
                            found.map(name => ({ filename: name, longname: name, attrs: {} })),
                        );
                    });
                });
            });
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        fingerprint,
        close: () => {
            for (const client of clients) {
                client.end();
            }
            server.close();
        },
    };
}

module.exports = { startServer };
