'use strict';

/*
 * Self-check: node test/self-check.js
 *
 * Covers the four acceptance areas from the design:
 *   1. sealed vault + master-key mismatch + concurrent state writes
 *   2. persisted sliding-window budget under 20 concurrent reservations
 *   3. 429 -> COOLDOWN, 403/10000 -> QUARANTINED, ranking skips cooled accounts
 *   4. fail-closed proxy path (closed port => ERR_PROXY_UNAVAILABLE, no request)
 * plus the multipart worker upload and config clamp helpers.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { once, EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const {
  createMatrix,
  evaluateResponseRisk,
  buildMultipart,
  normalizeConfig,
  headerValue,
  polymorphWorkerScript,
  isPolymorphized,
  generateSafeResourceName,
  resourceNameIsSafe,
  matrixSlotIdForPort,
  egressPortForSlotId,
  controlAuthorization,
  RiskError,
  ProxyUnavailableError,
} = require('../index');

const MASTER_KEY = 'self-check-master-key-0123456789abcdef';
const results = { passed: [], failed: [] };

async function check(name, fn) {
  try {
    await fn();
    results.passed.push(name);
    process.stdout.write(`PASS  ${name}\n`);
  } catch (error) {
    results.failed.push({ name, error });
    process.stderr.write(`FAIL  ${name}\n      ${(error.stack || error.message).split('\n').join('\n      ')}\n`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fakeResponse({ status = 200, body = { success: true, result: {} } } = {}) {
  const text = JSON.stringify(body);
  const headers = {
    'cf-ray': 'selfcheck-LHR',
    'ratelimit-remaining': '900',
    get(name) {
      return this[String(name).toLowerCase()] ?? null;
    },
    has(name) {
      return this[String(name).toLowerCase()] !== undefined;
    },
    forEach(fn) {
      for (const [key, value] of Object.entries(this)) {
        if (typeof value !== 'function') fn(value, key);
      }
    },
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers,
    text: async () => text,
    json: async () => JSON.parse(text),
    buffer: async () => Buffer.from(text),
    arrayBuffer: async () => Buffer.from(text),
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-matrix-selfcheck-'));
  const transportCalls = [];
  const createTransport = (port) => ({
    port,
    state: 'open',
    async fetch(input, init) {
      transportCalls.push({ port, input, init });
      return fakeResponse();
    },
    close() {},
    quarantine() {},
    release() {},
    isQuarantined() {
      return false;
    },
  });

  const config = {
    portStart: 1,
    portEnd: 65535,
    probe: { ttlMs: 30000, tcpTimeoutMs: 500, url: 'https://www.cloudflare.com/cdn-cgi/trace' },
    risk: {
      rps: 100,
      burst: 1000,
      windowLimit: 5,
      windowMs: 300000,
      windowBucketMs: 10000,
      jitter: { minMs: 0, maxMs: 0 },
      backoff: { baseMs: 1000, maxMs: 5000, jitterMinMs: 0, jitterMaxMs: 0 },
    },
    http: { timeoutMs: 2000, maxRetries: 0 },
  };

  const matrix = createMatrix({
    dataDir,
    masterKey: MASTER_KEY,
    config,
    createTransport,
    random: () => 0.5,
    sleep: () => Promise.resolve(),
  });

  await check('vault seals tokens and never writes them in plaintext', async () => {
    const token = 'cf-token-abcdefghijklmnopqrstuvwxyz-0123456789';
    const account = await matrix.vault.add({
      id: 'alpha',
      label: 'alpha',
      authType: 'token',
      token,
      proxyPort: 24001,
      tags: ['selfcheck'],
    });
    assert.equal(account.hasToken, true);
    const credentials = matrix.vault.credentials('alpha');
    assert.equal(credentials.token, token);
    const raw = fs.readFileSync(matrix.vault.vaultPath, 'utf8');
    assert.equal(raw.includes(token), false, 'plaintext token leaked into cf-accounts.json');
    assert.match(raw, /v1\./);
  });

  await check('vault public views never expose sealed material', async () => {
    const [profile] = matrix.vault.list();
    assert.equal(profile.hasToken, true);
    assert.equal(profile.token, undefined);
    assert.equal(profile.apiKey, undefined);
    const snapshot = matrix.vault.snapshot();
    assert.equal(JSON.stringify(snapshot).includes('v1.'), false);
  });

  await check('20 concurrent state mutations do not lose an update', async () => {
    const total = await Promise.all(
      Array.from({ length: 20 }, () =>
        matrix.vault.mutateState('alpha', async (state) => {
          const current = Number(state.counter || 0);
          await sleep(1);
          state.counter = current + 1;
          return state.counter;
        }),
      ),
    );
    assert.equal(Math.max(...total), 20);
    assert.equal(matrix.vault.state('alpha').counter, 20);
  });

  await check('window budget allows exactly 5 of 20 concurrent reservations', async () => {
    await matrix.vault.add({
      id: 'budget',
      label: 'budget',
      authType: 'token',
      token: 'cf-token-budget-abcdefghijklmnopqrstuvwxyz-012345',
      proxyPort: 24002,
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () => matrix.risk.acquire('budget', { urgent: true })),
    );
    const fulfilled = outcomes.filter((entry) => entry.status === 'fulfilled');
    const rejected = outcomes.filter((entry) => entry.status === 'rejected');
    assert.equal(fulfilled.length, 5);
    assert.equal(rejected.length, 15);
    assert.ok(
      rejected.every((entry) => entry.reason.code === 'RISK_WINDOW_EXHAUSTED'),
      `unexpected rejection codes: ${rejected.map((entry) => entry.reason.code).join(',')}`,
    );
    const state = matrix.vault.state('budget');
    const used = state.budget.buckets.reduce((sum, bucket) => sum + bucket[1], 0);
    assert.equal(used, 5);
  });

  await check('429 with Retry-After moves the account to COOLDOWN and skips it in ranking', async () => {
    await matrix.vault.add({
      id: 'cooldown',
      label: 'cooldown',
      authType: 'token',
      token: 'cf-token-cooldown-abcdefghijklmnopqrstuvwxyz-0123',
      proxyPort: 24003,
      tags: ['pool'],
    });
    await matrix.vault.add({
      id: 'healthy',
      label: 'healthy',
      authType: 'token',
      token: 'cf-token-healthy-abcdefghijklmnopqrstuvwxyz-01234',
      proxyPort: 24004,
      tags: ['pool'],
    });
    const verdict = await matrix.risk.report('cooldown', {
      status: 429,
      headers: { 'retry-after': '60', 'cf-ray': 'selfcheck-429' },
      body: { success: false, errors: [{ code: 1015, message: 'rate limited' }] },
    });
    assert.equal(verdict.action, 'RETRY_ON_OTHER_ACCOUNT');
    const state = matrix.vault.state('cooldown');
    assert.equal(state.status, 'COOLDOWN');
    assert.ok(state.cooldownUntil >= Date.now() + 59000, 'Retry-After was not honoured');
    await assert.rejects(matrix.risk.acquire('cooldown'), (error) => {
      assert.equal(error.code, 'RISK_COOLDOWN');
      assert.ok(error.retryAfterMs > 0);
      return true;
    });
    const pick = matrix.client.selectOptimalAccount({ tag: 'pool', requiredQuota: 1 });
    assert.ok(pick, 'no account selected');
    assert.notEqual(pick.id, 'cooldown');
    assert.equal(pick.id, 'healthy');
  });

  await check('403 with error code 10000 permanently QUARANTINEs the account', async () => {
    await matrix.vault.add({
      id: 'banned',
      label: 'banned',
      authType: 'token',
      token: 'cf-token-banned-abcdefghijklmnopqrstuvwxyz-012345',
      proxyPort: 24005,
    });
    const verdict = await matrix.risk.report('banned', {
      status: 403,
      headers: { 'cf-ray': 'selfcheck-403' },
      body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
    });
    assert.equal(verdict.action, 'ABORT_AND_ISOLATE');
    assert.equal(matrix.vault.state('banned').status, 'QUARANTINED');
    await assert.rejects(matrix.risk.acquire('banned'), (error) => {
      assert.equal(error.code, 'RISK_QUARANTINED');
      return true;
    });
  });

  await check('fail-closed: closed proxy port blocks before any fetch', async () => {
    await matrix.vault.add({
      id: 'dead',
      label: 'dead',
      authType: 'token',
      token: 'cf-token-dead-abcdefghijklmnopqrstuvwxyz-01234567',
      proxyPort: 1,
    });
    const before = transportCalls.length;
    await assert.rejects(
      matrix.net.request('dead', 'https://api.cloudflare.com/client/v4/user/tokens/verify'),
      (error) => {
        assert.ok(error instanceof ProxyUnavailableError);
        assert.equal(error.code, 'ERR_PROXY_UNAVAILABLE');
        return true;
      },
    );
    assert.equal(transportCalls.length, before, 'transport was called despite unreachable proxy');
    assert.equal(matrix.net.failClosed, true);
  });

  await check('reachable proxy path uses the bound transport with a stable fingerprint', async () => {
    const listener = net.createServer((socket) => socket.end());
    const port = await listen(listener);
    try {
      await matrix.vault.add({
        id: 'live',
        label: 'live',
        authType: 'token',
        token: 'cf-token-live-abcdefghijklmnopqrstuvwxyz-01234567',
        proxyPort: port,
      });
      const response = await matrix.net.request('live', 'https://api.cloudflare.com/client/v4/user');
      assert.equal(response.status, 200);
      const call = transportCalls.find((entry) => entry.input.endsWith('/user'));
      assert.ok(call, 'bound transport was not used');
      assert.equal(call.port, port);
      assert.match(call.init.headers['user-agent'], /^openchamber-cf-matrix\/1\.0/);
      assert.equal(call.init.headers.accept, 'application/json');
    } finally {
      listener.close();
    }
  });

  await check('pure classifier: 401 isolates, 200 returns ACTIVE', async () => {
    const state = { status: 'ACTIVE', strikes: 2, healthScore: 50, updatedAt: 0 };
    const isolated = evaluateResponseRisk(state, 401, { 'cf-ray': 'x' }, { errors: [] }, { risk: config.risk });
    assert.equal(isolated.action, 'ABORT_AND_ISOLATE');
    assert.equal(state.status, 'QUARANTINED');

    const healthy = { status: 'COOLDOWN', strikes: 3, healthScore: 20, cooldownUntil: 1, updatedAt: 0 };
    const passed = evaluateResponseRisk(healthy, 200, { 'cf-ray': 'y' }, { success: true }, { risk: config.risk });
    assert.equal(passed.action, 'PASS');
    assert.equal(healthy.status, 'ACTIVE');
    assert.equal(healthy.strikes, 2);
    assert.equal(healthy.cooldownUntil, 0);
  });

  await check('sliding window prunes old buckets', async () => {
    await matrix.vault.mutateState('budget', (state) => {
      state.budget = { buckets: [[Date.now() - 400000, 99], [Date.now(), 1]] };
    });
    const snapshot = matrix.risk.snapshot('budget');
    assert.equal(snapshot.window.used, 1);
  });

  await check('master key mismatch is rejected', async () => {
    assert.throws(
      () =>
        createMatrix({
          dataDir,
          masterKey: 'a-completely-different-master-key-000000',
          config,
          createTransport,
        }),
      (error) => error.code === 'ERR_VAULT_KEY_MISMATCH',
    );
  });

  await check('multipart worker upload has metadata and module parts', async () => {
    const multipart = buildMultipart([
      { name: 'metadata', contentType: 'application/json', value: '{"main_module":"worker.js"}' },
      {
        name: 'worker.js',
        filename: 'worker.js',
        contentType: 'application/javascript+module',
        value: 'export default { fetch() { return new Response("ok"); } }',
      },
    ]);
    const text = multipart.body.toString('utf8');
    assert.match(multipart.contentType, /^multipart\/form-data; boundary=/);
    assert.match(text, /name="metadata"/);
    assert.match(text, /name="worker\.js"; filename="worker\.js"/);
    assert.match(text, /application\/javascript\+module/);
  });

  await check('config normalisation clamps inverted port ranges', async () => {
    const normalized = normalizeConfig({ portStart: 30000, portEnd: 20000 });
    assert.equal(normalized.portEnd, 30000);
    const header = headerValue({ 'CF-Ray': 'abc' }, 'cf-ray');
    assert.equal(header, 'abc');
  });

  await check('risk alerts fire for cooldown and quarantine', async () => {
    const alerts = [];
    matrix.events.on('risk', (alert) => alerts.push(alert.type));
    await matrix.vault.add({
      id: 'alert',
      label: 'alert',
      authType: 'token',
      token: 'cf-token-alert-abcdefghijklmnopqrstuvwxyz-0123456',
      proxyPort: 24006,
    });
    await matrix.risk.report('alert', {
      status: 429,
      headers: { 'retry-after': '1' },
      body: { errors: [{ code: 1015 }] },
    });
    await matrix.vault.add({
      id: 'alert2',
      label: 'alert2',
      authType: 'token',
      token: 'cf-token-alert2-abcdefghijklmnopqrstuvwxyz-012345',
      proxyPort: 24007,
    });
    await matrix.risk.report('alert2', {
      status: 403,
      headers: {},
      body: { errors: [{ code: 9109 }] },
    });
    assert.deepEqual(alerts.sort(), ['cooldown', 'quarantine']);
  });

  await check('cross-process vault additions keep every account', async () => {
    const crossDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-matrix-cross-'));
    const entry = require.resolve('../index');
    const children = Array.from({ length: 8 }, (_, index) => {
      const script = `
        const { createMatrix } = require(${JSON.stringify(entry)});
        const matrix = createMatrix({});
        matrix.vault.add({
          id: 'proc${index}',
          label: 'proc${index}',
          authType: 'token',
          token: 'cf-token-cross-${index}-abcdefghijklmnopqrstuvwxyz',
          proxyPort: ${24101 + index},
        }).then(() => { matrix.close(); }).catch((error) => {
          console.error(error.stack || error.message);
          process.exitCode = 1;
        });
      `;
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], {
          env: {
            ...process.env,
            CF_MATRIX_MASTER_KEY: MASTER_KEY,
            CF_MATRIX_DATA_DIR: crossDir,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`child ${index} exited ${code}: ${stderr.trim()}`));
        });
      });
    });
    try {
      await Promise.all(children);
      const probe = createMatrix({
        dataDir: crossDir,
        masterKey: MASTER_KEY,
        config,
        createTransport,
        sleep: () => Promise.resolve(),
      });
      try {
        const accounts = probe.vault.list();
        assert.equal(accounts.length, 8);
        assert.deepEqual(
          accounts.map((account) => account.id).sort(),
          Array.from({ length: 8 }, (_, index) => `proc${index}`).sort(),
        );
      } finally {
        probe.close();
      }
    } finally {
      fs.rmSync(crossDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  await check('config.accounts seeds only after matrix.ready resolves', async () => {
    const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-matrix-seed-'));
    const seeded = createMatrix({
      dataDir: seedDir,
      masterKey: MASTER_KEY,
      config: {
        ...config,
        accounts: [
          {
            id: 'seed',
            label: 'seed',
            authType: 'token',
            token: 'cf-token-seed-abcdefghijklmnopqrstuvwxyz-012345',
            proxyPort: 24050,
          },
        ],
      },
      createTransport,
      random: () => 0.5,
      sleep: () => Promise.resolve(),
    });
    try {
      await seeded.ready;
      const profile = seeded.vault.get('seed');
      assert.equal(profile.label, 'seed');
      assert.equal(profile.proxyPort, 24050);
      assert.equal(seeded.vault.snapshot().accounts.length, 1);
    } finally {
      seeded.close();
      fs.rmSync(seedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  await check('client rejects absolute URLs outside apiBase', async () => {
    await assert.rejects(
      matrix.client.requestOnce('alpha', 'https://evil.example/collect'),
      (error) => error.code === 'ERR_URL_SCOPE',
    );
  });

  await check('polymorph: same logic, distinct deployment hash and safe names', async () => {
    const source = 'export default { fetch() { return new Response("ok"); } }';
    const accountA = 'a'.repeat(32);
    const accountB = 'b'.repeat(32);
    const deployedA = polymorphWorkerScript(source, accountA);
    const deployedB = polymorphWorkerScript(source, accountB);
    assert.equal(isPolymorphized(deployedA), true);
    assert.equal(isPolymorphized(deployedB), true);
    const sha = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    assert.notEqual(sha(deployedA), sha(deployedB), 'polymorph output is identical across accounts');
    assert.equal(deployedA.includes('new Response("ok")'), true);

    const safe = generateSafeResourceName('edgetunnel-vless-proxy-scan-vm1', 'slot-002');
    assert.equal(resourceNameIsSafe(safe), true);
    for (const banned of ['edgetunnel', 'vless', 'proxy', 'scan']) {
      assert.equal(safe.toLowerCase().includes(banned), false, `${banned} leaked into "${safe}"`);
    }
  });

  await check('slot contract: 1:1 port mapping and strict-control credentials', async () => {
    assert.equal(matrixSlotIdForPort(24001), 'slot-001');
    assert.equal(matrixSlotIdForPort(24250), 'slot-250');
    assert.equal(matrixSlotIdForPort(24000), null);
    assert.equal(matrixSlotIdForPort(24251), null);
    assert.equal(egressPortForSlotId('slot-250'), 24250);
    assert.equal(
      controlAuthorization('slot-001'),
      `Basic ${Buffer.from('slot-001:STRICT_CONTROL').toString('base64')}`,
    );
    const alpha = matrix.vault.get('alpha');
    assert.equal(alpha.matrixSlotId, 'slot-001');
    assert.equal(alpha.egressPort, 24001);
    await assert.rejects(
      matrix.vault.add({
        id: 'mismatch',
        label: 'mismatch',
        authType: 'token',
        token: 'cf-token-mismatch-abcdefghijklmnopqrstuvwxyz-0123',
        proxyPort: 24002,
        matrixSlotId: 'slot-003',
      }),
      (error) => error.code === 'ERR_PROFILE',
    );
  });

  await check('WARP_OVERFLOW fails closed and PRE_ROTATION_FREEZE drains the pool', async () => {
    const t0Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-matrix-t0-'));
    let health = 'WARP_OVERFLOW';
    const sent = [];
    const transports = [];
    const egressSlots = () => ({
      slots: [
        {
          matrixSlotId: 'slot-222',
          egressPort: 24222,
          routingPlane: 'STRICT_CONTROL',
          healthState: health,
          leaseId: 'lease-1',
          egressFingerprint: {
            exitIp: '203.0.113.7',
            ipv6Prefix64: '2001:db8:1::/64',
            asn: 13335,
            leaseId: 'lease-1',
            updatedAt: Date.now(),
          },
        },
      ],
    });
    const busEvents = new EventEmitter();
    const fakeBus = {
      enabled: true,
      events: busEvents,
      getEgressState: egressSlots,
      start() {},
      stop() {},
      status: () => ({ enabled: true, connected: true }),
    };
    const listener = net.createServer((socket) => socket.end());
    await new Promise((resolve) => listener.listen(24222, '127.0.0.1', resolve));
    const t0 = createMatrix({
      dataDir: t0Dir,
      masterKey: MASTER_KEY,
      config,
      egressBus: fakeBus,
      createTransport: (port, transportOptions) => {
        const transport = {
          port,
          options: transportOptions,
          state: 'open',
          drainCalls: 0,
          async fetch(input, init) {
            sent.push({ port, input, init });
            return fakeResponse();
          },
          drain() {
            this.drainCalls += 1;
          },
          close() {},
          quarantine() {},
          release() {},
          isQuarantined() {
            return false;
          },
        };
        transports.push(transport);
        return transport;
      },
      sleep: () => Promise.resolve(),
    });
    try {
      await t0.vault.add({
        id: 'slot1',
        label: 'slot1',
        authType: 'token',
        token: 'cf-token-slot1-abcdefghijklmnopqrstuvwxyz-01234567',
        proxyPort: 24222,
      });
      await assert.rejects(
        t0.net.request('slot1', 'https://api.cloudflare.com/client/v4/user'),
        (error) => {
          assert.equal(error.code, 'ERR_EGRESS_UNSAFE_FOR_CF_CONTROL');
          assert.equal(error.matrixSlotId, 'slot-222');
          assert.equal(error.healthState, 'WARP_OVERFLOW');
          return true;
        },
      );
      assert.equal(sent.length, 0, 'request escaped while the slot was in WARP_OVERFLOW');

      health = 'ACTIVE';
      const response = await t0.net.request('slot1', 'https://api.cloudflare.com/client/v4/user');
      assert.equal(response.status, 200);
      assert.equal(sent.length, 1);
      const transport = transports[transports.length - 1];
      assert.equal(transport.options.proxyAuth, controlAuthorization('slot-222'));
      assert.equal(transport.options.routingHeaders['x-oc-matrix-slot'], 'slot-222');
      assert.equal(transport.options.routingHeaders['x-oc-routing-plane'], 'STRICT_CONTROL');

      busEvents.emit('freeze', {
        type: 'PRE_ROTATION_FREEZE',
        matrixSlotId: 'slot-222',
        eventId: 'evt-1',
      });
      assert.equal(transport.drainCalls, 1, 'PRE_ROTATION_FREEZE did not drain the slot pool');
      const resumed = await t0.net.request('slot1', 'https://api.cloudflare.com/client/v4/user');
      assert.equal(resumed.status, 200);

      health = 'ROTATING';
      await assert.rejects(
        t0.net.request('slot1', 'https://api.cloudflare.com/client/v4/user'),
        (error) => error.code === 'ERR_EGRESS_UNSAFE_FOR_CF_CONTROL',
      );
    } finally {
      t0.close();
      listener.close();
      fs.rmSync(t0Dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  await check('cf.tunnel.provision returns the full instabox contract and seals the token', async () => {
    const tunnelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-matrix-tunnel-'));
    const listener = net.createServer((socket) => socket.end());
    await new Promise((resolve) => listener.listen(24010, '127.0.0.1', resolve));
    const routes = [];
    let dnsCreated = false;
    const createTransport = (port) => ({
      port,
      state: 'open',
      async fetch(input, init) {
        const url = new URL(String(input));
        const method = String(init.method || 'GET').toUpperCase();
        const at = url.pathname;
        routes.push(`${method} ${at}${url.search}`);
        const reply = (body, status = 200) => fakeResponse({ status, body });
        if (method === 'GET' && at.endsWith('/zones')) {
          return reply({
            success: true,
            result: [{ id: 'zone-1', name: 'example.com', status: 'active' }],
          });
        }
        if (method === 'POST' && /\/cfd_tunnel$/.test(at)) {
          return reply({
            success: true,
            result: { id: 'tun-1', name: 'instabox-vm1', token: 'tunnel-token-1' },
          });
        }
        if (method === 'GET' && /\/cfd_tunnel$/.test(at)) {
          return reply({ success: true, result: [] });
        }
        if (method === 'PUT' && at.endsWith('/configurations')) {
          return reply({ success: true, result: { config: JSON.parse(String(init.body)).config } });
        }
        if (method === 'GET' && at.endsWith('/dns_records')) {
          return reply({
            success: true,
            result: dnsCreated
              ? [
                  {
                    id: 'rec-1',
                    name: 'vm1.example.com',
                    type: 'CNAME',
                    content: 'tun-1.cfargotunnel.com',
                  },
                ]
              : [],
          });
        }
        if (method === 'POST' && at.endsWith('/dns_records')) {
          dnsCreated = true;
          const body = JSON.parse(String(init.body));
          return reply({ success: true, result: { id: 'rec-1', ...body } });
        }
        if (method === 'DELETE' && at.endsWith('/dns_records/rec-1')) {
          dnsCreated = false;
          return reply({ success: true, result: { id: 'rec-1' } });
        }
        return reply({ success: true, result: { id: 'tun-1' } });
      },
      drain() {},
      close() {},
      quarantine() {},
      release() {},
      isQuarantined() {
        return false;
      },
    });
    const tunneled = createMatrix({
      dataDir: tunnelDir,
      masterKey: MASTER_KEY,
      config: { ...config, risk: { ...config.risk, windowLimit: 950 } },
      createTransport,
      sleep: () => Promise.resolve(),
    });
    try {
      await tunneled.vault.add({
        id: 'slot10',
        label: 'slot10',
        authType: 'token',
        token: 'cf-token-slot10-abcdefghijklmnopqrstuvwxyz-0123456',
        cloudflareAccountId: 'c'.repeat(32),
        proxyPort: 24010,
      });
      const result = await tunneled.rpc.handle('cf.tunnel.provision', {
        matrixSlotId: 'slot-010',
        vmInstanceId: 'vm1',
        localPort: 8080,
        domainZone: 'example.com',
        tunnelName: 'instabox-vm1',
        publicHostname: 'vm1.example.com',
      });
      assert.equal(result.matrixSlotId, 'slot-010');
      assert.equal(result.egressPort, 24010);
      assert.equal(result.tunnelId, 'tun-1');
      assert.equal(result.tunnelToken, 'tunnel-token-1');
      assert.equal(result.publicHostname, 'vm1.example.com');
      assert.equal(result.cfRay, 'selfcheck-LHR');
      assert.equal(result.dns.created.length, 1);
      assert.ok(
        routes.some(
          (line) =>
            line.startsWith('POST ') &&
            line.includes(`/accounts/${'c'.repeat(32)}/cfd_tunnel`),
        ),
        `tunnel create route missing: ${routes.join(' | ')}`,
      );
      assert.ok(
        routes.some((line) => line.startsWith('POST ') && line.includes('/zones/zone-1/dns_records')),
        `dns create route missing: ${routes.join(' | ')}`,
      );

      const state = tunneled.vault.state('slot10');
      const record = state.tunnels['tun-1'];
      assert.ok(record, 'tunnel record was not stored');
      assert.ok(record.sealedToken && record.sealedToken.startsWith('v1.'), 'token was not sealed');
      assert.equal(JSON.stringify(state).includes('tunnel-token-1'), false);
      assert.equal(record.matrixSlotId, 'slot-010');
      assert.equal(record.publicHostname, 'vm1.example.com');

      const slots = await tunneled.rpc.handle('cf.matrix.slots', {});
      const slot10 = slots.find((slot) => slot.matrixSlotId === 'slot-010');
      assert.ok(slot10, 'slot-010 missing from cf.matrix.slots');
      assert.equal(slot10.tunnels[0].tunnelId, 'tun-1');

      const torn = await tunneled.rpc.handle('cf.tunnel.teardown', { tunnelId: 'tun-1' });
      assert.equal(torn.deleted, true);
      assert.equal(torn.dnsDeleted, 1);
      assert.equal(tunneled.vault.state('slot10').tunnels['tun-1'], undefined);
    } finally {
      tunneled.close();
      listener.close();
      fs.rmSync(tunnelDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  matrix.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  const passed = results.passed.length;
  const failed = results.failed.length;
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
