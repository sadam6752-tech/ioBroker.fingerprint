'use strict';

const assert = require('node:assert/strict');
const EspClient = require('../lib/esp-client');

describe('EspClient', () => {
    describe('constructor', () => {
        it('applies defaults for port, timeout and credentials', () => {
            const client = new EspClient({ ip: '192.168.1.50' });
            assert.equal(client.ip, '192.168.1.50');
            assert.equal(client.port, 80);
            assert.equal(client.timeout, 5000);
            assert.equal(client.user, '');
            assert.equal(client.password, '');
        });

        it('keeps explicit values', () => {
            const client = new EspClient({ ip: '10.0.0.2', port: 8080, timeout: 1000, user: 'admin', password: 'secret' });
            assert.equal(client.port, 8080);
            assert.equal(client.timeout, 1000);
            assert.equal(client.user, 'admin');
            assert.equal(client.password, 'secret');
        });
    });

    describe('_parseDebug', () => {
        it('parses the key/value lines of the /debug output', () => {
            const client = new EspClient({ ip: '127.0.0.1' });
            const info = client._parseDebug('Free heap: 123456\nUptime: 42\nFirmware: v0.9.4\n');
            assert.deepEqual(info, { 'Free heap': '123456', Uptime: '42', Firmware: 'v0.9.4' });
        });

        it('keeps colons inside the value', () => {
            const client = new EspClient({ ip: '127.0.0.1' });
            assert.deepEqual(client._parseDebug('Time: 12:34:56'), { Time: '12:34:56' });
        });

        it('ignores lines without a key', () => {
            const client = new EspClient({ ip: '127.0.0.1' });
            assert.deepEqual(client._parseDebug('no colon here\n: empty key\nKey: value'), { Key: 'value' });
        });

        it('handles empty input', () => {
            const client = new EspClient({ ip: '127.0.0.1' });
            assert.deepEqual(client._parseDebug(''), {});
        });
    });

    describe('ping', () => {
        it('reports an unreachable device without throwing', async () => {
            const client = new EspClient({ ip: '127.0.0.1', port: 59999, timeout: 1000 });
            const result = await client.ping();
            assert.equal(result.reachable, false);
            assert.deepEqual(result.info, {});
        });
    });
});
