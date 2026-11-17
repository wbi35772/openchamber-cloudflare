'use strict';

/*
 * Config file helpers for cf-matrix-channel.
 *
 * The config file never contains credentials or seed accounts: accounts live
 * only in the encrypted vault. `sanitizeConfig` enforces that on every write.
 */

const fs = require('node:fs');
const path = require('node:path');

const { normalizeConfig, validateConfig, merge } = require('./defaults');

const DEFAULT_CONFIG_FILE = 'cf-matrix.config.json';
const PATCHABLE = new Set([
  'apiBase',
  'proxyHost',
  'proxyAuth',
  'egressBusUrl',
  'routingPlane',
  'portStart',
  'portEnd',
  'probe',
  'risk',
  'http',
]);

class ConfigError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    if (details) this.details = details;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeConfig(config) {
  const copy = JSON.parse(JSON.stringify(config || {}));
  delete copy.accounts;
  delete copy.dataDir;
  return copy;
}

function readConfigFile(file) {
  if (!file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ConfigError('ERR_CONFIG_READ', `cannot read config ${file}: ${error.message}`);
  }
}

function writeConfigFile(file, config) {
  if (!file) throw new ConfigError('ERR_CONFIG_PATH', 'config path is not set');
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(sanitizeConfig(config), null, 2)}\n`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw new ConfigError('ERR_CONFIG_WRITE', `cannot write config ${file}: ${error.message}`);
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows may not support POSIX modes */
  }
  return file;
}

function applyConfigPatch(current, patch) {
  if (!isObject(patch)) throw new ConfigError('ERR_CONFIG_PATCH', 'config patch must be an object');
  for (const key of Object.keys(patch)) {
    if (!PATCHABLE.has(key)) {
      throw new ConfigError(
        'ERR_CONFIG_KEY',
        `"${key}" is not runtime-patchable; allowed: ${[...PATCHABLE].join(', ')}`,
      );
    }
  }
  const next = normalizeConfig(merge(sanitizeConfig(current), patch));
  const problems = validateConfig(next);
  if (problems.length) throw new ConfigError('ERR_CONFIG_INVALID', problems.join('; '));
  return next;
}

module.exports = {
  DEFAULT_CONFIG_FILE,
  PATCHABLE,
  ConfigError,
  readConfigFile,
  writeConfigFile,
  sanitizeConfig,
  applyConfigPatch,
};
