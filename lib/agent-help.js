'use strict';

/**
 * The answer to the message `help` (js-controller PR #3638, `common.supportedMessages.help`): a text
 * for AI agents (e.g. ioBroker.pi-agent) and script authors, and the commands with whether they change
 * something (`write: true`). The text is stable (no live values): an agent reads it again only when it
 * changes.
 */

/** @type {Array<{command: string, write: boolean}>} */
const COMMANDS = [
    { command: 'help', write: false },
    { command: 'testConnection', write: false },
    { command: 'getFingerOptions', write: false },
    { command: 'listBackups', write: false },
    { command: 'backupFingerprints', write: true },
    { command: 'restoreFingerprints', write: true },
    { command: 'renameFinger', write: true },
    { command: 'enrollFinger', write: true },
    { command: 'listRemoteBackups', write: false },
    { command: 'restoreFromRemote', write: true },
];

const HELP = [
    'Fingerprint connects one FingerprintDoorbell (an ESP32 with a fingerprint sensor such as the R503 and a ' +
        'touch ring) per instance: it reports who placed a finger, runs the actions set in the admin, enrolls ' +
        'fingers and backs the fingers (templates) of the sensor up. Every command takes an object as message and ' +
        'answers {result, ...} or {error}.',
    '',
    'Commands:',
    'testConnection {}: whether the sensor answers, with its firmware version.',
    'getFingerOptions {}: the enrolled fingers as [{value: id, label: "id — name"}].',
    'renameFinger {id (1-200), name}: renames an enrolled finger.',
    'enrollFinger {id (1-200), name?}: starts enrolling a finger in that slot; the person places the finger on ' +
        'the sensor five times. Follow enroll.status (scanning, success, error) and enroll.step (0-5).',
    'backupFingerprints {}: reads all fingers from the sensor into a backup file in the storage folder of the ' +
        'instance (and to the external server when that is set up); answers {result, file, count}.',
    'listBackups {}: the backup files of this instance, newest first, as [{value: file, label}].',
    'restoreFingerprints {file?, from?}: writes a backup to the sensor, replacing all its fingers; the previous ' +
        'content is saved first as fingerprint-prerestore-<time>.json. file: a backup file name or "latest" ' +
        '(default). from: another instance of this adapter (e.g. "fingerprint.0") whose backup is taken over: ' +
        'this rolls the fingers of one sensor out to further sensors. Only between identical sensor modules. ' +
        'Answers {result, file, count}.',
    'listRemoteBackups {}: the backup files on the external server.',
    'restoreFromRemote {file}: fetches a backup from the external server and restores it like restoreFingerprints.',
    '',
    'States of the instance:',
    'lastMatch.id, lastMatch.name, lastMatch.confidence, lastMatch.matched, lastMatch.timestamp: the last finger ' +
        'the sensor recognized (or not). lastAccess.text, lastAccess.granted, lastAccess.timestamp: the last ' +
        'access decision. ring.ringing, ring.timestamp: the doorbell rang (an unknown finger or the touch ring).' +
        'fingerprints.<id>.name, .count, .lastSeen: each enrolled finger. stats.*: counters.',
    'control.backup (button): backup like backupFingerprints. control.restore (text): restore like ' +
        'restoreFingerprints; write "latest", a backup file name, "fingerprint.0" (newest backup of that instance) ' +
        'or "fingerprint.0/<file>". info.lastResult: JSON {ok, action (backup | restore), message, file, count, ts} ' +
        'of the last backup or restore started by a state; info.lastBackup: time of the last backup.',
    'control.enrollId, control.enrollName, control.enrollStart: enroll by states. control.ledMode (0 off, 1 on, ' +
        '2 breathing, 3 flashing) and control.ledColor (1 red, 2 blue, 3 purple, 4 green, 5 yellow, 6 cyan, ' +
        '7 white): the LED ring. control.ignoreTouchRing, control.reboot.',
    'A restore replaces the fingers of a sensor and may lock people out: confirm with the user first.',
].join('\n');

/**
 * The answer to `help`.
 *
 * @returns {{help: string, commands: Array<{command: string, write: boolean}>}} answer
 */
function helpAnswer() {
    return { help: HELP, commands: COMMANDS.map(c => ({ ...c })) };
}

module.exports = { COMMANDS, HELP, helpAnswer };
