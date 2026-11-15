'use strict';

/*
 * Encrypted multi-account vault.
 *
 * Two files live under `dataDir`:
 *
 *   cf-accounts.json        static profiles + sealed auth material (rarely written)
 *   cf-accounts-state.json  volatile runtime state: status, strikes, budgets, health
 *
 * Every read/modify/write cycle goes through `withStateLock` from lib/store-lock.js,
 * which serialises callers inside this process and across processes, and every
 * commit is an atomic tmp+rename write with mode 0600.
 *
 * Secrets are sealed with AES-256-GCM. The key is derived from
 * CF_MATRIX_MASTER_KEY with scrypt and a per-vault random salt. Ciphertexts are
 * bound to the account through the GCM additional authenticated data, so moving
 * a sealed token to another account id breaks decryption by design.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { withStateLock, atomicWriteJson } = require('../lib/store-lock');

const VAULT_FILE = 'cf-accounts.json';
const STATE_FILE = 'cf-accounts-state.json';
const MASTER_KEY_FILE = 'master.key';
const VAULT_VERSION = 1;
const STATE_VERSION = 1;
const SEALED_PREFIX = 'v1';
const KDF = Object.freeze({ name: 'scrypt', N: 32768, r: 8, p: 1, keyLen: 32, maxmem: 128 * 1024 * 1024 });
const CANARY = 'cf-matrix-channel/canary';

const DEFAULT_STATE = Object.freeze({
  status: 'ACTIVE',
  strikes: 0,
  cooldownUntil: 0,
  quarantineReason: null,
  healthScore: 100,
  lastRay: null,
  lastUsedAt: 0,
  lastError: null,
  successCount: 0,
  failureCount: 0,
  budget: { buckets: [], tokens: null, lastRefillAt: 0 },
  zones: {},
});

class VaultError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
    if (details) this.details = details;
  }
}

function resolveDataDir(explicit) {
  return (
    explicit ||
    process.env.CF_MATRIX_DATA_DIR ||
    process.env.INSTABOX_MATRIX_DATA_DIR ||
    path.join(os.homedir(), '.openchamber-cf-matrix-channel')
  );
}

function resolveMasterKey(explicit, options = {}) {
  return loadMasterKey({ ...options, explicit }).key;
}

function readKeyFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new VaultError('ERR_MASTER_KEY_READ', `cannot read master key ${file}: ${error.message}`);
  }
}

function assertKey(key, source) {
  if (!key || String(key).trim().length < 16) {
    throw new VaultError(
      'ERR_MASTER_KEY_INVALID',
      `master key from ${source} must be at least 16 characters of high-entropy material`,
    );
  }
  return String(key).trim();
}

function loadMasterKey(options = {}) {
  const explicit = options.explicit ?? options.masterKey;
  if (explicit != null && String(explicit).trim()) {
    return { key: assertKey(explicit, 'explicit option'), source: 'explicit', path: null };
  }
  const envKey = process.env.CF_MATRIX_MASTER_KEY;
  if (envKey && String(envKey).trim()) {
    return { key: assertKey(envKey, 'CF_MATRIX_MASTER_KEY'), source: 'env', path: null };
  }

  const envFile = options.masterKeyFile || process.env.CF_MATRIX_MASTER_KEY_FILE;
  if (envFile) {
    const key = readKeyFile(envFile);
    if (!key) {
      throw new VaultError('ERR_MASTER_KEY_MISSING', `master key file not found: ${envFile}`);
    }
    return { key: assertKey(key, envFile), source: 'file', path: envFile };
  }

  const dataDir = resolveDataDir(options.dataDir);
  const keyPath = path.join(dataDir, MASTER_KEY_FILE);
  const stored = readKeyFile(keyPath);
  if (stored) return { key: assertKey(stored, keyPath), source: 'file', path: keyPath };

  if (fs.existsSync(path.join(dataDir, VAULT_FILE))) {
    throw new VaultError(
      'ERR_MASTER_KEY_MISSING',
      `vault exists but no master key was supplied; set CF_MATRIX_MASTER_KEY or restore ${keyPath}`,
    );
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32).toString('hex');
  const tmp = `${keyPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
  try {
    fs.renameSync(tmp, keyPath);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw new VaultError('ERR_MASTER_KEY_WRITE', `cannot write ${keyPath}: ${error.message}`);
  }
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    /* Windows may not support POSIX modes */
  }
  return { key, source: 'generated', path: keyPath };
}

