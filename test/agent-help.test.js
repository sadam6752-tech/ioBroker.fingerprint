'use strict';

const assert = require('node:assert/strict');
const { COMMANDS, HELP, helpAnswer } = require('../lib/agent-help');

describe('help for AI agents', () => {
    it('answers {help, commands} with unique commands and a write flag each', () => {
        const answer = helpAnswer();
        assert.equal(typeof answer.help, 'string');
        const names = answer.commands.map(c => c.command);
        assert.equal(new Set(names).size, names.length);
        for (const c of answer.commands) {
            assert.equal(typeof c.write, 'boolean', c.command);
        }
    });

    it('describes every command except help itself', () => {
        for (const { command } of COMMANDS.filter(c => c.command !== 'help')) {
            assert.match(HELP, new RegExp(`^${command} \{`, 'm'), command);
        }
    });

    it('marks the commands that change the sensor or its backups as write', () => {
        const write = COMMANDS.filter(c => c.write).map(c => c.command);
        assert.deepEqual(write.sort(), [
            'backupFingerprints',
            'enrollFinger',
            'renameFinger',
            'restoreFingerprints',
            'restoreFromRemote',
        ]);
    });

    it('names the states for scripts, the rollout limit and no live values', () => {
        assert.match(HELP, /control\.backup/);
        assert.match(HELP, /control\.restore/);
        assert.match(HELP, /info\.lastResult/);
        assert.match(HELP, /identical sensor modules/);
        assert.doesNotMatch(HELP, /\d{4}-\d{2}-\d{2}T/);
    });

    it('gives a copy, so a caller cannot change the list', () => {
        helpAnswer().commands[0].write = true;
        assert.equal(helpAnswer().commands[0].write, false);
    });
});
