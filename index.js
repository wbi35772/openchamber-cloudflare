#!/usr/bin/env node
'use strict';

/*
 * cf-matrix-channel
 *
 * Multi-account Cloudflare API matrix with 1:1 proxy binding, encrypted
 * credentials, persisted budgets and a three-level circuit breaker.
 *
 * Library entry: require('openchamber-cf-matrix-channel') and call createMatrix().
 * CLI: node index.js [options] <command> [args]
 *
 * Zero-config first run: a 32-byte master key is generated at
 * <dataDir>/master.key and the config file lives at
 * <dataDir>/cf-matrix.config.json. Both can be overridden by flags or env.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { normalizeConfig, validateConfig } = require('./config/defaults');
const {
  DEFAULT_CONFIG_FILE,
  readConfigFile,
  writeConfigFile,
  sanitizeConfig,
  applyConfigPatch,
} = require('./config/config-store');
const { createVault } = require('./core/vault-store');
const { createRiskEngine } = require('./core/risk-engine');
const { createNetBinder } = require('./core/net-binder');
const { createCfClient } = require('./core/cf-client');
const { createRpcHandler, serializeError } = require('./bridge/rpc-handler');

const VERSION = require('./package.json').version;

function createMatrix(options = {}) {
  const dataDir =
    options.dataDir ||
    process.env.CF_MATRIX_DATA_DIR ||
    process.env.INSTABOX_MATRIX_DATA_DIR ||
    path.join(os.homedir(), '.openchamber-cf-matrix-channel');

  const failClosed = String(process.env.CF_FAIL_CLOSED || 'true').toLowerCase();
  if (failClosed !== 'true' && failClosed !== '1') {
    throw new Error('CF_FAIL_CLOSED=false is not supported: cf-matrix-channel is always fail-closed');
  }

  const defaultConfigPath = path.join(dataDir, DEFAULT_CONFIG_FILE);
  const configPath = options.configPath || process.env.CF_MATRIX_CONFIG || defaultConfigPath;
  const fileConfig = readConfigFile(configPath);

  const envConfig = {};
  if (process.env.CF_PORT_RANGE_START) envConfig.portStart = Number(process.env.CF_PORT_RANGE_START);
  if (process.env.CF_PORT_RANGE_END) envConfig.portEnd = Number(process.env.CF_PORT_RANGE_END);
  if (process.env.CF_API_BASE) envConfig.apiBase = process.env.CF_API_BASE;

  const config = normalizeConfig(
    Object.assign({}, fileConfig || {}, envConfig, options.config || {}),
  );
  const problems = validateConfig(config);
  if (problems.length) throw new Error(`invalid cf-matrix config: ${problems.join('; ')}`);

  if (!fileConfig && Object.keys(envConfig).length === 0 && !options.config) {
    try {
      writeConfigFile(configPath, config);
    } catch {
      /* a read-only install still runs from defaults */
    }
  }

  const events = new EventEmitter();
  const vault = createVault({
    dataDir,
    masterKey: options.masterKey,
    masterKeyFile: options.masterKeyFile,
  });
  vault.open();

  const risk = createRiskEngine({
    vault,
    config,
    random: options.random,
    now: options.now,
    sleep: options.sleep,
    onAlert: (alert) => events.emit('risk', alert),
  });

  const net = createNetBinder({
    getAccount: (accountId) => vault.get(accountId),
    config,
    proxyHost: options.proxyHost || '127.0.0.1',
    proxyAuth: options.proxyAuth,
    maxConnections: options.maxConnections,
    keepAliveTimeoutMs: options.keepAliveTimeoutMs,
    createTransport: options.createTransport,
    onQuarantine: (event) => events.emit('quarantine', event),
  });

  const client = createCfClient({
    vault,
    risk,
    net,
    config,
    now: options.now,
    sleep: options.sleep,
    onEvent: (event) => events.emit('request', event),
  });

  function saveConfig(patch = {}) {
    const next = applyConfigPatch(config, patch);
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, next);
    writeConfigFile(configPath, next);
    return { configPath, config: sanitizeConfig(next) };
  }

  const rpc = createRpcHandler({
    vault,
    risk,
    net,
    client,
    config,
    saveConfig,
    configPath,
    dataDir,
    masterKeySource: vault.masterKeySource,
    masterKeyPath: vault.masterKeyPath,
    nextFreePort,
  });

  function nextFreePort() {
    const used = new Set(vault.list().map((account) => account.proxyPort));
    for (let port = config.portStart; port <= config.portEnd; port += 1) {
      if (!used.has(port)) return port;
    }
    throw new Error(`no free proxy port in ${config.portStart}-${config.portEnd}`);
  }

  async function bootstrap(accounts = []) {
    const added = [];
    for (const seed of accounts) {
      if (!seed || !seed.label) continue;
      const existing = vault.get(seed.id || seed.label);
      if (existing) continue;
      const profile = await vault.add({
        ...seed,
        proxyPort: seed.proxyPort || nextFreePort(),
      });
      added.push(profile);
    }
    return added;
  }

  function close() {
    net.closeAll();
    events.removeAllListeners();
  }

  const matrix = {
    version: VERSION,
    dataDir,
    configPath,
    defaultConfigPath,
    masterKeySource: vault.masterKeySource,
    masterKeyPath: vault.masterKeyPath,
    config,
    vault,
    risk,
    net,
    client,
    rpc,
    events,
    bootstrap,
    saveConfig,
    nextFreePort,
    close,
    snapshot() {
      return {
        version: VERSION,
        dataDir,
        configPath,
        apiBase: config.apiBase,
        portRange: [config.portStart, config.portEnd],
        masterKeySource: vault.masterKeySource,
        masterKeyPath: vault.masterKeyPath,
        accounts: vault.list(),
        bindings: net.status(),
      };
    },
  };

  matrix.bootstrapped = [];
  matrix.ready = (async () => {
    if (Array.isArray(config.accounts) && config.accounts.length) {
      matrix.bootstrapped = await bootstrap(config.accounts);
    }
    return matrix;
  })();
  matrix.ready.catch(() => {});

  return matrix;
}

