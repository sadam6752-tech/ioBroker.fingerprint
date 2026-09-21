'use strict';

/**
 * Helpers for the secret attributes (`adminPassword`, `webhookToken`) of the adapter config.
 *
 * Background (v0.7.5 → v0.7.6): v0.7.5 declared these attributes as `encryptedNative`.
 * The js-controller then "decrypts" every stored value before the adapter starts. For values
 * that had been saved as plain text this produces unusable data — `tools.decrypt()` falls
 * back to a XOR with the system secret, without any warning or error. The result was that
 * device login (HTTP Basic auth) and server-mode provisioning failed after the update.
 *
 * v0.7.6 removed `encryptedNative` again (only `protectedNative` remains), so stored plain
 * text values keep working. This module additionally repairs configurations that were
 * already affected:
 *  - values stored in the `$/aes-192-cbc:` format (settings saved by Admin while
 *    `encryptedNative` was declared) are decrypted again, and
 *  - values that contain control characters (the XOR garbage) are dropped, so the webhook
 *    token is regenerated and the user is asked to re-enter the password.
 */

/**
 * Check whether a value contains control characters and therefore cannot be a real secret
 *
 * @param {string} value - value to check
 * @returns {boolean} true if the value is unusable
 */
function isBrokenSecret(value) {
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Make the stored secrets usable again (modifies `config` in place)
 *
 * @param {object} config - native configuration of the adapter
 * @param {object} logger - logger with `info`, `warn` and `error` methods
 * @param {(attr: string) => Promise<string>} [decrypt] - decrypts an encrypted config attribute
 * @returns {Promise<void>} resolves when the secrets have been checked
 */
async function normalizeSecrets(config, logger, decrypt) {
    for (const attr of ['adminPassword', 'webhookToken']) {
        let value = config[attr];
        if (typeof value !== 'string' || value === '') {
            continue;
        }

        if (value.startsWith('$/aes-192-cbc:') && typeof decrypt === 'function') {
            try {
                value = await decrypt(attr);
                logger.info(`Using the decrypted ${attr} from the instance configuration.`);
            } catch (err) {
                logger.warn(`Could not decrypt the stored ${attr}: ${err.message}`);
                value = '';
            }
        }

        if (typeof value === 'string' && isBrokenSecret(value)) {
            if (attr === 'webhookToken') {
                logger.warn('The stored webhook token was unreadable — a new one will be generated.');
            } else {
                logger.error(
                    `The stored ${attr} is unreadable (broken encryption of v0.7.5). ` +
                        'Please open the adapter settings and enter the value again.',
                );
            }
            value = '';
        }

        config[attr] = value;
    }
}

module.exports = { normalizeSecrets, isBrokenSecret };
