'use strict';

/*
 * Fresh-install check: node test/fresh-install-check.js
 *
 * Simulates a brand new OpenChamber machine: empty data dir, host-injected
 * PORT/TOKEN, no CLI init, no .env. The service must boot, create the master
 * key and config by itself, answer RPC and auto-assign the first proxy port.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const TOKEN = 'fresh-install-token-abcdefghijklmnop';
const PORT = 4700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rpc(method, params) {
  const response = await fetch(`${BASE}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ method, params: params || {} }),
  });
  const text = await response.text();
  const payload = JSON.parse(text);
  if (!payload.ok) throw new Error(`${method} failed: ${payload.error && payload.error.message}`);
  return payload.result;
}

async function waitForHealth(deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  throw new Error('service did not become healthy in time');
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-matrix-fresh-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'service', 'main.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      CF_MATRIX_DATA_DIR: dataDir,
      OPENCHAMBER_SERVICE_PORT: String(PORT),
      OPENCHAMBER_SERVICE_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  child.stdout.resume();

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  try {
    await waitForHealth(Date.now() + 15000);
    assert.equal(fs.existsSync(path.join(dataDir, 'master.key')), true, 'master.key must be auto-generated');
    assert.equal(
      fs.existsSync(path.join(dataDir, 'cf-matrix.config.json')),
      true,
      'config file must be auto-generated',
    );

    const status = await rpc('cf.matrix.status', {});
    assert.equal(status.masterKeySource, 'generated');
    assert.equal(path.resolve(status.dataDir), path.resolve(dataDir));
    assert.equal(status.accounts, 0);

    const created = await rpc('cf.account.add', {
      label: 'First account',
      token: 'fresh-install-fake-token-0123456789',
      tags: ['fresh'],
    });
    assert.equal(created.proxyPort, 24001, 'first account must get the first free port');

    const listed = await rpc('cf.account.list', {});
    assert.equal(listed.accounts.length, 1);

    const config = await rpc('cf.config.get', {});
    assert.equal(config.masterKeySource, 'generated');

    console.log(`fresh-install-check OK (${dataDir}, port ${PORT})`);
  } finally {
    if (!exited) child.kill('SIGTERM');
    if (!exited) await Promise.race([once(child, 'exit'), sleep(4000)]);
    if (!exited) child.kill('SIGKILL');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  if (stderr.trim()) process.stderr.write(stderr);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
