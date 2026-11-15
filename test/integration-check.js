'use strict';

/*
 * Integration check: node test/integration-check.js
 *
 * Runs the real cf-client through the real proxy-fetch HTTP path against a
 * loopback mock of the Cloudflare v4 API. No external network is touched.
 * It validates auth header injection, DNS idempotency, tunnel provisioning,
 * Worker multipart upload, 429 -> COOLDOWN failover and fingerprint stability.
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { createMatrix } = require('../index');

const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
const TOKEN = 'integration-token-abcdefghijklmnopqrstuvwxyz';
const requests = [];

function reply(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...headers });
  res.end(body);
}

const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    let url;
    try {
      url = new URL(req.url);
    } catch {
      return reply(res, 400, { success: false, errors: [{ code: 1, message: 'absolute-form required' }] });
    }
    const at = url.pathname;
    const query = url.searchParams;

    if (at === '/client/v4/user/tokens/verify') {
      return reply(res, 200, { success: true, result: { id: 'tok', status: 'active' } }, { 'cf-ray': 'it-verify' });
    }
    if (at === '/client/v4/zones' && req.method === 'GET') {
      if (query.get('name') === 'throttle.example') {
        return reply(res, 429, { success: false, errors: [{ code: 1015, message: 'rate limited' }] }, {
          'cf-ray': 'it-429',
          'retry-after': '30',
        });
      }
      return reply(res, 200, { success: true, result: [{ id: 'zone123', name: query.get('name'), status: 'active' }] });
    }
    if (at === '/client/v4/zones/zone123/dns_records' && req.method === 'GET') {
      return reply(res, 200, { success: true, result: [] });
    }
    if (at === '/client/v4/zones/zone123/dns_records' && req.method === 'POST') {
      return reply(res, 200, { success: true, result: { id: 'rec1', ...JSON.parse(body) } });
    }
    if (at === `/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel` && req.method === 'GET') {
      return reply(res, 200, { success: true, result: [] });
    }
    if (at === `/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel` && req.method === 'POST') {
      return reply(res, 200, { success: true, result: { id: 'tun1', name: 'edge-a', token: 'tunnel-secret-token' } });
    }
    if (at === `/client/v4/accounts/${ACCOUNT_ID}/cfd_tunnel/tun1/configurations` && req.method === 'PUT') {
      return reply(res, 200, { success: true, result: { config: JSON.parse(body).config } });
    }
    if (at === `/client/v4/accounts/${ACCOUNT_ID}/workers/scripts/demo` && req.method === 'PUT') {
      assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
      assert.match(body, /name="metadata"/);
      assert.match(body, /application\/javascript\+module/);
      return reply(res, 200, { success: true, result: { id: 'demo' } }, { etag: 'etag-demo' });
    }
    return reply(res, 404, { success: false, errors: [{ code: 7003, message: `no route ${req.method} ${at}` }] });
  });
});

async function main() {
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyPort = proxy.address().port;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-matrix-integration-'));

  const matrix = createMatrix({
    dataDir,
    masterKey: 'integration-master-key-0123456789abcdef',
    config: {
      apiBase: 'http://cf.local/client/v4',
      portStart: 1,
      portEnd: 65535,
      probe: { ttlMs: 1000, tcpTimeoutMs: 1000, url: 'http://cf.local/client/v4/user/tokens/verify' },
      risk: {
        rps: 100,
        burst: 1000,
        windowLimit: 950,
        jitter: { minMs: 0, maxMs: 0 },
        backoff: { baseMs: 1000, maxMs: 5000, jitterMinMs: 0, jitterMaxMs: 0 },
      },
      http: { timeoutMs: 5000, maxRetries: 0 },
    },
    random: () => 0.5,
    sleep: () => Promise.resolve(),
  });

  try {
    await matrix.vault.add({
      id: 'it',
      label: 'it',
      authType: 'token',
      token: TOKEN,
      cloudflareAccountId: ACCOUNT_ID,
      proxyPort,
    });

    const verify = await matrix.rpc.handle('cf.account.verify', { id: 'it' });
    assert.equal(verify.status, 'active');

    const dns = await matrix.rpc.handle('cf.dns.sync', {
      id: 'it',
      domain: 'example.com',
      records: [{ type: 'A', name: 'www', content: '203.0.113.5', proxied: true }],
    });
    assert.equal(dns.created.length, 1);
    assert.equal(dns.created[0].id, 'rec1');

    const tunnel = await matrix.rpc.handle('cf.tunnel.spawn', {
      id: 'it',
      tunnelName: 'edge-a',
      ingress: [{ hostname: 'edge.example.com', service: 'http://127.0.0.1:8080' }],
    });
    assert.equal(tunnel.tunnelId, 'tun1');
    assert.equal(tunnel.token, 'tunnel-secret-token');
    assert.equal(tunnel.ingress.length, 2);

    const worker = await matrix.rpc.handle('cf.worker.deploy', {
      id: 'it',
      scriptName: 'demo',
      code: 'export default { fetch() { return new Response("ok"); } }',
    });
    assert.equal(worker.script, 'demo');
    assert.equal(worker.etag, 'etag-demo');

    assert.equal(
      requests.every((entry) => entry.headers.authorization === `Bearer ${TOKEN}`),
      true,
      'every request must carry the account bearer token',
    );
    const agents = new Set(requests.map((entry) => entry.headers['user-agent']));
    assert.equal(agents.size, 1, `user-agent drift: ${[...agents].join(' | ')}`);

    await assert.rejects(
      matrix.client.listZones('it', { name: 'throttle.example' }),
      (error) => error.status === 429 && error.retryOther === true,
    );
    const state = matrix.vault.state('it');
    assert.equal(state.status, 'COOLDOWN');
    assert.ok(state.cooldownUntil >= Date.now() + 29000);

    process.stdout.write(
      `INTEGRATION OK  requests=${requests.length} ua="${[...agents][0]}" cooldown=${state.cooldownUntil - Date.now()}ms\n`,
    );
  } finally {
    matrix.close();
    proxy.closeAllConnections?.();
    proxy.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
