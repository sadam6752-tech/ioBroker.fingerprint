'use strict';

const assert = require('node:assert/strict');
const { normalizeSecrets, isBrokenSecret } = require('../lib/secrets');

/**
 * Run `normalizeSecrets` with a collecting logger
 *
 * @param {object} config - native configuration (modified in place)
 * @param {(attr: string) => Promise<string>} [decrypt] - optional decrypt implementation
 * @returns {Promise<object>} config and collected log entries
 */
async function normalize(config, decrypt) {
    const logs = { info: [], warn: [], error: [] };
    const logger = {
        info: msg => logs.info.push(msg),
        warn: msg => logs.warn.push(msg),
        error: msg => logs.error.push(msg),
    };
    await normalizeSecrets(config, logger, decrypt);
    return { config, logs };
}

const XOR_GARBAGE = '7\u001e6\u001eT_\t\u0016\u0004KD\u001d%=)';

describe('lib/secrets', () => {
    describe('isBrokenSecret', () => {
        it('accepts printable secrets', () => {
            assert.equal(isBrokenSecret('abc123:/+='), false);
        });

        it('detects control characters', () => {
            assert.equal(isBrokenSecret(XOR_GARBAGE), true);
            assert.equal(isBrokenSecret('abc\u0000def'), true);
        });
    });

    describe('normalizeSecrets', () => {
        it('keeps plain text values untouched', async () => {
            const { config, logs } = await normalize({ adminPassword: 'secret', webhookToken: 'abcdef0123456789' });
            assert.equal(config.adminPassword, 'secret');
            assert.equal(config.webhookToken, 'abcdef0123456789');
            assert.equal(logs.info.length + logs.warn.length + logs.error.length, 0);
        });

        it('ignores missing and empty values', async () => {
            const { config, logs } = await normalize({ adminPassword: '', webhookToken: undefined });
            assert.equal(config.adminPassword, '');
            assert.equal(config.webhookToken, undefined);
            assert.equal(logs.warn.length, 0);
        });

        it('decrypts values stored in the $/aes-192-cbc: format', async () => {
            const { config, logs } = await normalize({ webhookToken: '$/aes-192-cbc:abcd:1234' }, async () => 'plainToken');
            assert.equal(config.webhookToken, 'plainToken');
            assert.equal(logs.info.length, 1);
            assert.match(logs.info[0], /decrypted webhookToken/);
        });

        it('keeps an encrypted value when no decrypt function is available', async () => {
            const { config } = await normalize({ webhookToken: '$/aes-192-cbc:abcd:1234' });
            assert.equal(config.webhookToken, '$/aes-192-cbc:abcd:1234');
        });

        it('clears a value when decryption fails', async () => {
            const { config, logs } = await normalize({ adminPassword: '$/aes-192-cbc:abcd:1234' }, async () => {
                throw new Error('bad secret');
            });
            assert.equal(config.adminPassword, '');
            assert.equal(logs.warn.length, 1);
            assert.match(logs.warn[0], /Could not decrypt the stored adminPassword/);
        });

        it('regenerates a broken webhook token', async () => {
            const { config, logs } = await normalize({ webhookToken: XOR_GARBAGE });
            assert.equal(config.webhookToken, '');
            assert.equal(logs.warn.length, 1);
            assert.match(logs.warn[0], /webhook token was unreadable/);
        });

        it('reports a broken password', async () => {
            const { config, logs } = await normalize({ adminPassword: XOR_GARBAGE });
            assert.equal(config.adminPassword, '');
            assert.equal(logs.error.length, 1);
            assert.match(logs.error[0], /stored adminPassword is unreadable/);
        });
    });
});
