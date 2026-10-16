'use strict';

/**
 * Names, order and checks of the fingerprint backup files.
 *
 * The backups live in the ioBroker file storage below the mount point `<namespace>.storage`
 * (`meta.user`, so ioBroker / BackItUp backups take them along), folder `backups/`. Every file
 * has the time stamp in its name, so the alphabetical order is the age:
 *
 * - `fingerprint-backup-<time>.json`     made by hand — never deleted automatically
 * - `fingerprint-auto-<time>.json`       automatic — the oldest beyond `backupKeep` are deleted
 * - `fingerprint-prerestore-<time>.json` the sensor content saved right before a restore — never
 *   deleted automatically, so a wrong restore can be undone
 *
 * The same names are used on the external SFTP server.
 */

/** Folder of the backups below the mount point. */
const BACKUP_DIR = 'backups';

/** Pattern of a backup file of this adapter (nothing else is ever listed, read or deleted). */
const BACKUP_NAME = /^fingerprint-(backup|auto|prerestore)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.json$/;

/**
 * File name of a backup, with the time (UTC) in the name.
 *
 * @param {'manual'|'auto'|'prerestore'} kind made by hand, automatic or safety copy before a restore
 * @param {Date} [date] time of the backup
 * @returns {string} e.g. `fingerprint-auto-2026-10-16T08-00-00.json`
 */
function backupName(kind, date = new Date()) {
    const stamp = date.toISOString().slice(0, 19).replace(/:/g, '-');
    const prefix = kind === 'manual' ? 'backup' : kind;
    return `fingerprint-${prefix}-${stamp}.json`;
}

/**
 * Check whether a name is a backup file of this adapter (also refuses paths and `..`).
 *
 * @param {unknown} name file name
 * @returns {boolean} true for `fingerprint-(backup|auto|prerestore)-<time>.json`
 */
function isBackupName(name) {
    return typeof name === 'string' && BACKUP_NAME.test(name);
}

/**
 * The backup files of a listing, newest first (equal times: by name).
 *
 * @param {string[]} names file names
 * @returns {string[]} backup names, newest first
 */
function sortBackupsNewestFirst(names) {
    return names.filter(isBackupName).sort((a, b) => {
        const ta = a.match(BACKUP_NAME)[2];
        const tb = b.match(BACKUP_NAME)[2];
        return ta === tb ? (a < b ? 1 : -1) : ta < tb ? 1 : -1;
    });
}

/**
 * The automatic backups that exceed the number to keep (the oldest ones). Backups made by hand,
 * safety copies and foreign files are never selected.
 *
 * @param {string[]} names file names in the backup folder
 * @param {number} keep automatic backups to keep, 0 (or less, or not a number) = keep all
 * @returns {string[]} the names to delete
 */
function selectLocalBackupsToPrune(names, keep) {
    const limit = Number(keep);
    if (!Number.isFinite(limit) || limit <= 0) {
        return [];
    }
    return sortBackupsNewestFirst(names.filter(name => name.startsWith('fingerprint-auto-'))).slice(Math.floor(limit));
}

/**
 * Check the content of a backup file before it is written to the sensor.
 *
 * @param {string|Buffer} content file content
 * @returns {{ok: boolean, count: number, json: string, message: string}} result; `json` is the
 *     text to send to the device
 */
function validateBackupContent(content) {
    const json = Buffer.isBuffer(content) ? content.toString('utf8') : String(content ?? '');
    let list;
    try {
        list = JSON.parse(json);
    } catch {
        return { ok: false, count: 0, json, message: 'the backup file is not valid JSON' };
    }
    if (!Array.isArray(list)) {
        return { ok: false, count: 0, json, message: 'the backup file does not contain a list of fingerprints' };
    }
    if (list.length === 0) {
        return { ok: false, count: 0, json, message: 'the backup file contains no fingerprints' };
    }
    const seen = new Set();
    for (const [index, entry] of list.entries()) {
        const id = entry && entry.id;
        if (!Number.isInteger(id) || id < 1 || id > 200) {
            return { ok: false, count: 0, json, message: `entry ${index + 1} has no valid finger id (1-200)` };
        }
        if (seen.has(id)) {
            return { ok: false, count: 0, json, message: `finger id ${id} appears twice` };
        }
        seen.add(id);
        if (typeof entry.template !== 'string' || entry.template === '') {
            return { ok: false, count: 0, json, message: `finger id ${id} has no template` };
        }
    }
    return { ok: true, count: list.length, json, message: `${list.length} finger(s)` };
}

/**
 * Text for a backup in a selection list.
 *
 * @param {string} name backup file name
 * @param {number} [size] size in bytes
 * @returns {string} e.g. `2026-10-16 08:00:00 UTC · automatic · 12 kB`
 */
function backupLabel(name, size) {
    const match = String(name).match(BACKUP_NAME);
    if (!match) {
        return String(name);
    }
    const [date, time] = match[2].split('T');
    const kind = { backup: 'by hand', auto: 'automatic', prerestore: 'before restore' }[match[1]];
    const kb = Number.isFinite(size) && size > 0 ? ` · ${Math.max(1, Math.round(size / 1024))} kB` : '';
    return `${date} ${time.replace(/-/g, ':')} UTC · ${kind}${kb}`;
}

module.exports = {
    BACKUP_DIR,
    backupName,
    isBackupName,
    sortBackupsNewestFirst,
    selectLocalBackupsToPrune,
    validateBackupContent,
    backupLabel,
};
