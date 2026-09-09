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
        this._lastActionTime = {};

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
            await this._ensureFingerObjects(fp.id, fp.name || `Finger ${fp.id}`);
            await this.setStateAsync(`fingerprints.${fp.id}.name`, { val: fp.name || '', ack: true });
        }
        this.log.debug(`Synced ${list.length} fingerprint(s).`);
    }

    /**
     * Ensure the channel + sub-states for a fingerprint exist.
     * Migrates the old flat `fingerprints.<id>` state (v0.3.x) to a channel if needed.
     *
     * @param {number|string} id fingerprint id
     * @param {string} name fingerprint name (for the channel label)
     * @returns {Promise<void>} resolves when objects exist
     */
    async _ensureFingerObjects(id, name) {
        const base = `fingerprints.${id}`;
        // Migration: if the old flat state exists (type 'state'), remove it so we can
        // recreate it as a channel with sub-states.
        try {
            const existing = await this.getObjectAsync(base);
            if (existing && existing.type === 'state') {
                await this.delObjectAsync(base);
            }
        } catch {
            // ignore
        }
        await this.extendObjectAsync(base, {
            type: 'channel',
            common: { name: name || `Finger ${id}` },
            native: {},
        });
        await this.extendObjectAsync(`${base}.name`, {
            type: 'state',
            common: { name: 'Name', type: 'string', role: 'text', read: true, write: false, def: '' },
            native: {},
        });
        await this.extendObjectAsync(`${base}.lastSeen`, {
            type: 'state',
            common: { name: 'Last seen', type: 'number', role: 'date', read: true, write: false, def: 0 },
            native: {},
        });
        await this.extendObjectAsync(`${base}.count`, {
            type: 'state',
            common: { name: 'Match count', type: 'number', role: 'value', read: true, write: false, def: 0 },
            native: {},
        });
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
        this.log.debug(`onMessage: command="${obj.command}"`);

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
                    { error: 'Device IP not configured (save settings first)' },
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
                this.sendTo(obj.from, obj.command, { result: `Connected to ${ip}${version}` }, obj.callback);
            } else {
                this.sendTo(obj.from, obj.command, { error: `Device not reachable at ${ip}` }, obj.callback);
            }
            return;
        }

        if (obj.command === 'getWebhookInfo') {
            const token = await this._ensureWebhookToken();
            const port = this.config.webhookPort || 8095;
            this.sendTo(obj.from, obj.command, { native: { webhookToken: token }, port }, obj.callback);
            return;
        }

        if (obj.command === 'loadFingerprints') {
            const ip = (this.config.espIp || '').trim();
            if (!ip) {
                this.sendTo(
                    obj.from,
                    obj.command,
                    { error: 'Device IP not configured (save settings first)' },
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
            const list = await client.getFingerprints();
            if (!Array.isArray(list) || list.length === 0) {
                this.sendTo(obj.from, obj.command, { error: `No fingerprints returned by ${ip}` }, obj.callback);
                return;
            }

            // Merge: keep existing rules, add missing ids, refresh names
            const existing = Array.isArray(this.config.actions) ? this.config.actions : [];
            const byId = new Map(existing.map(a => [parseInt(a.id, 10), { ...a }]));
            for (const fp of list) {
                const id = parseInt(fp.id, 10);
                if (!Number.isFinite(id)) {
                    continue;
                }
                if (byId.has(id)) {
                    byId.get(id).name = fp.name || byId.get(id).name || '';
                } else {
                    byId.set(id, {
                        id,
                        name: fp.name || '',
                        objectId: '',
                        action: 'set',
                        value: '',
                        minConfidence: '',
                    });
                }
            }
            const merged = [...byId.values()].sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
            this.sendTo(obj.from, obj.command, { native: { actions: merged } }, obj.callback);
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

        // Access log + history
        const accessText = `Access granted: ${event.name || `id ${event.id}`} (id=${event.id}, confidence=${event.confidence})`;
        if (this.config.accessLogging) {
            this.log.info(accessText);
        }
        await this.setStateAsync('lastAccess.text', { val: accessText, ack: true });
        await this.setStateAsync('lastAccess.granted', { val: true, ack: true });
        await this.setStateAsync('lastAccess.timestamp', { val: ts, ack: true });
        await this.setStateAsync('stats.lastPerson', { val: event.name || '', ack: true });
        await this._incrementCounter('stats.totalMatches');

        // Per-finger history
        await this._ensureFingerObjects(event.id, event.name || `Finger ${event.id}`);
        await this.setStateAsync(`fingerprints.${event.id}.lastSeen`, { val: ts, ack: true });
        await this._incrementCounter(`fingerprints.${event.id}.count`);

        // Run the configured action for this finger, if any
        await this._runMatchAction(event);
    }

    /**
     * Increment a numeric counter state by 1.
     *
     * @param {string} id state id
     * @returns {Promise<void>} resolves when the state is written
     */
    async _incrementCounter(id) {
        const cur = await this.getStateAsync(id);
        const next = (cur && typeof cur.val === 'number' ? cur.val : 0) + 1;
        await this.setStateAsync(id, { val: next, ack: true });
    }

    async _handleRingEvent() {
        const ts = Date.now();
        await this.setStateAsync('ring.timestamp', { val: ts, ack: true });
        await this.setStateAsync('ring.ringing', { val: true, ack: true });
        this.log.info('Doorbell ring (unknown finger)');

        // Access log + history
        const accessText = 'Access denied: unknown finger';
        if (this.config.accessLogging) {
            this.log.info(accessText);
        }
        await this.setStateAsync('lastAccess.text', { val: accessText, ack: true });
        await this.setStateAsync('lastAccess.granted', { val: false, ack: true });
        await this.setStateAsync('lastAccess.timestamp', { val: ts, ack: true });
        await this._incrementCounter('stats.totalRings');

        // Run the configured ring action, if any
        await this._runRingAction();

        // Auto-reset the ring trigger after 3s
        if (this._ringResetTimer) {
            this.clearTimeout(this._ringResetTimer);
        }
        this._ringResetTimer = this.setTimeout(() => {
            this.setState('ring.ringing', { val: false, ack: true });
            this._ringResetTimer = null;
        }, 3000);
    }

    // ── Action engine ─────────────────────────────────────────────────────────

    /**
     * Find and run the configured action for a matched finger.
     *
     * @param {object} event match event with id, name, confidence
     * @returns {Promise<void>} resolves when the action completed (or was skipped)
     */
    async _runMatchAction(event) {
        const actions = Array.isArray(this.config.actions) ? this.config.actions : [];
        const rule = actions.find(a => parseInt(a.id, 10) === event.id);
        if (!rule || !rule.objectId) {
            return;
        }

        // 1) Optional confidence threshold
        const minConf =
            rule.minConfidence !== undefined && rule.minConfidence !== '' ? parseInt(rule.minConfidence, 10) : null;
        if (minConf !== null && Number.isFinite(minConf) && event.confidence < minConf) {
            this.log.info(`Action for id=${event.id} skipped: confidence ${event.confidence} < min ${minConf}`);
            return;
        }

        // 2) Optional time-based conditions
        if (rule.checkConditions && !this._isWithinConditions(event.id)) {
            this.log.info(`Action for id=${event.id} skipped: outside allowed time window`);
            return;
        }

        // 3) Optional debounce (per rule/finger)
        const debounce = rule.debounce !== undefined && rule.debounce !== '' ? parseInt(rule.debounce, 10) : 0;
        if (debounce > 0 && !this._checkDebounce(event.id, debounce)) {
            this.log.info(`Action for id=${event.id} skipped: debounce (${debounce}s)`);
            return;
        }

        // 4) Main action
        await this._applyAction(rule.objectId, rule.action || 'set', rule.value);

        // 5) Alarm (panic finger): additionally set the alarm object
        if (rule.alarm) {
            const alarmObj = (this.config.alarmActionObject || '').trim();
            if (alarmObj) {
                this.log.info(`Alarm triggered by id=${event.id} (${event.name || ''})`);
                await this._applyAction(alarmObj, 'set', this.config.alarmActionValue);
            } else {
                this.log.warn(`Alarm flag set for id=${event.id} but no alarm target object configured`);
            }
        }
    }

    /**
     * Check whether the current local time falls into any allowed condition for a finger.
     * Multiple conditions for the same finger are OR-combined. Time ranges may cross midnight.
     *
     * @param {number} fingerId fingerprint id
     * @returns {boolean} true if access is currently allowed
     */
    _isWithinConditions(fingerId) {
        const conditions = Array.isArray(this.config.conditions) ? this.config.conditions : [];
        // A condition row may list one or several finger IDs (e.g. "1,2,4")
        const forFinger = conditions.filter(c => this._parseIdList(c.fingerId).includes(fingerId));
        if (forFinger.length === 0) {
            return false; // conditions enforced but none defined → deny
        }

        const now = new Date();
        // JS: 0=Sun..6=Sat → map to our attr names
        const dayAttr = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()];
        const nowMin = now.getHours() * 60 + now.getMinutes();

        for (const c of forFinger) {
            if (!c[dayAttr]) {
                continue; // today not enabled in this row
            }
            const from = this._parseTime(c.timeFrom);
            const to = this._parseTime(c.timeTo);
            if (from === null || to === null) {
                // no/invalid time range → treat as whole day
                return true;
            }
            if (from === to) {
                return true; // full day
            }
            if (from < to) {
                if (nowMin >= from && nowMin < to) {
                    return true;
                }
            } else {
                // crosses midnight (e.g. 22:00–06:00)
                if (nowMin >= from || nowMin < to) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Parse a finger id list like "1,2,4" (or a single number) into an array of numbers.
     *
     * @param {string|number} value raw fingerId cell value
     * @returns {number[]} list of finger ids
     */
    _parseIdList(value) {
        if (value === undefined || value === null || value === '') {
            return [];
        }
        return String(value)
            .split(',')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => Number.isFinite(n));
    }

    /**
     * Parse "HH:MM" into minutes since midnight, or null if empty/invalid.
     *
     * @param {string} str time string
     * @returns {number|null} minutes since midnight or null
     */
    _parseTime(str) {
        if (!str || typeof str !== 'string') {
            return null;
        }
        const m = str.trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!m) {
            return null;
        }
        const h = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        if (h > 23 || min > 59) {
            return null;
        }
        return h * 60 + min;
    }

    /**
     * Debounce check per finger. Returns true if enough time has passed since the last
     * accepted action for this finger, and records the current time.
     *
     * @param {number} fingerId fingerprint id
     * @param {number} seconds debounce window in seconds
     * @returns {boolean} true if the action may run
     */
    _checkDebounce(fingerId, seconds) {
        if (!this._lastActionTime) {
            this._lastActionTime = {};
        }
        const now = Date.now();
        const last = this._lastActionTime[fingerId] || 0;
        if (now - last < seconds * 1000) {
            return false;
        }
        this._lastActionTime[fingerId] = now;
        return true;
    }

    /**
     * Run the configured ring action (unknown finger), if any.
     *
     * @returns {Promise<void>} resolves when the action completed (or was skipped)
     */
    async _runRingAction() {
        const objectId = (this.config.ringActionObject || '').trim();
        if (!objectId) {
            return;
        }
        await this._applyAction(objectId, 'set', this.config.ringActionValue);
    }

    /**
     * Apply an action to a foreign ioBroker state, coercing the value to the target type.
     *
     * @param {string} objectId target state id
     * @param {string} action 'set' or 'toggle'
     * @param {string} rawValue raw value string (for 'set')
     * @returns {Promise<void>} resolves when the state was written
     */
    async _applyAction(objectId, action, rawValue) {
        try {
            const obj = await this.getForeignObjectAsync(objectId);
            if (!obj) {
                this.log.warn(`Action target "${objectId}" not found`);
                return;
            }
            const type = (obj.common && obj.common.type) || 'mixed';

            let value;
            if (action === 'toggle') {
                const cur = await this.getForeignStateAsync(objectId);
                const curVal = cur ? cur.val : undefined;
                if (type === 'number') {
                    value = Number(curVal) ? 0 : 1;
                } else {
                    value = !this._toBool(curVal);
                }
            } else {
                value = this._coerceValue(rawValue, type);
            }

            await this.setForeignStateAsync(objectId, { val: value, ack: false });
            this.log.info(`Action: ${objectId} = ${JSON.stringify(value)} (${action})`);
        } catch (err) {
            this.log.error(`Action on "${objectId}" failed: ${err.message}`);
        }
    }

    /**
     * Interpret a value as boolean (true/1/on/yes/ja/да => true).
     *
     * @param {boolean|number|string} v value
     * @returns {boolean} boolean interpretation
     */
    _toBool(v) {
        if (typeof v === 'boolean') {
            return v;
        }
        if (typeof v === 'number') {
            return v !== 0;
        }
        const s = String(v).trim().toLowerCase();
        return s === 'true' || s === '1' || s === 'on' || s === 'yes' || s === 'ja' || s === 'да';
    }

    /**
     * Coerce a raw string value to the target state's type.
     *
     * @param {string} rawValue raw value (e.g. "true", "1", "on", "42", "text")
     * @param {string} type target common.type ('boolean', 'number', 'string', ...)
     * @returns {boolean|number|string} coerced value
     */
    _coerceValue(rawValue, type) {
        const raw = rawValue === undefined || rawValue === null ? '' : String(rawValue);
        if (type === 'boolean') {
            return this._toBool(raw);
        }
        if (type === 'number') {
            const n = parseFloat(raw.replace(',', '.'));
            return Number.isFinite(n) ? n : 0;
        }
        // string / mixed: keep as-is
        return raw;
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

        // lastAccess channel (access log)
        await this.extendObjectAsync('lastAccess', {
            type: 'channel',
            common: { name: 'Last access' },
            native: {},
        });
        await this.extendObjectAsync('lastAccess.text', {
            type: 'state',
            common: { name: 'Last access (readable)', type: 'string', role: 'text', read: true, write: false, def: '' },
            native: {},
        });
        await this.extendObjectAsync('lastAccess.granted', {
            type: 'state',
            common: {
                name: 'Last access granted',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.extendObjectAsync('lastAccess.timestamp', {
            type: 'state',
            common: { name: 'Last access timestamp', type: 'number', role: 'date', read: true, write: false, def: 0 },
            native: {},
        });

        // stats channel
        await this.extendObjectAsync('stats', {
            type: 'channel',
            common: { name: 'Statistics' },
            native: {},
        });
        await this.extendObjectAsync('stats.totalMatches', {
            type: 'state',
            common: { name: 'Total matches', type: 'number', role: 'value', read: true, write: false, def: 0 },
            native: {},
        });
        await this.extendObjectAsync('stats.totalRings', {
            type: 'state',
            common: { name: 'Total rings', type: 'number', role: 'value', read: true, write: false, def: 0 },
            native: {},
        });
        await this.extendObjectAsync('stats.lastPerson', {
            type: 'state',
            common: { name: 'Last recognized person', type: 'string', role: 'text', read: true, write: false, def: '' },
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
