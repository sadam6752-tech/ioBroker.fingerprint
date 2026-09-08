'use strict';

const utils = require('@iobroker/adapter-core');
const crypto = require('node:crypto');
const WebhookServer = require('./lib/webhook-server');
const EspClient = require('./lib/esp-client');

class Fingerprint extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'fingerprint' });

        this.esp = null;
        this.webhook = null;
        this._pollingTimer = null;
        this._ringResetTimer = null;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this._createObjects();
        await this.setStateAsync('info.connection', { val: false, ack: true });

        // Ensure a webhook token exists (auto-generate on first start)
        this._token = await this._ensureWebhookToken();

        const ip = (this.config.espIp || '').trim();
        if (!ip) {
            this.log.warn(
                'Device IP not configured — status polling and control disabled. Webhook receiver still starts.',
            );
        }

        this.esp = new EspClient({
            ip,
            port: this.config.espPort || 80,
            timeout: this.config.requestTimeout || 5000,
            user: this.config.adminUser || '',
            password: this.config.adminPassword || '',
        });

        await this.subscribeStatesAsync('control.*');

        // Start webhook receiver
        const webhookPort = this.config.webhookPort || 8095;
        const webhookBind = this.config.webhookBind || '0.0.0.0';
        this.webhook = new WebhookServer({
            port: webhookPort,
            bind: webhookBind,
            token: this._token,
            allowedIp: this.config.restrictToDeviceIp ? ip : '',
            log: (level, msg) => this.log[level](msg),
            onMatch: event => this._handleMatchEvent(event),
            onRing: () => this._handleRingEvent(),
        });
        try {
            await this.webhook.start();
            if (this._token) {
                this.log.info('Webhook token active — device must include the token (see instance settings).');
            } else {
                this.log.warn('Webhook token empty — events are accepted without authentication.');
            }
            this.log.info(`Configure device HTTP URLs to point to this adapter on port ${webhookPort} (see README).`);
        } catch (err) {
            this.log.error(`Failed to start webhook server on port ${webhookPort}: ${err.message}`);
        }

        // Auto-provision the device (server mode): tell the ESP to send events here
        if (ip) {
            await this._provisionServer();
        }

        // Status polling
        if (ip && this.config.pollingEnabled) {
            await this._pollStatus();
            this._scheduleNextPoll();
        }

        // Initial fingerprint list sync
        if (ip) {
            await this._syncFingerprints();
        }
    }

    // ── Server provisioning ──────────────────────────────────────────────────

    /**
     * Resolve the host/IP the device should send its events to.
     * Uses the configured serverHost if set, otherwise auto-detects a non-internal IPv4.
     *
     * @returns {string} adapter host/IP
     */
    _resolveAdapterHost() {
        const configured = (this.config.serverHost || '').trim();
        if (configured) {
            return configured;
        }
        const os = require('node:os');
        const ifaces = os.networkInterfaces();
        for (const addrs of Object.values(ifaces)) {
            for (const a of addrs) {
                if (a.family === 'IPv4' && !a.internal) {
                    return a.address;
                }
            }
        }
        return '';
    }

    /**
     * Register this adapter as the device's event target (enables server mode on the ESP).
     *
     * @returns {Promise<void>} resolves when provisioning attempt completes
     */
    async _provisionServer() {
        const host = this._resolveAdapterHost();
        if (!host) {
            this.log.warn('Could not determine adapter host IP for provisioning. Set "Adapter Host/IP" in settings.');
            return;
        }
        const port = this.config.webhookPort || 8095;
        try {
            const ok = await this.esp.registerServer(host, port, this._token);
            if (ok) {
                this.log.info(`Device provisioned: it will send events to ${host}:${port} (server mode enabled).`);
            } else {
                this.log.warn(
                    'Provisioning failed (check device auth / firmware >= v0.9.1). Falling back to manual URLs.',
                );
            }
        } catch (err) {
            this.log.warn(`Provisioning request failed: ${err.message}. Falling back to manual URLs.`);
        }
    }

    /**
     * Fetch the enrolled fingerprints and create/update fingerprints.<id> objects.
     *
     * @returns {Promise<void>} resolves when the list is synced
     */
    async _syncFingerprints() {
        if (!this.esp) {
            return;
        }
        let list;
        try {
            list = await this.esp.getFingerprints();
        } catch {
            return;
        }
        if (!Array.isArray(list) || list.length === 0) {
            return;
        }
        for (const fp of list) {
            if (fp.id === undefined) {
                continue;
            }
            const base = `fingerprints.${fp.id}`;
            await this.extendObjectAsync(base, {
                type: 'state',
                common: {
                    name: fp.name || `Finger ${fp.id}`,
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                    def: '',
                },
                native: {},
            });
            await this.setStateAsync(base, { val: fp.name || '', ack: true });
        }
        this.log.debug(`Synced ${list.length} fingerprint(s).`);
    }

    async onUnload(callback) {
        try {
            if (this._pollingTimer) {
                this.clearTimeout(this._pollingTimer);
                this._pollingTimer = null;
            }
            if (this._ringResetTimer) {
                this.clearTimeout(this._ringResetTimer);
                this._ringResetTimer = null;
            }
            if (this.webhook) {
                await this.webhook.stop();
                this.webhook = null;
            }
            await this.setStateAsync('info.connection', { val: false, ack: true });
        } catch {
            // ignore
        } finally {
            callback();
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        const parts = id.split('.');
        const channel = parts[parts.length - 2];
        const name = parts[parts.length - 1];

        if (channel !== 'control') {
            return;
        }

        try {
            await this._handleControl(name, state.val, id);
        } catch (err) {
            this.log.error(`Error handling ${id}: ${err.message}`);
        }
    }

    async onMessage(obj) {
        this.log.info(`onMessage received: command="${obj && obj.command}" hasCallback=${!!(obj && obj.callback)}`);
        if (!obj || !obj.command) {
            return;
        }

        try {
            await this._processMessage(obj);
        } catch (err) {
            this.log.error(`onMessage(${obj.command}) failed: ${err.message}`);
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { error: err.message }, obj.callback);
            }
        }
    }

    async _processMessage(obj) {
        if (obj.command === 'testConnection') {
            const ip = (this.config.espIp || '').trim();
            this.log.debug(`testConnection requested for ${ip}:${this.config.espPort}`);
            if (!ip) {
                this.sendTo(
                    obj.from,
                    obj.command,
                    {
                        error: {
                            en: 'Device IP not configured (save settings first)',
                            de: 'Geräte-IP nicht konfiguriert (zuerst speichern)',
                            ru: 'IP устройства не задан (сначала сохраните настройки)',
                        },
                    },
                    obj.callback,
                );
                return;
            }
            const client = new EspClient({
                ip,
                port: this.config.espPort || 80,
                timeout: Math.min(this.config.requestTimeout || 5000, 8000),
                user: this.config.adminUser || '',
                password: this.config.adminPassword || '',
            });
            // Try JSON status first (firmware >= v0.9.1), fall back to /debug
            let reachable = false;
            let version = '';
            const st = await client.getStatus();
            if (st.reachable) {
                reachable = true;
                version = st.status.version ? ` (v${st.status.version})` : '';
            } else {
                const legacy = await client.ping();
                reachable = legacy.reachable;
            }
            this.log.debug(`testConnection result: reachable=${reachable}`);
            if (reachable) {
                const text = `Connected to ${ip}${version}`;
                this.sendTo(
                    obj.from,
                    obj.command,
                    {
                        result: {
                            en: text,
                            de: `Verbunden mit ${ip}${version}`,
                            ru: `Подключено к ${ip}${version}`,
                        },
                    },
                    obj.callback,
                );
            } else {
                this.sendTo(
                    obj.from,
                    obj.command,
                    {
                        error: {
                            en: `Device not reachable at ${ip}`,
                            de: `Gerät unter ${ip} nicht erreichbar`,
                            ru: `Устройство недоступно по адресу ${ip}`,
                        },
                    },
                    obj.callback,
                );
            }
            return;
        }

        if (obj.command === 'getWebhookInfo') {
            const token = await this._ensureWebhookToken();
            const port = this.config.webhookPort || 8095;
            this.sendTo(obj.from, obj.command, { native: { webhookToken: token }, port }, obj.callback);
            return;
        }
    }

    // ── Event handlers ────────────────────────────────────────────────────────

    async _handleMatchEvent(event) {
        const ts = Date.now();
        await this.setStateAsync('lastMatch.id', { val: event.id, ack: true });
        await this.setStateAsync('lastMatch.name', { val: event.name, ack: true });
        await this.setStateAsync('lastMatch.confidence', { val: event.confidence, ack: true });
        await this.setStateAsync('lastMatch.timestamp', { val: ts, ack: true });
        // Fire the match trigger (auto-resets)
        await this.setStateAsync('lastMatch.matched', { val: true, ack: true });
        this.log.info(`Fingerprint match: id=${event.id} name="${event.name}" confidence=${event.confidence}`);
    }

    async _handleRingEvent() {
        const ts = Date.now();
        await this.setStateAsync('ring.timestamp', { val: ts, ack: true });
        await this.setStateAsync('ring.ringing', { val: true, ack: true });
        this.log.info('Doorbell ring (unknown finger)');
        // Auto-reset the ring trigger after 3s
        if (this._ringResetTimer) {
            this.clearTimeout(this._ringResetTimer);
        }
        this._ringResetTimer = this.setTimeout(() => {
            this.setState('ring.ringing', { val: false, ack: true });
            this._ringResetTimer = null;
        }, 3000);
    }

    // ── Control handler ───────────────────────────────────────────────────────

    async _handleControl(command, value, id) {
        if (!this.esp || !(this.config.espIp || '').trim()) {
            this.log.warn(`Control "${command}" ignored: device IP not configured`);
            return;
        }

        switch (command) {
            case 'reboot':
                if (value) {
                    this.log.info('Rebooting device...');
                    try {
                        const ok = await this.esp.reboot();
                        this.log.info(ok ? 'Reboot command sent' : 'Reboot command failed');
                    } catch (err) {
                        this.log.error(`Reboot failed: ${err.message}`);
                    }
                    await this.setStateAsync(id, { val: false, ack: true });
                }
                break;

            case 'ignoreTouchRing':
                try {
                    const ok = await this.esp.setIgnoreTouchRing(!!value);
                    if (ok) {
                        this.log.info(`Ignore touch ring set to ${!!value}`);
                        await this.setStateAsync(id, { val: !!value, ack: true });
                    } else {
                        this.log.warn('Set ignoreTouchRing failed (requires firmware >= v0.9.1)');
                    }
                } catch (err) {
                    this.log.error(`Set ignoreTouchRing failed: ${err.message}`);
                }
                break;

            default:
                this.log.debug(`Unknown control command: ${command}`);
        }
    }

    // ── Status polling ──────────────────────────────────────────────────────

    _scheduleNextPoll() {
        if (this._pollingTimer) {
            this.clearTimeout(this._pollingTimer);
        }
        const interval = (this.config.pollingInterval || 30) * 1000;
        this._pollingTimer = this.setTimeout(() => this._pollAndReschedule(), interval);
    }

    async _pollAndReschedule() {
        await this._pollStatus();
        if (this.config.pollingEnabled) {
            this._scheduleNextPoll();
        }
    }

    async _pollStatus() {
        if (!this.esp) {
            return;
        }

        // Prefer the JSON /api/status endpoint (firmware >= v0.9.1)
        const { reachable, status } = await this.esp.getStatus();
        if (reachable) {
            await this.setStateAsync('info.connection', { val: true, ack: true });
            if (typeof status.uptime === 'number') {
                await this.setStateAsync('info.uptime', { val: status.uptime, ack: true });
            }
            if (typeof status.freeHeap === 'number') {
                await this.setStateAsync('info.freeHeap', { val: status.freeHeap, ack: true });
            }
            if (status.version !== undefined) {
                await this.setStateAsync('info.firmwareVersion', { val: String(status.version), ack: true });
            }
            if (typeof status.serverMode === 'boolean') {
                await this.setStateAsync('info.serverMode', { val: status.serverMode, ack: true });
            }
            if (typeof status.ignoreTouchRing === 'boolean') {
                await this.setStateAsync('control.ignoreTouchRing', { val: status.ignoreTouchRing, ack: true });
            }
            return;
        }

        // Fallback to legacy /debug (firmware v0.9)
        const { reachable: legacyReachable, info } = await this.esp.ping();
        await this.setStateAsync('info.connection', { val: legacyReachable, ack: true });
        if (legacyReachable) {
            const uptime = parseInt(info['Uptime'], 10);
            if (Number.isFinite(uptime)) {
                await this.setStateAsync('info.uptime', { val: uptime, ack: true });
            }
            const heap = parseInt(info['Free heap'], 10);
            if (Number.isFinite(heap)) {
                await this.setStateAsync('info.freeHeap', { val: heap, ack: true });
            }
        }
    }

    // ── Webhook token ───────────────────────────────────────────────────────

    /**
     * Ensure a webhook token exists. Generates a random one on first start and
     * persists it into the adapter's native config.
     *
     * @returns {Promise<string>} the active webhook token
     */
    async _ensureWebhookToken() {
        let token = (this.config.webhookToken || '').trim();
        if (token) {
            return token;
        }
        token = crypto.randomBytes(24).toString('hex');
        try {
            await this.extendForeignObjectAsync(`system.adapter.${this.namespace}`, {
                native: { webhookToken: token },
            });
            this.config.webhookToken = token;
            this.log.info('Generated a new webhook token and stored it in the instance config.');
        } catch (err) {
            this.log.warn(`Could not persist webhook token: ${err.message}`);
        }
        return token;
    }

    // ── Object creation ─────────────────────────────────────────────────────

    async _createObjects() {
        // info extras
        await this.extendObjectAsync('info.uptime', {
            type: 'state',
            common: {
                name: 'Device uptime',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
                unit: 's',
            },
            native: {},
        });
        await this.extendObjectAsync('info.freeHeap', {
            type: 'state',
            common: { name: 'Free heap', type: 'number', role: 'value', read: true, write: false, def: 0, unit: 'B' },
            native: {},
        });
        await this.extendObjectAsync('info.firmwareVersion', {
            type: 'state',
            common: {
                name: 'Firmware version',
                type: 'string',
                role: 'info.firmware',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });
        await this.extendObjectAsync('info.serverMode', {
            type: 'state',
            common: {
                name: 'Server mode active',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
                def: false,
                desc: 'Device sends events directly to this adapter',
            },
            native: {},
        });

        // fingerprints channel (list of enrolled fingers)
        await this.extendObjectAsync('fingerprints', {
            type: 'channel',
            common: { name: 'Enrolled fingerprints' },
            native: {},
        });

        // lastMatch channel
        await this.extendObjectAsync('lastMatch', {
            type: 'channel',
            common: { name: 'Last fingerprint match' },
            native: {},
        });
        await this.extendObjectAsync('lastMatch.id', {
            type: 'state',
            common: { name: 'Match ID', type: 'number', role: 'value', read: true, write: false, def: -1 },
            native: {},
        });
        await this.extendObjectAsync('lastMatch.name', {
            type: 'state',
            common: { name: 'Match name', type: 'string', role: 'text', read: true, write: false, def: '' },
            native: {},
        });
        await this.extendObjectAsync('lastMatch.confidence', {
            type: 'state',
            common: { name: 'Match confidence', type: 'number', role: 'value', read: true, write: false, def: 0 },
            native: {},
        });
        await this.extendObjectAsync('lastMatch.timestamp', {
            type: 'state',
            common: { name: 'Match timestamp', type: 'number', role: 'date', read: true, write: false, def: 0 },
            native: {},
        });
        await this.extendObjectAsync('lastMatch.matched', {
            type: 'state',
            common: {
                name: 'Match trigger',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
                def: false,
                desc: 'Set to true on each match event',
            },
            native: {},
        });

        // ring channel
        await this.extendObjectAsync('ring', {
            type: 'channel',
            common: { name: 'Doorbell ring (unknown finger)' },
            native: {},
        });
        await this.extendObjectAsync('ring.ringing', {
            type: 'state',
            common: {
                name: 'Ringing',
                type: 'boolean',
                role: 'sensor.doorbell',
                read: true,
                write: false,
                def: false,
                desc: 'True for a few seconds on a doorbell ring',
            },
            native: {},
        });
        await this.extendObjectAsync('ring.timestamp', {
            type: 'state',
            common: { name: 'Ring timestamp', type: 'number', role: 'date', read: true, write: false, def: 0 },
            native: {},
        });

        // control channel
        await this.extendObjectAsync('control', {
            type: 'channel',
            common: { name: 'Control' },
            native: {},
        });
        await this.extendObjectAsync('control.reboot', {
            type: 'state',
            common: { name: 'Reboot device', type: 'boolean', role: 'button', read: false, write: true, def: false },
            native: {},
        });
        await this.extendObjectAsync('control.ignoreTouchRing', {
            type: 'state',
            common: {
                name: 'Ignore touch ring',
                type: 'boolean',
                role: 'switch',
                read: true,
                write: true,
                def: false,
                desc: 'Ignore the capacitive touch ring (firmware >= v0.9.1)',
            },
            native: {},
        });
    }
}

if (require.main !== module) {
    module.exports = options => new Fingerprint(options);
} else {
    new Fingerprint();
}
