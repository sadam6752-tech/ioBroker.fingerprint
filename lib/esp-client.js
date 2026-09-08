'use strict';

const http = require('node:http');

/**
 * Lightweight HTTP client for the FingerprintDoorbell ESP32 WebUI.
 * Uses the built-in http module (no extra dependency) and HTTP Basic Auth.
 */
class EspClient {
    /**
     * @param {object} opts options
     * @param {string} opts.ip device IP address
     * @param {number} opts.port device HTTP port
     * @param {number} opts.timeout request timeout in ms
     * @param {string} [opts.user] HTTP Basic Auth user
     * @param {string} [opts.password] HTTP Basic Auth password
     */
    constructor(opts) {
        this.ip = opts.ip;
        this.port = opts.port || 80;
        this.timeout = opts.timeout || 5000;
        this.user = opts.user || '';
        this.password = opts.password || '';
    }

    /**
     * Perform a GET request against the device.
     *
     * @param {string} path request path (e.g. '/debug')
     * @returns {Promise<{status: number, body: string}>} resolves with status code and body
     */
    _get(path) {
        return new Promise((resolve, reject) => {
            const headers = {};
            if (this.user || this.password) {
                const token = Buffer.from(`${this.user}:${this.password}`).toString('base64');
                headers.Authorization = `Basic ${token}`;
            }

            let settled = false;
            const done = (err, value) => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(guard);
                if (err) {
                    reject(err);
                } else {
                    resolve(value);
                }
            };

            const req = http.request(
                {
                    host: this.ip,
                    port: this.port,
                    path,
                    method: 'GET',
                    headers,
                    timeout: this.timeout,
                },
                res => {
                    let body = '';
                    res.setEncoding('utf8');
                    res.on('data', chunk => (body += chunk));
                    res.on('end', () => done(null, { status: res.statusCode, body }));
                },
            );

            // Hard guard so the promise never hangs forever
            const guard = setTimeout(() => {
                req.destroy(new Error(`Request to ${this.ip}:${this.port}${path} timed out`));
            }, this.timeout + 1000);

            req.on('error', err => done(err));
            req.on('timeout', () => {
                req.destroy(new Error(`Request to ${this.ip}:${this.port}${path} timed out`));
            });
            req.end();
        });
    }

    /**
     * Check whether the device is reachable via the /debug endpoint (no auth required).
     *
     * @returns {Promise<{reachable: boolean, info: object}>} reachability plus parsed device info
     */
    async ping() {
        try {
            const res = await this._get('/debug');
            if (res.status !== 200) {
                return { reachable: false, info: {} };
            }
            return { reachable: true, info: this._parseDebug(res.body) };
        } catch {
            return { reachable: false, info: {} };
        }
    }

    /**
     * Parse the plain-text /debug output into a key/value object.
     *
     * @param {string} text raw /debug body
     * @returns {object} parsed key/value pairs
     */
    _parseDebug(text) {
        const info = {};
        for (const line of String(text).split('\n')) {
            const idx = line.indexOf(':');
            if (idx > 0) {
                const key = line.slice(0, idx).trim();
                const val = line.slice(idx + 1).trim();
                if (key) {
                    info[key] = val;
                }
            }
        }
        return info;
    }

    /**
     * Trigger a device reboot via the /reboot endpoint.
     *
     * @returns {Promise<boolean>} true on success
     */
    async reboot() {
        const res = await this._get('/reboot');
        // /reboot answers with a redirect (302) or 200 before rebooting
        return res.status >= 200 && res.status < 400;
    }

    /**
     * Enable/disable "ignore touch ring" via the /set-touch-ring endpoint.
     * Requires FingerprintDoorbell firmware >= v0.9.1.
     *
     * @param {boolean} enabled desired state
     * @returns {Promise<boolean>} true on success
     */
    async setIgnoreTouchRing(enabled) {
        const res = await this._get(`/set-touch-ring?state=${enabled ? 'on' : 'off'}`);
        return res.status >= 200 && res.status < 400;
    }

    /**
     * Query the device status via the JSON /api/status endpoint (firmware >= v0.9.1).
     *
     * @returns {Promise<{reachable: boolean, status: object}>} reachability plus parsed status object
     */
    async getStatus() {
        try {
            const res = await this._get('/api/status');
            if (res.status !== 200) {
                return { reachable: false, status: {} };
            }
            let status = {};
            try {
                status = JSON.parse(res.body);
            } catch {
                return { reachable: false, status: {} };
            }
            return { reachable: true, status };
        } catch {
            return { reachable: false, status: {} };
        }
    }

    /**
     * Register this adapter as the event target on the device (server mode).
     * Requires firmware >= v0.9.1.
     *
     * @param {string} host adapter host/IP the device should send events to
     * @param {number} port webhook port
     * @param {string} token shared secret
     * @returns {Promise<boolean>} true on success
     */
    async registerServer(host, port, token) {
        const q = `host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}&token=${encodeURIComponent(token)}`;
        const res = await this._get(`/api/register-server?${q}`);
        return res.status >= 200 && res.status < 400;
    }

    /**
     * Enable/disable server mode on the device.
     *
     * @param {boolean} enabled desired state
     * @returns {Promise<boolean>} true on success
     */
    async setServerMode(enabled) {
        const res = await this._get(`/api/server-mode?state=${enabled ? 'on' : 'off'}`);
        return res.status >= 200 && res.status < 400;
    }

    /**
     * Fetch the list of enrolled fingerprints via /api/fingerprints (firmware >= v0.9.1).
     *
     * @returns {Promise<Array<{id: number, name: string}>>} list of fingerprints (empty on failure)
     */
    async getFingerprints() {
        try {
            const res = await this._get('/api/fingerprints');
            if (res.status !== 200) {
                return [];
            }
            const list = JSON.parse(res.body);
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }
}

module.exports = EspClient;