/* ------------------------------------------------------------------ CLI */

const BOOLEAN_FLAGS = new Set([
  'help',
  'json',
  'force',
  'disabled',
  'token-stdin',
  'api-key-stdin',
]);

function parseArgv(argv) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      flags._.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      flags._.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (BOOLEAN_FLAGS.has(key)) {
      value = true;
    } else {
      value = argv[index + 1];
      if (value === undefined) throw new Error(`--${key} requires a value`);
      index += 1;
    }
    if (key === 'tag' || key === 'tags') {
      flags.tags = flags.tags || [];
      flags.tags.push(...String(value).split(',').map((item) => item.trim()).filter(Boolean));
    } else {
      flags[key] = value;
    }
  }
  return flags;
}

function usage() {
  return [
    'cf-matrix-channel',
    '',
    'usage: node index.js [options] <command> [args]',
    '',
    'commands:',
    '  init [--force]                 create data dir, master key and config file',
    '  status',
    '  accounts',
    '  account add --label L (--token T | --token-stdin | --token-env VAR)',
    '              [--id ID] [--proxy-port P] [--tags a,b] [--cloudflare-account-id ID]',
    '  account add --label L --auth-type key --email E --api-key K',
    '  account update <id> [--label L] [--token T] [--proxy-port P] [--tags a,b]',
    '                    [--enabled true|false] [--cloudflare-account-id ID]',
    '  account remove <id>',
    '  verify <id>',
    '  config get',
    '  config set risk.rps=3 portStart=24100 apiBase=https://...',
    '  config patch \'{"risk":{"rps":3}}\'',
    '  rpc <cf.method> [json-params]',
    '',
    'global options:',
    '  --data-dir <dir>       state directory (default ~/.openchamber-cf-matrix-channel)',
    '  --config <file>        config file (default <data-dir>/cf-matrix.config.json)',
    '  --master-key <key>     override the generated master key',
    '  --master-key-file <f>  read the master key from a file',
    '  --port-start <n>       override pool lower bound',
    '  --port-end <n>         override pool upper bound',
    '  --api-base <url>       override the Cloudflare API base',
    '',
    'env (all optional): CF_MATRIX_MASTER_KEY, CF_MATRIX_MASTER_KEY_FILE,',
    '  CF_MATRIX_DATA_DIR, CF_MATRIX_CONFIG, CF_PORT_RANGE_START,',
    '  CF_PORT_RANGE_END, CF_API_BASE',
    '',
  ].join('\n');
}