function b64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function unb64(text) {
  return Buffer.from(String(text), 'base64');
}

function deriveKey(masterKey, salt, params = KDF) {
  return crypto.scryptSync(Buffer.from(String(masterKey), 'utf8'), salt, params.keyLen || 32, {
    N: params.N || KDF.N,
    r: params.r || KDF.r,
    p: params.p || KDF.p,
    maxmem: params.maxmem || KDF.maxmem,
  });
}

function seal(key, plaintext, aad) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SEALED_PREFIX, b64(iv), b64(tag), b64(ciphertext)].join('.');
}

function unseal(key, sealed, aad) {
  if (sealed == null) return null;
  const parts = String(sealed).split('.');
  if (parts.length !== 4 || parts[0] !== SEALED_PREFIX) {
    throw new VaultError('ERR_SEALED_FORMAT', 'sealed value is not in v1 format');
  }
  const iv = unb64(parts[1]);
  const tag = unb64(parts[2]);
  const ciphertext = unb64(parts[3]);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    throw new VaultError('ERR_DECRYPT', 'failed to unseal secret (wrong master key or tampered file)', {
      cause: error.message,
    });
  }
}

function emptyVault() {
  const now = Date.now();
  const salt = crypto.randomBytes(16);
  return {
    version: VAULT_VERSION,
    createdAt: now,
    updatedAt: now,
    kdf: { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p, keyLen: KDF.keyLen, salt: b64(salt) },
    canary: null,
    accounts: {},
  };
}

function emptyStateFile() {
  return { version: STATE_VERSION, updatedAt: Date.now(), accounts: {} };
}

function normalizeId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
    throw new VaultError('ERR_INVALID_ID', 'account id must match [A-Za-z0-9_.-]{1,64}');
  }
  return id;
}

function generateId() {
  return `acc_${crypto.randomBytes(6).toString('hex')}`;
}

function slug(value) {
  const text = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return text || generateId();
}

function publicProfile(account) {
  if (!account) return null;
  return {
    id: account.id,
    label: account.label,
    authType: account.authType,
    email: account.email || null,
    cloudflareAccountId: account.cloudflareAccountId || null,
    tags: Array.isArray(account.tags) ? [...account.tags] : [],
    proxyPort: account.proxyPort,
    egressIpv6: account.egressIpv6 || null,
    enabled: account.enabled !== false,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    hasToken: Boolean(account.token),
    hasApiKey: Boolean(account.apiKey),
  };
}

