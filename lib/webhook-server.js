'use strict';

const http = require('node:http');
const os = require('node:os');
const { URL } = require('node:url');

/**
 * HTTP webhook receiver for FingerprintDoorbell events.
 *
 * The ESP32 is configured (in its WebUI, fields "HTTP Match URL" / "HTTP Ring URL",
 * or automatically via server-mode provisioning) to call this server on a
 * fingerprint match or an unknown-finger ring:
 *
 *   Match: GET /match?id={id}&name={name}&confidence={confidence}[&token=...]
 *   Ring:  GET /ring[?token=...]
 *
 * Security:
 *  - If a token is configured, requests must carry it via the `X-Auth-Token`
 *    header or a `token` query parameter, otherwise they are rejected (401).
 *  - Optionally, requests are only accepted from the configured device IP.
 *
 * Uses only the built-in http module — no external dependencies.
 */
class WebhookServer {
    /**
     * @param {object} opts options
     * @param {number} opts.port port to listen on
     * @param {string} opts.bind bind IP address ('0.0.0.0' for all interfaces)
     * @param {string} [opts.token] shared secret required on incoming requests
     * @param {string} [opts.allowedIp] if set, only accept requests from this IP
     * @param {(event: object) => void} opts.onMatch callback for match events
     * @param {() => void} opts.onRing callback for ring events
     * @param {(level: string, msg: string) => void} opts.log logger
     */
    constructor(opts) {
        this.port = opts.port;
        this.bind = opts.bind || '0.0.0.0';
        this.token = opts.token || '';
        this.allowedIp = opts.allowedIp || '';
        this.onMatch = opts.onMatch || (() => {});
        this.onRing = opts.onRing || (() => {});
        this.log = opts.log || (() => {});
        this.server = null;
    }

    /**
     * Resolve an interface name to an IPv4 address, or pass through an IP/0.0.0.0.
     *
     * @param {string} bind bind value (IP, interface name, or 0.0.0.0)
     * @returns {string} resolved bind address
     */
    _resolveBindAddress(bind) {
        if (!bind || bind === '0.0.0.0') {
            return bind;
        }
        if (/^\d+\.\d+\.\d+\.\d+$/.test(bind)) {
            return bind;
        }
        const ifaces = os.networkInterfaces();
        if (ifaces[bind]) {
            const ipv4 = ifaces[bind].find(i => i.family === 'IPv4');
            if (ipv4) {
                return ipv4.address;
            }
        }
        for (const addrs of Object.values(ifaces)) {
            const match = addrs.find(a => a.family === 'IPv4' && a.address === bind);
            if (match) {
                return match.address;
            }
        }
        return bind;
    }

    /**
     * Normalize a remote address (strips IPv6-mapped IPv4 prefix).
     *
     * @param {string} addr socket remote address
     * @returns {string} normalized IPv4 address
     */
    _normalizeIp(addr) {
        if (!addr) {
            return '';
        }
        return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
    }

    /**
     * Validate the token supplied on a request.
     *
     * @param {import('node:url').URL} url parsed request URL
     * @param {http.IncomingMessage} req request
     * @returns {boolean} true if authorized
     */
    _isAuthorized(url, req) {
        if (!this.token) {
            return true; // no token configured → accept (backwards compatible)
        }
        const headerToken = req.headers['x-auth-token'];
        const queryToken = url.searchParams.get('token');
        return headerToken === this.token || queryToken === this.token;
    }

    /**
     * Start the webhook server.
     *
     * @returns {Promise<void>} resolves once the server is listening
     */
    start() {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => this._handleRequest(req, res));

            const resolvedBind = this._resolveBindAddress(this.bind);
            this.server.on('error', err => reject(err));
            this.server.listen(this.port, resolvedBind, () => {
                this.log('info', `Webhook server listening on ${resolvedBind}:${this.port}`);
                resolve();
            });
        });
    }

    /**
     * Handle a single incoming HTTP request.
     *
     * @param {http.IncomingMessage} req request
     * @param {http.ServerResponse} res response
     * @returns {void}
     */
    _handleRequest(req, res) {
        let url;
        try {
            url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        } catch {
            res.writeHead(400).end('Bad request');
            return;
        }

        const pathname = url.pathname;
        const remoteIp = this._normalizeIp(req.socket.remoteAddress);

        // Health endpoint — always open, no auth
        if (pathname === '/health' && req.method === 'GET') {
            res.writeHead(200).end('OK');
            return;
        }

        // IP restriction
        if (this.allowedIp && remoteIp !== this.allowedIp) {
            this.log('warn', `Rejected webhook from ${remoteIp} (expected ${this.allowedIp})`);
            res.writeHead(403).end('Forbidden');
            return;
        }

        // Token check
        if (!this._isAuthorized(url, req)) {
            this.log('warn', `Rejected webhook from ${remoteIp}: invalid or missing token`);
            res.writeHead(401).end('Unauthorized');
            return;
        }

        if (pathname === '/match') {
            const id = parseInt(url.searchParams.get('id'), 10);
            const event = {
                id: Number.isFinite(id) ? id : -1,
                name: url.searchParams.get('name') || '',
                confidence: parseInt(url.searchParams.get('confidence'), 10) || 0,
            };
            this.log('debug', `Webhook /match: ${JSON.stringify(event)}`);
            try {
                this.onMatch(event);
            } catch (e) {
                this.log('error', `onMatch handler failed: ${e.message}`);
            }
            res.writeHead(200).end('OK');
            return;
        }

        if (pathname === '/ring') {
            this.log('debug', 'Webhook /ring');
            try {
                this.onRing();
            } catch (e) {
                this.log('error', `onRing handler failed: ${e.message}`);
            }
            res.writeHead(200).end('OK');
            return;
        }

        res.writeHead(404).end('Not found');
    }

    /**
     * Stop the webhook server.
     *
     * @returns {Promise<void>} resolves once the server is closed
     */
    stop() {
        return new Promise(resolve => {
            if (this.server) {
                this.server.close(() => {
                    this.server = null;
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }
}

module.exports = WebhookServer;
