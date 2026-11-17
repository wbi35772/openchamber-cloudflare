'use strict';

/*
 * Static defaults and normalisation for cf-matrix-channel.
 *
 * Everything here is pure data handling: no network, no filesystem. The JSON
 * Schema in `cf-matrix.schema.json` mirrors these bounds for external editors.
 */

const DEFAULTS = Object.freeze({
  version: 1,
  apiBase: 'https://api.cloudflare.com/client/v4',
  proxyHost: '127.0.0.1',
  proxyAuth: null,
  egressBusUrl: 'http://127.0.0.1:19880',
  routingPlane: 'STRICT_CONTROL',
  portStart: 24001,
  portEnd: 24250,
  probe: {
    url: 'https://www.cloudflare.com/cdn-cgi/trace',
    ttlMs: 30000,
    timeoutMs: 5000,
    tcpTimeoutMs: 1200,
  },
  risk: {
    rps: 4,
    burst: 4,
    windowLimit: 950,
    windowMs: 300000,
    windowBucketMs: 10000,
    remainingThreshold: 50,
    jitter: { minMs: 800, maxMs: 3200 },
    backoff: { baseMs: 30000, maxMs: 3600000, jitterMinMs: 1000, jitterMaxMs: 5000 },
    quarantineCodes: [10000, 9103, 9106, 9109],
    cooldownCodes: [1015],
  },
  http: {
    timeoutMs: 30000,
    maxRetries: 1,
    retryStatuses: [502, 503, 504],
    retryBaseMs: 1200,
  },
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function merge(base, patch) {
  if (!isObject(patch)) return JSON.parse(JSON.stringify(base));
  const out = JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (isObject(value) && isObject(out[key])) out[key] = merge(out[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

function int(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function number(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeConfig(raw) {
  const input = isObject(raw) ? raw : {};
  const config = merge(DEFAULTS, input);

  config.version = 1;
  config.apiBase = String(config.apiBase || DEFAULTS.apiBase).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(config.apiBase)) {
    throw new Error('apiBase must be an http(s) URL');
  }

  config.proxyHost = String(config.proxyHost || DEFAULTS.proxyHost).trim() || DEFAULTS.proxyHost;
  config.proxyAuth =
    config.proxyAuth === null || config.proxyAuth === undefined || config.proxyAuth === ''
      ? null
      : String(config.proxyAuth);

  config.egressBusUrl = String(config.egressBusUrl || DEFAULTS.egressBusUrl)
    .trim()
    .replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(config.egressBusUrl)) {
    throw new Error('egressBusUrl must be an http(s) URL');
  }
  config.routingPlane = String(config.routingPlane || DEFAULTS.routingPlane).toUpperCase();
  if (config.routingPlane !== 'STRICT_CONTROL' && config.routingPlane !== 'ELASTIC_DATA') {
    throw new Error('routingPlane must be STRICT_CONTROL or ELASTIC_DATA');
  }

  config.portStart = int(config.portStart, 1, 65535, DEFAULTS.portStart);
  config.portEnd = int(config.portEnd, config.portStart, 65535, Math.max(config.portStart, DEFAULTS.portEnd));
  if (config.portEnd < config.portStart) config.portEnd = config.portStart;

  config.probe.url = String(config.probe.url || '').trim();
  config.probe.ttlMs = int(config.probe.ttlMs, 0, 3600000, DEFAULTS.probe.ttlMs);
  config.probe.timeoutMs = int(config.probe.timeoutMs, 500, 120000, DEFAULTS.probe.timeoutMs);
  config.probe.tcpTimeoutMs = int(config.probe.tcpTimeoutMs, 100, 30000, DEFAULTS.probe.tcpTimeoutMs);

  config.risk.rps = number(config.risk.rps, 0.1, 100, DEFAULTS.risk.rps);
  config.risk.burst = number(config.risk.burst, 1, 200, Math.max(config.risk.rps, DEFAULTS.risk.burst));
  config.risk.windowLimit = int(config.risk.windowLimit, 1, 100000, DEFAULTS.risk.windowLimit);
  config.risk.windowMs = int(config.risk.windowMs, 1000, 86400000, DEFAULTS.risk.windowMs);
  config.risk.windowBucketMs = int(
    config.risk.windowBucketMs,
    100,
    config.risk.windowMs,
    DEFAULTS.risk.windowBucketMs,
  );
  config.risk.remainingThreshold = int(
    config.risk.remainingThreshold,
    0,
    100000,
    DEFAULTS.risk.remainingThreshold,
  );
  config.risk.jitter.minMs = int(config.risk.jitter.minMs, 0, 600000, DEFAULTS.risk.jitter.minMs);
  config.risk.jitter.maxMs = int(
    config.risk.jitter.maxMs,
    config.risk.jitter.minMs,
    600000,
    Math.max(config.risk.jitter.minMs, DEFAULTS.risk.jitter.maxMs),
  );
  config.risk.backoff.baseMs = int(config.risk.backoff.baseMs, 1000, 86400000, DEFAULTS.risk.backoff.baseMs);
  config.risk.backoff.maxMs = int(
    config.risk.backoff.maxMs,
    config.risk.backoff.baseMs,
    86400000,
    DEFAULTS.risk.backoff.maxMs,
  );
  config.risk.backoff.jitterMinMs = int(
    config.risk.backoff.jitterMinMs,
    0,
    600000,
    DEFAULTS.risk.backoff.jitterMinMs,
  );
  config.risk.backoff.jitterMaxMs = int(
    config.risk.backoff.jitterMaxMs,
    config.risk.backoff.jitterMinMs,
    600000,
    Math.max(config.risk.backoff.jitterMinMs, DEFAULTS.risk.backoff.jitterMaxMs),
  );

  config.risk.quarantineCodes = normalizeCodes(config.risk.quarantineCodes, DEFAULTS.risk.quarantineCodes);
  config.risk.cooldownCodes = normalizeCodes(config.risk.cooldownCodes, DEFAULTS.risk.cooldownCodes);

  config.http.timeoutMs = int(config.http.timeoutMs, 1000, 300000, DEFAULTS.http.timeoutMs);
  config.http.maxRetries = int(config.http.maxRetries, 0, 5, DEFAULTS.http.maxRetries);
  config.http.retryStatuses = normalizeCodes(config.http.retryStatuses, DEFAULTS.http.retryStatuses);
  config.http.retryBaseMs = int(config.http.retryBaseMs, 100, 60000, DEFAULTS.http.retryBaseMs);

  return config;
}

function normalizeCodes(list, fallback) {
  if (!Array.isArray(list)) return [...fallback];
  const codes = list
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0)
    .slice(0, 64);
  return codes.length ? [...new Set(codes)] : [...fallback];
}

function validateConfig(config) {
  const problems = [];
  if (!isObject(config)) return ['config must be an object'];
  if (config.portEnd < config.portStart) problems.push('portEnd must be >= portStart');
  if (config.risk.windowBucketMs > config.risk.windowMs) problems.push('windowBucketMs must be <= windowMs');
  if (!/^https?:\/\//i.test(String(config.apiBase || ''))) problems.push('apiBase must be http(s)');
  if (!/^https?:\/\//i.test(String(config.egressBusUrl || ''))) problems.push('egressBusUrl must be http(s)');
  if (config.routingPlane !== 'STRICT_CONTROL' && config.routingPlane !== 'ELASTIC_DATA') {
    problems.push('routingPlane must be STRICT_CONTROL or ELASTIC_DATA');
  }
  return problems;
}

module.exports = { DEFAULTS, normalizeConfig, validateConfig, merge };
