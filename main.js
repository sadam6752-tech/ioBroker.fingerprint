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

        // Status polling
        if (ip && this.config.pollingEnabled) {
            await this._pollStatus();
            this._scheduleNextPoll();
        }
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
            const { reachable, info } = await client.ping();
            this.log.debug(`testConnection result: reachable=${reachable}`);
            if (reachable) {
                const uptime = info['Uptime'] ? `, uptime ${info['Uptime']}` : '';
                const text = `Connected to ${ip}${uptime}`;
                this.sendTo(
                    obj.from,
                    obj.command,
                    {
                        result: {
                            en: text,
                            de: `Verbunden mit ${ip}${uptime}`,
                            ru: `Подключено к ${ip}${uptime}`,
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
        const { reachable, info } = await this.esp.ping();
        await this.setStateAsync('info.connection', { val: reachable, ack: true });

        if (reachable) {
            if (info['Uptime'] !== undefined) {
                const uptime = parseInt(info['Uptime'], 10);
                if (Number.isFinite(uptime)) {
                    await this.setStateAsync('info.uptime', { val: uptime, ack: true });
                }
            }
            if (info['Free heap'] !== undefined) {
                const heap = parseInt(info['Free heap'], 10);
                if (Number.isFinite(heap)) {
                    await this.setStateAsync('info.freeHeap', { val: heap, ack: true });
                }
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
                desc: 'Requires firmware >= v0.9.1',
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
