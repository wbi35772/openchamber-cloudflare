'use strict';

/*
 * Deterministic polymorphism for Cloudflare resources.
 *
 * Two Workers with the same business logic must not share a hash on the
 * Cloudflare side, and resource names must not telegraph what the code does.
 * Everything here is pure: the same (account, source) pair always yields the
 * same bytes, different accounts always yield different bytes, and no network
 * or filesystem access happens in this file.
 */

const crypto = require('node:crypto');
const { indexForSlotId } = require('./contract');

const BUILD_BANNER_PREFIX = 'oc-build';
const BUILD_TAIL_PREFIX = 'oc-tail';
const RESOURCE_MAX_LENGTH = 63;
const BANNED_WORDS = Object.freeze(['edgetunnel', 'vless', 'proxy', 'scan']);

const FIRST_POOL = Object.freeze([
  'edge',
  'telemetry',
  'sync',
  'relay',
  'mesh',
  'signal',
  'cache',
  'route',
  'beacon',
  'drift',
]);

const SECOND_POOL = Object.freeze([
  'sync',
  'node',
  'hub',
  'lane',
  'pulse',
  'link',
  'grid',
  'gateway',
  'relay',
  'stream',
]);

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function hashNumber(digest, offset, modulo) {
  const slice = digest.slice(offset, offset + 8);
  return Number.parseInt(slice, 16) % modulo;
}

function assertSource(codeString) {
  const source = typeof codeString === 'string' ? codeString : String(codeString ?? '');
  if (!source.trim()) {
    throw new TypeError('polymorphWorkerScript requires non-empty Worker source');
  }
  return source;
}

function assertAccount(cfAccountId) {
  const account = String(cfAccountId || '').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(account)) {
    throw new TypeError('polymorphWorkerScript requires a Cloudflare account id');
  }
  return account;
}

function buildDigest(codeString, cfAccountId) {
  const source = assertSource(codeString);
  const account = assertAccount(cfAccountId);
  return sha256(`${account}\u0000${source}`);
}

function buildBanner(digest) {
  const tag = digest.slice(0, 16);
  const seed = Number.parseInt(digest.slice(16, 24), 16);
  const multiplier = 1 + (Number.parseInt(digest.slice(24, 28), 16) % 997);
  const salt = digest.slice(28, 44);
  return [
    `// ${BUILD_BANNER_PREFIX} ${tag}`,
    `const __ocBuild${tag} = ${seed};`,
    `const __ocSalt${tag} = ${JSON.stringify(salt)};`,
    `function __ocChecksum${tag}(value) {`,
    `  const text = String(value == null ? '' : value);`,
    `  let hash = __ocBuild${tag};`,
    `  for (let index = 0; index < text.length; index += 1) {`,
    `    hash = (Math.imul(hash, ${multiplier}) + text.charCodeAt(index)) >>> 0;`,
    `  }`,
    `  return hash;`,
    `}`,
    `if (__ocChecksum${tag}(__ocSalt${tag}) === -1) {`,
    `  throw new Error(${JSON.stringify(`unreachable ${tag}`)});`,
    `}`,
    `/* build:${digest.slice(0, 32)} */`,
  ].join('\n');
}

function buildTail(digest) {
  return [
    `// ${BUILD_TAIL_PREFIX} ${digest.slice(32, 48)}`,
    `const __ocTail${digest.slice(48, 56)} = ${JSON.stringify(digest.slice(56, 64))};`,
    `void __ocTail${digest.slice(48, 56)};`,
  ].join('\n');
}

function polymorphWorkerScript(codeString, cfAccountId) {
  const source = assertSource(codeString);
  const digest = buildDigest(source, cfAccountId);
  return `${buildBanner(digest)}\n${source}\n${buildTail(digest)}\n`;
}

function polymorphDigest(codeString, cfAccountId) {
  return sha256(polymorphWorkerScript(codeString, cfAccountId));
}

function isPolymorphized(codeString) {
  return String(codeString || '').includes(`// ${BUILD_BANNER_PREFIX} `);
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .map((token) => token.trim())
    .filter(Boolean);
}

function isBannedToken(token) {
  const lower = String(token || '').toLowerCase();
  return BANNED_WORDS.some((word) => lower.includes(word));
}

function sanitizeResourceToken(token, fallback) {
  const cleaned = String(token || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!cleaned || isBannedToken(cleaned)) return fallback;
  return cleaned.slice(0, 18);
}

/*
 * Generate a boring, plausible, non-descriptive resource name.
 * `edgetunnel`, `vless`, `proxy` and `scan` can never survive tokenisation, so
 * a tunnel called "edgetunnel-proxy" still becomes e.g. "edge-telemetry-s001".
 */
function generateSafeResourceName(prefixSeed, slotId) {
  const index = indexForSlotId(slotId);
  if (index === null) {
    throw new TypeError('generateSafeResourceName requires a valid matrix slot id');
  }
  const suffix = `s${String(index).padStart(3, '0')}`;
  const seed = `${String(prefixSeed || '')}\u0000${slotId}`;
  const digest = sha256(seed);
  const tokens = tokenize(prefixSeed).filter((token) => !isBannedToken(token));

  const firstFallback = FIRST_POOL[hashNumber(digest, 0, FIRST_POOL.length)];
  const secondFallback = SECOND_POOL[hashNumber(digest, 8, SECOND_POOL.length)];
  const first = sanitizeResourceToken(tokens[0], firstFallback);
  let second = sanitizeResourceToken(tokens[1], secondFallback);
  if (second === first) {
    second = SECOND_POOL[(SECOND_POOL.indexOf(second) + 1) % SECOND_POOL.length];
  }

  let base = `${first}-${second}`;
  if (base.length + suffix.length + 1 > RESOURCE_MAX_LENGTH) {
    base = base.slice(0, RESOURCE_MAX_LENGTH - suffix.length - 1);
  }
  return `${base}-${suffix}`;
}

function resourceNameIsSafe(name) {
  const lower = String(name || '').toLowerCase();
  if (!lower) return false;
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(lower)) return false;
  return !BANNED_WORDS.some((word) => lower.includes(word));
}

module.exports = {
  BANNED_WORDS,
  BUILD_BANNER_PREFIX,
  BUILD_TAIL_PREFIX,
  polymorphWorkerScript,
  polymorphDigest,
  buildDigest,
  isPolymorphized,
  generateSafeResourceName,
  resourceNameIsSafe,
};
