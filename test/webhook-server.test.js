'use strict';

const assert = require('node:assert/strict');
const WebhookServer = require('../lib/webhook-server');

/**
 * Create a mocked HTTP response
 *
 * @returns {object} mocked response with status and body
 */
function createResMock() {
    return {
        status: 0,
        body: '',
        /**
         * @param {number} code - HTTP status code
         * @returns {object} this
         */
        writeHead(code) {
            this.status = code;
            return this;
        },
        /**
         * @param {string} [body] - response body
         * @returns {object} this
         */
        end(body) {
            this.body = body === undefined ? '' : String(body);
            return this;
        },
    };
}

/**
 * Create a mocked HTTP request
 *
 * @param {string} url - request url including query string
 * @param {object} [opts] - additional options
 * @param {object} [opts.headers] - request headers
 * @param {string} [opts.remoteAddress] - socket remote address
 * @returns {object} mocked request
 */
function createReqMock(url, opts = {}) {
    return {
        url,
        method: 'GET',
        headers: { host: 'localhost', ...(opts.headers || {}) },
        socket: { remoteAddress: opts.remoteAddress === undefined ? '192.168.1.50' : opts.remoteAddress },
    };
}

/**
 * Create a WebhookServer that records all callbacks
 *
 * @param {object} [opts] - options
 * @param {string} [opts.token] - shared secret
 * @param {string} [opts.allowedIp] - allowed device IP
 * @returns {object} server plus recorded events
 */
function createServer(opts = {}) {
    const events = { matches: [], rings: [], logs: [] };
    const server = new WebhookServer({
        port: 8095,
        bind: '0.0.0.0',
        token: opts.token,
        allowedIp: opts.allowedIp,
        onMatch: event => events.matches.push(event),
        onRing: () => events.rings.push(true),
        log: (level, msg) => events.logs.push(`${level}: ${msg}`),
    });
    return { server, events };
}

describe('WebhookServer', () => {
    describe('_normalizeIp', () => {
        it('returns an empty string for missing addresses', () => {
            const { server } = createServer();
            assert.equal(server._normalizeIp(undefined), '');
            assert.equal(server._normalizeIp(''), '');
        });

        it('strips the IPv6-mapped IPv4 prefix', () => {
            const { server } = createServer();
            assert.equal(server._normalizeIp('::ffff:192.168.1.10'), '192.168.1.10');
        });

        it('keeps plain IPv4 and IPv6 addresses', () => {
            const { server } = createServer();
            assert.equal(server._normalizeIp('192.168.1.10'), '192.168.1.10');
            assert.equal(server._normalizeIp('fe80::1'), 'fe80::1');
        });
    });

    describe('_resolveBindAddress', () => {
        it('passes through 0.0.0.0, empty values and plain IPv4 addresses', () => {
            const { server } = createServer();
            assert.equal(server._resolveBindAddress('0.0.0.0'), '0.0.0.0');
            assert.equal(server._resolveBindAddress(''), '');
            assert.equal(server._resolveBindAddress('192.168.1.5'), '192.168.1.5');
        });

        it('returns unknown interface names unchanged', () => {
            const { server } = createServer();
            assert.equal(server._resolveBindAddress('iface-does-not-exist-xyz'), 'iface-does-not-exist-xyz');
        });
    });

    describe('_isAuthorized', () => {
        it('accepts everything when no token is configured', () => {
            const { server } = createServer();
            assert.equal(server._isAuthorized(new URL('http://localhost/match'), createReqMock('/match')), true);
        });

        it('accepts the token from the header', () => {
            const { server } = createServer({ token: 'secret' });
            const req = createReqMock('/match', { headers: { 'x-auth-token': 'secret' } });
            assert.equal(server._isAuthorized(new URL('http://localhost/match'), req), true);
        });

        it('accepts the token from the query parameter', () => {
            const { server } = createServer({ token: 'secret' });
            const url = new URL('http://localhost/match?token=secret');
            assert.equal(server._isAuthorized(url, createReqMock('/match?token=secret')), true);
        });

        it('rejects wrong and missing tokens', () => {
            const { server } = createServer({ token: 'secret' });
            const wrong = new URL('http://localhost/match?token=nope');
            assert.equal(server._isAuthorized(wrong, createReqMock('/match?token=nope')), false);
            assert.equal(server._isAuthorized(new URL('http://localhost/match'), createReqMock('/match')), false);
        });
    });

    describe('_handleRequest', () => {
        it('answers /health without authentication', () => {
            const { server } = createServer({ token: 'secret' });
            const res = createResMock();
            server._handleRequest(createReqMock('/health'), res);
            assert.equal(res.status, 200);
            assert.equal(res.body, 'OK');
        });

        it('rejects requests from a foreign IP', () => {
            const { server, events } = createServer({ allowedIp: '192.168.1.50' });
            const res = createResMock();
            server._handleRequest(createReqMock('/ring', { remoteAddress: '::ffff:192.168.1.99' }), res);
            assert.equal(res.status, 403);
            assert.equal(events.rings.length, 0);
        });

        it('accepts requests from the configured device IP', () => {
            const { server, events } = createServer({ allowedIp: '192.168.1.50' });
            const res = createResMock();
            server._handleRequest(createReqMock('/ring', { remoteAddress: '::ffff:192.168.1.50' }), res);
            assert.equal(res.status, 200);
            assert.equal(events.rings.length, 1);
        });

        it('rejects requests without a valid token', () => {
            const { server, events } = createServer({ token: 'secret' });
            const res = createResMock();
            server._handleRequest(createReqMock('/match?id=3'), res);
            assert.equal(res.status, 401);
            assert.equal(events.matches.length, 0);
        });

        it('parses match events', () => {
            const { server, events } = createServer();
            const res = createResMock();
            server._handleRequest(createReqMock('/match?id=4&name=Alice&confidence=87'), res);
            assert.equal(res.status, 200);
            assert.deepEqual(events.matches, [{ id: 4, name: 'Alice', confidence: 87 }]);
        });

        it('falls back to defaults for missing match parameters', () => {
            const { server, events } = createServer();
            server._handleRequest(createReqMock('/match?name=Alice'), createResMock());
            assert.deepEqual(events.matches[0], { id: -1, name: 'Alice', confidence: 0 });
        });

        it('raises ring events', () => {
            const { server, events } = createServer();
            const res = createResMock();
            server._handleRequest(createReqMock('/ring'), res);
            assert.equal(res.status, 200);
            assert.equal(events.rings.length, 1);
        });

        it('answers 404 for unknown paths', () => {
            const { server } = createServer();
            const res = createResMock();
            server._handleRequest(createReqMock('/nope'), res);
            assert.equal(res.status, 404);
        });

        it('logs a failing handler but still answers 200', () => {
            const logs = [];
            const server = new WebhookServer({
                port: 8095,
                onMatch: () => {
                    throw new Error('boom');
                },
                log: (level, msg) => logs.push(`${level}: ${msg}`),
            });
            const res = createResMock();
            server._handleRequest(createReqMock('/match?id=1'), res);
            assert.equal(res.status, 200);
            const errors = logs.filter(entry => entry.startsWith('error'));
            assert.equal(errors.length, 1);
            assert.match(errors[0], /onMatch handler failed: boom/);
        });
    });
});