function readSecret(flags, name) {
  const stdinFlag = `${name}-stdin`;
  if (flags[stdinFlag]) {
    const value = fs.readFileSync(0, 'utf8').trim();
    if (!value) throw new Error(`--${stdinFlag} received an empty value`);
    return value;
  }
  const envName = flags[`${name}-env`];
  if (envName) {
    const value = process.env[envName];
    if (!value) throw new Error(`environment variable ${envName} is empty or missing`);
    return value.trim();
  }
  if (flags[name] !== undefined) {
    if (flags[name] === true) throw new Error(`--${name} requires a value`);
    return String(flags[name]).trim();
  }
  return undefined;
}

function setPatchPath(target, dotted, value) {
  const parts = dotted.split('.').filter(Boolean);
  if (!parts.length) throw new Error('empty config key');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (['__proto__', 'constructor', 'prototype'].includes(part)) {
      throw new Error(`unsafe config key ${dotted}`);
    }
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  const last = parts[parts.length - 1];
  if (['__proto__', 'constructor', 'prototype'].includes(last)) {
    throw new Error(`unsafe config key ${dotted}`);
  }
  let parsed = value;
  try {
    parsed = JSON.parse(value);
  } catch {
    /* keep string */
  }
  cursor[last] = parsed;
}

async function dispatch(matrix, flags, command, args) {
  if (command === 'init') {
    const existed = fs.existsSync(matrix.configPath);
    let saved = false;
    if (!existed || flags.force) {
      matrix.saveConfig({});
      saved = true;
    }
    return {
      dataDir: matrix.dataDir,
      configPath: matrix.configPath,
      configSaved: saved,
      configExisted: existed,
      masterKeySource: matrix.masterKeySource,
      masterKeyPath: matrix.masterKeyPath,
      portRange: [matrix.config.portStart, matrix.config.portEnd],
      accounts: matrix.vault.list().length,
    };
  }
  if (command === 'status') return matrix.rpc.handle('cf.matrix.status', {});
  if (command === 'accounts' || (command === 'account' && args[0] === 'list')) {
    return matrix.rpc.handle('cf.account.list', {});
  }
  if (command === 'verify') {
    const id = args[0] || flags.id;
    if (!id) throw new Error('usage: node index.js verify <accountId|label>');
    return matrix.rpc.handle('cf.account.verify', { id });
  }
  if (command === 'account' && args[0] === 'add') {
    const label = args[1] || flags.label;
    if (!label) throw new Error('account add requires --label');
    const token = readSecret(flags, 'token');
    const apiKey = readSecret(flags, 'api-key');
    const authType = flags['auth-type'] || (apiKey ? 'key' : 'token');
    const params = {
      id: flags.id,
      label,
      authType,
      token: authType === 'token' ? token : undefined,
      apiKey: authType === 'key' ? apiKey : undefined,
      email: flags.email,
      cloudflareAccountId: flags['cloudflare-account-id'],
      tags: flags.tags,
      enabled: flags.disabled ? false : true,
    };
    if (flags['proxy-port'] !== undefined) params.proxyPort = Number(flags['proxy-port']);
    else params.proxyPort = matrix.nextFreePort();
    return matrix.rpc.handle('cf.account.add', params);
  }
  if (command === 'account' && args[0] === 'update') {
    const id = args[1] || flags.id;
    if (!id) throw new Error('usage: node index.js account update <id>');
    const patch = {};
    if (flags.label !== undefined) patch.label = String(flags.label);
    if (flags.token !== undefined || flags['token-stdin'] || flags['token-env']) {
      patch.token = readSecret(flags, 'token');
    }
    if (flags['api-key'] !== undefined || flags['api-key-stdin'] || flags['api-key-env']) {
      patch.apiKey = readSecret(flags, 'api-key');
    }
    if (flags.email !== undefined) patch.email = String(flags.email);
    if (flags['proxy-port'] !== undefined) patch.proxyPort = Number(flags['proxy-port']);
    if (flags.tags !== undefined) patch.tags = flags.tags;
    if (flags['cloudflare-account-id'] !== undefined) {
      patch.cloudflareAccountId = String(flags['cloudflare-account-id']);
    }
    if (flags.enabled !== undefined) {
      patch.enabled = String(flags.enabled).toLowerCase() === 'true';
    }
    if (flags.disabled) patch.enabled = false;
    return matrix.rpc.handle('cf.account.update', { id, patch });
  }
  if (command === 'account' && args[0] === 'remove') {
    const id = args[1] || flags.id;
    if (!id) throw new Error('usage: node index.js account remove <id>');
    return matrix.rpc.handle('cf.account.remove', { id });
  }
  if (command === 'config' && (args[0] === 'get' || !args[0])) {
    return matrix.rpc.handle('cf.config.get', {});
  }
  if (command === 'config' && args[0] === 'set') {
    if (!args.length) throw new Error('usage: node index.js config set key=value [key=value ...]');
    const patch = {};
    for (const item of args.slice(1)) {
      const eq = item.indexOf('=');
      if (eq <= 0) throw new Error(`invalid config assignment: ${item}`);
      setPatchPath(patch, item.slice(0, eq), item.slice(eq + 1));
    }
    return matrix.rpc.handle('cf.config.patch', patch);
  }
  if (command === 'config' && args[0] === 'patch') {
    const raw = args[1] === '-' ? fs.readFileSync(0, 'utf8') : args[1];
    if (!raw) throw new Error('usage: node index.js config patch \'{"risk":{"rps":3}}\'');
    const patch = JSON.parse(raw);
    return matrix.rpc.handle('cf.config.patch', patch);
  }
  if (command === 'rpc') {
    if (!args[0]) throw new Error('usage: node index.js rpc <cf.method> [json-params]');
    const params = args[1] ? JSON.parse(args[1]) : {};
    return matrix.rpc.handle(args[0], params);
  }
  throw new Error(`unknown command "${command}"`);
}