function normalizeProfile(input, existing) {
  if (!input || typeof input !== 'object') {
    throw new VaultError('ERR_PROFILE', 'account profile must be an object');
  }
  const label = String(input.label ?? existing?.label ?? '').trim();
  if (!label || label.length > 64) {
    throw new VaultError('ERR_PROFILE', 'label is required and must be <= 64 characters');
  }

  const authType = String(input.authType ?? existing?.authType ?? 'token');
  if (authType !== 'token' && authType !== 'key') {
    throw new VaultError('ERR_PROFILE', `unsupported authType "${authType}"`);
  }

  const email = input.email !== undefined ? String(input.email || '').trim() : existing?.email || '';
  if (authType === 'key' && !email) {
    throw new VaultError('ERR_PROFILE', 'authType "key" requires the account email');
  }

  let tags = input.tags !== undefined ? input.tags : existing?.tags || [];
  if (!Array.isArray(tags)) throw new VaultError('ERR_PROFILE', 'tags must be an array');
  tags = [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 16);

  const proxyPort = Number(input.proxyPort ?? existing?.proxyPort ?? 0);
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new VaultError('ERR_PROFILE', 'proxyPort must be an integer between 1 and 65535');
  }

  const egressIpv6 = String(input.egressIpv6 ?? existing?.egressIpv6 ?? '').trim();
  if (egressIpv6 && !/^[0-9A-Fa-f:]{2,39}\/\d{1,3}$/.test(egressIpv6)) {
    throw new VaultError('ERR_PROFILE', 'egressIpv6 must look like 2001:db8::/64');
  }

  const cloudflareAccountId = String(
    input.cloudflareAccountId ?? existing?.cloudflareAccountId ?? '',
  ).trim();
  if (cloudflareAccountId && !/^[A-Fa-f0-9]{32}$/.test(cloudflareAccountId)) {
    throw new VaultError('ERR_PROFILE', 'cloudflareAccountId must be 32 hex characters');
  }

  return {
    label,
    authType,
    email: email || null,
    tags,
    proxyPort,
    egressIpv6: egressIpv6 || null,
    cloudflareAccountId: cloudflareAccountId || null,
    enabled: input.enabled === undefined ? existing?.enabled !== false : Boolean(input.enabled),
  };
}

