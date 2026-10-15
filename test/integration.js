'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');
const { tests } = require('@iobroker/testing');
const { AES_PREFIX } = require('../lib/secrets');
const controller = require('./helpers/controller-crypto');
const { startDevice } = require('./helpers/fake-device');
const { startServer } = require('./helpers/sftp-server');

const INSTANCE = 'system.adapter.fingerprint.0';
const PASSWORD = 'pw1';
const TOKEN = 'a3f09c1e7b2d4c5f8e6a9b0c1d2e3f405162738495a6b7c8';

// Run integration tests
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Secrets stored as plain text (before encryptedNative)', getHarness => {
            let harness;
            before(() => {
                harness = getHarness();
            });

            it('are encrypted on start and decrypt to the original values', async function () {
                this.timeout(60000);
                // changeAdapterConfig() would encrypt encryptedNative fields itself, so the plain
                // text values of an older release are written into the instance object directly
                const obj = await harness.objects.getObjectAsync(INSTANCE);
                obj.native.adminPassword = PASSWORD;
                obj.native.webhookToken = TOKEN;
                obj.native.espIp = '';
                obj.native.webhookPort = 18095;
                await harness.objects.setObjectAsync(INSTANCE, obj);

                await harness.startAdapterAndWait();

                let stored;
                for (let i = 0; i < 40; i++) {
                    stored = (await harness.objects.getObjectAsync(INSTANCE)).native;
                    if (stored.adminPassword !== PASSWORD && stored.webhookToken !== TOKEN) {
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                const secret = (await harness.objects.getObjectAsync('system.config')).native.secret;

                assert.notEqual(stored.adminPassword, PASSWORD, 'adminPassword is still plain text');
                assert.notEqual(stored.webhookToken, TOKEN, 'webhookToken is still plain text');
                if (/^[0-9a-f]{48}$/.test(secret)) {
                    assert.ok(stored.adminPassword.startsWith(AES_PREFIX));
                    assert.ok(stored.webhookToken.startsWith(AES_PREFIX));
                }
                assert.equal(controller.decrypt(secret, stored.adminPassword), PASSWORD);
                assert.equal(controller.decrypt(secret, stored.webhookToken), TOKEN);
            });
        });

        suite('Webhook token of a new instance', getHarness => {
            let harness;
            before(() => {
                harness = getHarness();
            });

            it('stores a newly generated webhook token encrypted', async function () {
                this.timeout(60000);
                const obj = await harness.objects.getObjectAsync(INSTANCE);
                obj.native.adminPassword = '';
                obj.native.webhookToken = '';
                obj.native.espIp = '';
                obj.native.webhookPort = 18095;
                await harness.objects.setObjectAsync(INSTANCE, obj);

                await harness.startAdapterAndWait();

                let stored = '';
                for (let i = 0; i < 40 && !stored; i++) {
                    stored = (await harness.objects.getObjectAsync(INSTANCE)).native.webhookToken;
                    if (!stored) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                }
                const secret = (await harness.objects.getObjectAsync('system.config')).native.secret;

                assert.ok(stored, 'no webhook token was generated');
                assert.match(controller.decrypt(secret, stored), /^[0-9a-f]{48}$/);
            });
        });

        suite('Backup copied to an external server (SFTP)', getHarness => {
            let harness;
            let device;
            let sftp;
            let disk;
            before(async () => {
                harness = getHarness();
                device = await startDevice([
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ]);
                disk = { files: new Map(), directories: new Set(['/']) };
                sftp = await startServer(disk);
            });
            after(() => {
                device.close();
                sftp.close();
            });

            it('saves the backup made by hand and copies it to the SFTP server', async function () {
                this.timeout(60000);
                // changeAdapterConfig() encrypts the encryptedNative fields (remotePassword) like the admin does
                await harness.changeAdapterConfig('fingerprint', {
                    native: {
                        espIp: '127.0.0.1',
                        espPort: device.port,
                        webhookPort: 18097,
                        pollingEnabled: false,
                        remoteEnabled: true,
                        remoteHost: '127.0.0.1',
                        remotePort: sftp.port,
                        remoteUser: 'backup',
                        remotePassword: 'secret',
                        remoteDirectory: '/backups/fingerprint',
                        remoteHostKey: sftp.fingerprint,
                    },
                });
                await harness.startAdapterAndWait();
                await harness.enableSendTo();

                const answer = await new Promise(resolve =>
                    harness.sendTo('fingerprint.0', 'backupFingerprints', {}, resolve),
                );
                assert.ok(answer && answer.result, `unexpected answer: ${JSON.stringify(answer)}`);
                assert.match(answer.result, /Backup saved: 2 finger\(s\); copied to the external server/);

                const copies = [...disk.files.keys()].filter(p => p.startsWith('/backups/fingerprint/'));
                assert.equal(copies.length, 1, `files on the server: ${[...disk.files.keys()].join(', ')}`);
                assert.match(copies[0], /\/fingerprint-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
                assert.equal(disk.files.get(copies[0]).toString('utf8'), device.backupJson);

                const lastRemote = await harness.states.getStateAsync('fingerprint.0.info.lastRemoteBackup');
                assert.equal(lastRemote && lastRemote.val, copies[0]);
                const error = await harness.states.getStateAsync('fingerprint.0.info.remoteBackupError');
                assert.equal(error && error.val, '');
                const lastBackup = await harness.states.getStateAsync('fingerprint.0.info.lastBackup');
                assert.ok(lastBackup && lastBackup.val > 0);
            });
        });
    },
});