async function runCli(argv) {
  let flags;
  try {
    flags = parseArgv(argv);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: serializeError(error) }, null, 2)}\n`);
    return 1;
  }

  const command = flags._[0];
  const args = flags._.slice(1);
  if (!command || flags.help || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage());
    return 0;
  }

  const overrides = {};
  if (flags['port-start'] !== undefined) overrides.portStart = Number(flags['port-start']);
  if (flags['port-end'] !== undefined) overrides.portEnd = Number(flags['port-end']);
  if (flags['api-base'] !== undefined) overrides.apiBase = String(flags['api-base']);

  let matrix;
  try {
    matrix = createMatrix({
      dataDir: flags['data-dir'],
      configPath: flags.config,
      masterKey: flags['master-key'],
      masterKeyFile: flags['master-key-file'],
      config: Object.keys(overrides).length ? overrides : undefined,
    });
    await matrix.ready;
    const result = await dispatch(matrix, flags, command, args);
    process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: serializeError(error) }, null, 2)}\n`);
    return 1;
  } finally {
    if (matrix) matrix.close();
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  createMatrix,
  runCli,
  VERSION,
  ...require('./config/defaults'),
  ...require('./config/config-store'),
  ...require('./core/vault-store'),
  ...require('./core/risk-engine'),
  ...require('./core/net-binder'),
  ...require('./core/cf-client'),
  ...require('./bridge/rpc-handler'),
};