function createVault(options = {}) {
  const dataDir = resolveDataDir(options.dataDir);
  const vaultPath = path.join(dataDir, VAULT_FILE);
  const statePath = path.join(dataDir, STATE_FILE);
  const keyInfo = loadMasterKey({
    explicit: options.masterKey,
    masterKeyFile: options.masterKeyFile,
    dataDir,
  });
  const masterKey = keyInfo.key;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  let cached = null;

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw new VaultError('ERR_VAULT_READ', `cannot read ${path.basename(file)}: ${error.message}`);
    }
  }

  function loadVault() {
    const data = readJson(vaultPath, null);
    if (!data) return null;
    if (data.version !== VAULT_VERSION || !data.kdf || !data.kdf.salt) {
      throw new VaultError('ERR_VAULT_VERSION', 'unsupported or corrupt vault header');
    }
    return data;
  }

  function keyFor(data) {
    const params = { ...KDF, ...data.kdf };
    return deriveKey(masterKey, unb64(data.kdf.salt), params);
  }

  function openVault() {
    let data = loadVault();
    if (!data) {
      data = emptyVault();
      const key = keyFor(data);
      data.canary = seal(key, CANARY, CANARY);
      cached = { data, key };
      return cached;
    }
    const key =
      cached && cached.data.kdf.salt === data.kdf.salt ? cached.key : keyFor(data);
    if (!data.canary) {
      data.canary = seal(key, CANARY, CANARY);
      data.updatedAt = now();
    } else {
      let probe;
      try {
        probe = unseal(key, data.canary, CANARY);
      } catch (error) {
        throw new VaultError(
          'ERR_VAULT_KEY_MISMATCH',
          'master key does not match this vault (canary failed to decrypt)',
          { cause: error.message },
        );
      }
      if (probe !== CANARY) {
        throw new VaultError('ERR_VAULT_KEY_MISMATCH', 'master key does not match this vault');
      }
    }
    cached = { data, key };
    return cached;
  }

  function currentKey() {
    if (!cached) openVault();
    return cached.key;
  }

  async function mutateVault(fn) {
    return withStateLock(vaultPath, async () => {
      let data = loadVault();
      if (!data) {
        data = emptyVault();
        const initialKey = keyFor(data);
        data.canary = seal(initialKey, CANARY, CANARY);
      }
      const key =
        cached && cached.data.kdf.salt === data.kdf.salt ? cached.key : keyFor(data);
      if (data.canary) {
        let probe;
        try {
          probe = unseal(key, data.canary, CANARY);
        } catch (error) {
          throw new VaultError(
            'ERR_VAULT_KEY_MISMATCH',
            'master key does not match this vault (canary failed to decrypt)',
            { cause: error.message },
          );
        }
        if (probe !== CANARY) {
          throw new VaultError('ERR_VAULT_KEY_MISMATCH', 'master key does not match this vault');
        }
      } else {
        data.canary = seal(key, CANARY, CANARY);
      }
      const outcome = await fn(data, key);
      data.updatedAt = now();
      atomicWriteJson(vaultPath, data, { mode: 0o600 });
      cached = { data, key };
      return outcome;
    });
  }

  function loadState() {
    const data = readJson(statePath, null);
    if (!data || data.version !== STATE_VERSION) return emptyStateFile();
    if (!data.accounts || typeof data.accounts !== 'object') data.accounts = {};
    return data;
  }

  async function mutateState(fn) {
    return withStateLock(statePath, async () => {
      const data = loadState();
      const outcome = await fn(data);
      data.updatedAt = now();
      atomicWriteJson(statePath, data, { mode: 0o600 });
      return outcome;
    });
  }

  function findProfile(data, idOrLabel) {
    const needle = String(idOrLabel || '');
    if (data.accounts[needle]) return data.accounts[needle];
    return Object.values(data.accounts).find((account) => account.label === needle) || null;
  }

  function stateFor(data, id) {
    const existing = data.accounts[id];
    if (!existing) {
      data.accounts[id] = { ...JSON.parse(JSON.stringify(DEFAULT_STATE)), id };
      return data.accounts[id];
    }
    return existing;
  }

  return {
    dataDir,
    vaultPath,
    statePath,
    masterKeySource: keyInfo.source,
    masterKeyPath: keyInfo.path,

    open() {
      const { data } = openVault();
      return {
        ready: true,
        vaultPath,
        statePath,
        masterKeySource: keyInfo.source,
        masterKeyPath: keyInfo.path,
        accounts: Object.keys(data.accounts).length,
      };
    },

    list() {
      const { data } = openVault();
      return Object.values(data.accounts).map(publicProfile);
    },

    get(idOrLabel) {
      const { data } = openVault();
      return publicProfile(findProfile(data, idOrLabel));
    },

    async add(input) {
      const profile = normalizeProfile(input);
      const id = normalizeId(input.id || slug(profile.label));
      return mutateVault((data, key) => {
        if (data.accounts[id]) {
          throw new VaultError('ERR_DUPLICATE', `account "${id}" already exists`);
        }
        const taken = Object.values(data.accounts).some(
          (account) => account.proxyPort === profile.proxyPort,
        );
        if (taken) {
          throw new VaultError('ERR_PORT_TAKEN', `proxy port ${profile.proxyPort} is already bound`);
        }
        const token = input.token ? String(input.token).trim() : '';
        const apiKey = input.apiKey ? String(input.apiKey).trim() : '';
        if (profile.authType === 'token' && !token) {
          throw new VaultError('ERR_PROFILE', 'authType "token" requires token');
        }
        if (profile.authType === 'key' && !apiKey) {
          throw new VaultError('ERR_PROFILE', 'authType "key" requires apiKey');
        }
        const record = {
          id,
          ...profile,
          token: token ? seal(key, token, `${id}:token`) : null,
          apiKey: apiKey ? seal(key, apiKey, `${id}:apiKey`) : null,
          createdAt: now(),
          updatedAt: now(),
        };
        data.accounts[id] = record;
        return publicProfile(record);
      });
    },

    async update(idOrLabel, patch) {
      return mutateVault((data, key) => {
        const existing = findProfile(data, idOrLabel);
        if (!existing) throw new VaultError('ERR_NOT_FOUND', `account "${idOrLabel}" not found`);
        const profile = normalizeProfile({ ...existing, ...patch }, existing);
        if (profile.proxyPort !== existing.proxyPort) {
          const taken = Object.values(data.accounts).some(
            (account) => account.id !== existing.id && account.proxyPort === profile.proxyPort,
          );
          if (taken) throw new VaultError('ERR_PORT_TAKEN', `proxy port ${profile.proxyPort} is taken`);
        }
        Object.assign(existing, profile);
        if (patch.token !== undefined) {
          existing.token = patch.token ? seal(key, String(patch.token), `${existing.id}:token`) : null;
        }
        if (patch.apiKey !== undefined) {
          existing.apiKey = patch.apiKey ? seal(key, String(patch.apiKey), `${existing.id}:apiKey`) : null;
        }
        existing.updatedAt = now();
        return publicProfile(existing);
      });
    },

    async remove(idOrLabel) {
      const removed = await mutateVault((data) => {
        const existing = findProfile(data, idOrLabel);
        if (!existing) throw new VaultError('ERR_NOT_FOUND', `account "${idOrLabel}" not found`);
        delete data.accounts[existing.id];
        return existing.id;
      });
      await mutateState((data) => {
        delete data.accounts[removed];
      });
      return { id: removed, removed: true };
    },

    credentials(idOrLabel) {
      const { data, key } = openVault();
      const account = findProfile(data, idOrLabel);
      if (!account) throw new VaultError('ERR_NOT_FOUND', `account "${idOrLabel}" not found`);
      return {
        id: account.id,
        label: account.label,
        authType: account.authType,
        email: account.email,
        proxyPort: account.proxyPort,
        egressIpv6: account.egressIpv6,
        cloudflareAccountId: account.cloudflareAccountId,
        token: account.token ? unseal(key, account.token, `${account.id}:token`) : null,
        apiKey: account.apiKey ? unseal(key, account.apiKey, `${account.id}:apiKey`) : null,
      };
    },

    async seal(plaintext, aad) {
      return seal(currentKey(), plaintext, aad || 'cf-matrix/generic');
    },

    unseal(sealed, aad) {
      return unseal(currentKey(), sealed, aad || 'cf-matrix/generic');
    },

    state(idOrLabel) {
      const { data } = openVault();
      const account = findProfile(data, idOrLabel);
      if (!account) return null;
      const states = loadState();
      return states.accounts[account.id] || { ...JSON.parse(JSON.stringify(DEFAULT_STATE)), id: account.id };
    },

    states() {
      const { data } = openVault();
      const states = loadState();
      return Object.values(data.accounts).map((account) => ({
        id: account.id,
        label: account.label,
        ...JSON.parse(JSON.stringify(DEFAULT_STATE)),
        ...(states.accounts[account.id] || {}),
      }));
    },

    async mutateState(idOrLabel, fn) {
      const { data } = openVault();
      const account = findProfile(data, idOrLabel);
      if (!account) throw new VaultError('ERR_NOT_FOUND', `account "${idOrLabel}" not found`);
      return mutateState((states) => fn(stateFor(states, account.id)));
    },

    async mutateAllStates(fn) {
      const { data } = openVault();
      return mutateState((states) => {
        for (const account of Object.values(data.accounts)) stateFor(states, account.id);
        return fn(states.accounts);
      });
    },

    async resetState(idOrLabel) {
      const { data } = openVault();
      const account = findProfile(data, idOrLabel);
      if (!account) throw new VaultError('ERR_NOT_FOUND', `account "${idOrLabel}" not found`);
      return mutateState((states) => {
        states.accounts[account.id] = { ...JSON.parse(JSON.stringify(DEFAULT_STATE)), id: account.id };
        return states.accounts[account.id];
      });
    },

    snapshot() {
      const { data } = openVault();
      const states = loadState();
      return {
        vaultPath,
        statePath,
        accounts: Object.values(data.accounts).map((account) => ({
          ...publicProfile(account),
          state: { ...JSON.parse(JSON.stringify(DEFAULT_STATE)), ...(states.accounts[account.id] || {}) },
        })),
      };
    },
  };
}

module.exports = {
  createVault,
  VaultError,
  publicProfile,
  normalizeProfile,
  normalizeId,
  resolveDataDir,
  resolveMasterKey,
  seal,
  unseal,
  deriveKey,
  DEFAULT_STATE,
  VAULT_FILE,
  STATE_FILE,
};
