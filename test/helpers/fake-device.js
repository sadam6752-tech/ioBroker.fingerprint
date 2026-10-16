'use strict';

/**
 * A FingerprintDoorbell for integration tests: answers the HTTP endpoints the adapter calls
 * (status, fingerprint list, backup, provisioning) on a free local port.
 */

const http = require('node:http');

/**
 * Start the fake device.
 *
 * @param {Array<{id: number, name: string, template?: string}>} fingers enrolled fingers
 * @returns {Promise<{port: number, backupJson: string, requests: string[], restores: string[], close: () => void}>}
 *     the device; `restores` holds the bodies of the POST /restore requests
 */
async function startDevice(fingers) {
    const backupJson = JSON.stringify(
        fingers.map(f => ({ id: f.id, name: f.name, size: 1536, template: f.template || 'AAAA' })),
    );
    const requests = [];
    const restores = [];
    const server = http.createServer((req, res) => {
        const path = String(req.url).split('?')[0];
        requests.push(path);
        const json = body => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        if (path === '/api/status') {
            json({ version: '0.9.4', uptime: 1, freeHeap: 100000, serverMode: true, enrollState: 0 });
        } else if (path === '/api/fingerprints') {
            json(fingers.map(f => ({ id: f.id, name: f.name })));
        } else if (path === '/restore' && req.method === 'POST') {
            let body = '';
            req.setEncoding('utf8');
            req.on('data', chunk => (body += chunk));
            req.on('end', () => {
                restores.push(body);
                res.writeHead(200);
                res.end('OK');
            });
        } else if (path === '/backup') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(backupJson);
        } else {
            res.writeHead(200);
            res.end('OK');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        port: server.address().port,
        backupJson,
        requests,
        restores,
        close: () => {
            server.closeAllConnections();
            server.close();
        },
    };
}

module.exports = { startDevice };
