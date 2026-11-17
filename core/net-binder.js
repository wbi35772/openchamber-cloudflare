'use strict';

/*
 * Network binder.
 *
 * One Cloudflare account == one local sing-box inbound port. There is no
 * fallback path: if the proxy port is not reachable, the request refuses to
 * leave the host instead of silently going out over the host's own IP.
 *
 * Every account gets its own transport instance (lib/proxy-fetch.js) and a
 * small connection-slot gate (maxConnections, default 5). Node's shim opens a
 * fresh CONNECT tunnel per request; the gate bounds parallel sockets and the
 * idle timer closes the transport after keepAliveTimeout of inactivity, which
 * mirrors the undici Agent settings the design calls for without adding a
 * dependency that this host does not expose.
 */

const net = require('node:net');
const { createProxyFetch } = require('../lib/proxy-fetch');
const {
  indexForSlotId,
  matrixSlotIdForPort,
  egressPortForSlotId,
  controlAuthorization,
  strictControlHeaders,
  isEgressSafeForControl,
  normalizeFingerprint,
  unsafeEgress,
} = require('./contract');

const DEFAULT_KEEPALIVE_MS = 30000;
const DEFAULT_MAX_CONNECTIONS = 5;

class ProxyUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProxyUnavailableError';
    this.code = 'ERR_PROXY_UNAVAILABLE';
    this.status = 503;
    this.accountId = details.accountId || null;
    this.proxyPort = details.proxyPort || null;
    this.cause = details.cause || null;
  }
}

class BindingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BindingError';
    this.code = code;
    if (details.accountId) this.accountId = details.accountId;
    if (details.proxyPort) this.proxyPort = details.proxyPort;
  }
}

function tcpProbe(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.connect({ port, host });
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, error: error ? String(error.message || error) : null, latencyMs: Date.now() - startedAt });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, new Error('tcp probe timeout')));
    socket.once('error', (error) => finish(false, error));
  });
}

const UA = `openchamber-cf-matrix/1.0 (${process.platform}; ${process.arch})`;

function fingerprintFor(account) {
  const seed = `${account.id}:${account.label}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const languages = ['en-US,en;q=0.9', 'en-GB,en;q=0.9', 'en-US,en;q=0.8'];
  return {
    'user-agent': UA,
    accept: 'application/json',
    'accept-language': languages[Math.abs(hash >> 3) % languages.length],
    'content-type': 'application/json',
    'cache-control': 'no-store',
  };
}

function createSemaphore(max) {
  let active = 0;
  const waiters = [];
  return {
    get active() {
      return active;
    },
    get pending() {
      return waiters.length;
    },
    async acquire() {
      if (active < max) {
        active += 1;
        return;
      }
      await new Promise((resolve) => waiters.push(resolve));
      active += 1;
    },
    release() {
      active = Math.max(0, active - 1);
      const next = waiters.shift();
      if (next) next();
    },
  };
}

function createNetBinder(options = {}) {
  const getAccount = options.getAccount;
  if (typeof getAccount !== 'function') {
    throw new Error('createNetBinder requires getAccount(accountId)');
  }
  const config = options.config || {};
  const currentHost = () => options.proxyHost || config.proxyHost || '127.0.0.1';
  const currentProxyAuth = () => options.proxyAuth || config.proxyAuth || undefined;
  const keepAliveMs = Number(options.keepAliveTimeoutMs || DEFAULT_KEEPALIVE_MS);
  const maxConnections = Number(options.maxConnections || DEFAULT_MAX_CONNECTIONS);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const onQuarantine = typeof options.onQuarantine === 'function' ? options.onQuarantine : () => {};
  const createTransport =
    typeof options.createTransport === 'function' ? options.createTransport : createProxyFetch;
  const getEgressState =
    typeof options.getEgressState === 'function' ? options.getEgressState : null;

  const bindings = new Map();
  const probes = new Map();

  function slotRecord(matrixSlotId, egressPort) {
    if (!matrixSlotId) return null;
    const state = getEgressState ? getEgressState() : null;
    const slots = state && Array.isArray(state.slots) ? state.slots : [];
    return slots.find((entry) => entry && entry.matrixSlotId === matrixSlotId) || null;
  }

  /*
   * Cloudflare control traffic (the only traffic this extension produces) may
   * never leave through a slot that is mid-rotation, quarantined, or spilling
   * into shared WARP. When an egress state source is configured, every request
   * re-checks the live snapshot before a single byte is sent.
   */
  function assertSlotSafe(binding) {
    if (!getEgressState) return null;
    if (!binding.matrixSlotId) {
      throw unsafeEgress({
        matrixSlotId: 'slot-???',
        egressPort: binding.proxyPort,
        reason: `account ${binding.accountId} is not bound to a matrix slot`,
      });
    }
    const state = getEgressState();
    if (!state || typeof state !== 'object') {
      throw unsafeEgress({
        matrixSlotId: binding.matrixSlotId,
        egressPort: binding.proxyPort,
        reason: 'egress matrix state is unavailable',
      });
    }
    const slots = Array.isArray(state.slots) ? state.slots : [];
    const slot = slots.find((entry) => entry && entry.matrixSlotId === binding.matrixSlotId);
    if (!slot) {
      throw unsafeEgress({
        matrixSlotId: binding.matrixSlotId,
        egressPort: binding.proxyPort,
        reason: 'slot is missing from the egress snapshot',
      });
    }
    if (!isEgressSafeForControl(slot.healthState)) {
      throw unsafeEgress({
        matrixSlotId: binding.matrixSlotId,
        egressPort: binding.proxyPort,
        healthState: slot.healthState,
        reason: 'slot health state forbids control traffic',
      });
    }
    if (
      slot.routingPlane &&
      String(slot.routingPlane).toUpperCase() !== 'STRICT_CONTROL'
    ) {
      throw unsafeEgress({
        matrixSlotId: binding.matrixSlotId,
        egressPort: binding.proxyPort,
        healthState: slot.healthState,
        reason: `slot is leased to ${slot.routingPlane}`,
      });
    }
    return slot;
  }

  function bind(accountId) {
    const account = getAccount(accountId);
    if (!account) throw new BindingError('ERR_ACCOUNT_NOT_FOUND', `account "${accountId}" not found`);
    const portStart = config.portStart ?? 24001;
    const portEnd = config.portEnd ?? 24250;
    const proxyPort = Number(account.proxyPort);
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
      throw new BindingError('ERR_PORT_INVALID', `account "${account.id}" has no valid proxyPort`, {
        accountId: account.id,
      });
    }
    if (proxyPort < portStart || proxyPort > portEnd) {
      throw new BindingError(
        'ERR_PORT_OUT_OF_RANGE',
        `proxy port ${proxyPort} is outside the matrix pool ${portStart}-${portEnd}`,
        { accountId: account.id, proxyPort },
      );
    }

    const existing = bindings.get(account.id);
    const proxyHost = currentHost();
    const explicitSlot = account.matrixSlotId ? String(account.matrixSlotId) : null;
    const matrixSlotId = explicitSlot || matrixSlotIdForPort(proxyPort);
    let egressPort = null;
    if (matrixSlotId) {
      if (indexForSlotId(matrixSlotId) === null) {
        throw new BindingError('ERR_SLOT_INVALID', `account "${account.id}" has invalid matrixSlotId "${matrixSlotId}"`, {
          accountId: account.id,
        });
      }
      egressPort = egressPortForSlotId(matrixSlotId);
      if (egressPort !== proxyPort) {
        throw new BindingError(
          'ERR_SLOT_PORT_MISMATCH',
          `slot ${matrixSlotId} is bound to port ${egressPort}, account "${account.id}" uses ${proxyPort}`,
          { accountId: account.id, proxyPort },
        );
      }
    }
    if (
      existing &&
      existing.proxyPort === proxyPort &&
      existing.proxyHost === proxyHost &&
      existing.matrixSlotId === matrixSlotId
    ) {
      assertSlotSafe(existing);
      return existing;
    }
    if (existing) close(account.id);

    const slotBound = Boolean(matrixSlotId);
    const transport = createTransport(proxyPort, {
      proxyHost,
      proxyAuth: slotBound ? controlAuthorization(matrixSlotId) : currentProxyAuth(),
      routingHeaders: slotBound ? strictControlHeaders(matrixSlotId) : undefined,
      timeoutMs: config.http?.timeoutMs || 30000,
      failClosed: true,
      onQuarantine: (reason) => onQuarantine({ accountId: account.id, proxyPort, reason }),
    });

    const binding = {
      accountId: account.id,
      label: account.label,
      matrixSlotId,
      egressPort,
      proxyPort,
      proxyHost,
      egressIpv6: account.egressIpv6 || null,
      transport,
      slots: createSemaphore(maxConnections),
      fingerprint: fingerprintFor(account),
      idleTimer: null,
      createdAt: now(),
      lastUsedAt: 0,
      requests: 0,
      failures: 0,
      drainCount: 0,
      lastDrainedAt: 0,
    };
    assertSlotSafe(binding);
    bindings.set(account.id, binding);
    return binding;
  }

  function touch(binding) {
    binding.lastUsedAt = now();
    if (binding.idleTimer) clearTimeout(binding.idleTimer);
    binding.idleTimer = setTimeout(() => {
      if (binding.slots.active === 0) close(binding.accountId);
    }, keepAliveMs);
    if (typeof binding.idleTimer.unref === 'function') binding.idleTimer.unref();
  }

  async function ensureReachable(binding, options = {}) {
    const at = now();
    const probeTtlMs = config.probe?.ttlMs ?? 30000;
    const tcpTimeoutMs = config.probe?.tcpTimeoutMs ?? 1200;
    const cached = probes.get(binding.proxyPort);
    if (
      !options.force &&
      cached &&
      cached.ok &&
      cached.expiresAt > at &&
      cached.accountId === binding.accountId
    ) {
      return cached;
    }
    const result = await tcpProbe(binding.proxyPort, currentHost(), options.timeoutMs || tcpTimeoutMs);
    if (!result.ok) {
      probes.set(binding.proxyPort, {
        ok: false,
        accountId: binding.accountId,
        checkedAt: at,
        expiresAt: at + Math.min(probeTtlMs, 5000),
        error: result.error,
      });
      throw new ProxyUnavailableError(
        `proxy ${binding.proxyHost || currentHost()}:${binding.proxyPort} is unreachable for account ${binding.accountId}; request blocked (fail-closed)`,
        { accountId: binding.accountId, proxyPort: binding.proxyPort, cause: result.error },
      );
    }
    const record = {
      ok: true,
      accountId: binding.accountId,
      checkedAt: at,
      expiresAt: at + probeTtlMs,
      latencyMs: result.latencyMs,
      error: null,
    };
    probes.set(binding.proxyPort, record);
    return record;
  }

  async function probeEgress(accountId, options = {}) {
    const binding = bind(accountId);
    assertSlotSafe(binding);
    const probeTimeoutMs = config.probe?.timeoutMs ?? 5000;
    await ensureReachable(binding, { force: true });
    const url = options.url || config.probe?.url;
    if (!url) return { accountId: binding.accountId, proxyPort: binding.proxyPort, ip: null };
    await binding.slots.acquire();
    try {
      const response = await binding.transport.fetch(url, {
        method: 'GET',
        headers: { ...binding.fingerprint, accept: 'text/plain' },
        timeoutMs: options.timeoutMs || probeTimeoutMs,
      });
      const text = await response.text();
      const ipLine = text.split('\n').find((line) => line.startsWith('ip=')) || '';
      return {
        accountId: binding.accountId,
        proxyPort: binding.proxyPort,
        status: response.status,
        ip: ipLine ? ipLine.slice(3) : null,
        location: (text.split('\n').find((line) => line.startsWith('loc=')) || '').slice(4) || null,
      };
    } finally {
      binding.slots.release();
      touch(binding);
    }
  }

  async function request(accountId, input, init = {}) {
    const binding = bind(accountId);
    assertSlotSafe(binding);
    await ensureReachable(binding);
    await binding.slots.acquire();
    binding.requests += 1;
    try {
      const headers = { ...binding.fingerprint, ...(init.headers || {}) };
      headers['user-agent'] = binding.fingerprint['user-agent'];
      const response = await binding.transport.fetch(input, { ...init, headers });
      touch(binding);
      return response;
    } catch (error) {
      binding.failures += 1;
      if (error && error.code === 'PROXY_QUARANTINED') {
        throw new ProxyUnavailableError(
          `proxy for account ${binding.accountId} is quarantined: ${error.message}`,
          { accountId: binding.accountId, proxyPort: binding.proxyPort, cause: error.message },
        );
      }
      throw error;
    } finally {
      binding.slots.release();
      touch(binding);
    }
  }

  function close(accountId) {
    const binding = bindings.get(accountId);
    if (!binding) return false;
    if (binding.idleTimer) clearTimeout(binding.idleTimer);
    try {
      binding.transport.close();
    } finally {
      bindings.delete(accountId);
      probes.delete(binding.proxyPort);
    }
    return true;
  }

  function closeAll() {
    for (const accountId of [...bindings.keys()]) close(accountId);
    probes.clear();
  }

  /*
   * PRE_ROTATION_FREEZE handler: drop every pooled connection of one slot, but
   * leave the binding registered so POST_ROTATION_RESUME can continue on the
   * fresh lease without re-reading the vault.
   */
  function drainSlot(matrixSlotId) {
    const slot = String(matrixSlotId || '');
    const targets = [];
    for (const binding of bindings.values()) {
      if (binding.matrixSlotId === slot) targets.push(binding.accountId);
    }
    let drained = 0;
    for (const accountId of targets) {
      const binding = bindings.get(accountId);
      if (!binding) continue;
      if (typeof binding.transport.drain === 'function') {
        try {
          binding.transport.drain();
        } catch {
          /* ignore drain failure: the transport gets rebuilt on demand */
        }
        binding.drainCount += 1;
        binding.lastDrainedAt = now();
        drained += 1;
        continue;
      }
      try {
        binding.transport.close();
      } catch {
        /* ignore close failure */
      }
      if (binding.idleTimer) clearTimeout(binding.idleTimer);
      bindings.delete(accountId);
      probes.delete(binding.proxyPort);
      drained += 1;
    }
    return { matrixSlotId: slot, drained };
  }

  function drainAll() {
    const slots = new Set();
    for (const binding of bindings.values()) {
      if (binding.matrixSlotId) slots.add(binding.matrixSlotId);
    }
    let drained = 0;
    for (const slot of slots) drained += drainSlot(slot).drained;
    return { drained, slots: [...slots] };
  }

  function slotForAccount(accountId) {
    const profile = getAccount(accountId);
    if (!profile) return null;
    const proxyPort = Number(profile.proxyPort);
    const matrixSlotId = profile.matrixSlotId || matrixSlotIdForPort(proxyPort);
    if (!matrixSlotId) return null;
    return {
      accountId: profile.id,
      matrixSlotId,
      egressPort: egressPortForSlotId(matrixSlotId),
    };
  }

  function egressSnapshot() {
    if (!getEgressState) return null;
    try {
      return getEgressState();
    } catch {
      return null;
    }
  }

  function slotStatus(matrixSlotId) {
    if (!matrixSlotId) return null;
    const slot = slotRecord(String(matrixSlotId), null);
    if (!slot) return null;
    let fingerprint = null;
    try {
      fingerprint = slot.egressFingerprint ? normalizeFingerprint(slot.egressFingerprint) : null;
    } catch {
      fingerprint = null;
    }
    return {
      matrixSlotId: slot.matrixSlotId,
      egressPort: slot.egressPort,
      routingPlane: slot.routingPlane || null,
      healthState: slot.healthState || null,
      leaseId: slot.leaseId || null,
      egressFingerprint: fingerprint,
    };
  }

  function status() {
    return [...bindings.values()].map((binding) => {
      const slot = slotStatus(binding.matrixSlotId);
      return {
        accountId: binding.accountId,
        label: binding.label,
        matrixSlotId: binding.matrixSlotId,
        egressPort: binding.egressPort,
        proxyPort: binding.proxyPort,
        egressIpv6: binding.egressIpv6,
        healthState: slot ? slot.healthState : null,
        routingPlane: slot ? slot.routingPlane : null,
        egressFingerprint: slot ? slot.egressFingerprint : null,
        activeSlots: binding.slots.active,
        pendingSlots: binding.slots.pending,
        maxConnections,
        requests: binding.requests,
        failures: binding.failures,
        drainCount: binding.drainCount,
        lastDrainedAt: binding.lastDrainedAt,
        lastUsedAt: binding.lastUsedAt,
        transportState: binding.transport.state,
        probe: probes.get(binding.proxyPort) || null,
      };
    });
  }

  function invalidateProbe(accountId) {
    const binding = bindings.get(accountId);
    if (binding) probes.delete(binding.proxyPort);
  }

  return {
    bind,
    request,
    probeEgress,
    ensureReachable(accountId, options) {
      return ensureReachable(bind(accountId), options);
    },
    invalidateProbe,
    drainSlot,
    drainAll,
    slotForAccount,
    slotStatus,
    egressSnapshot,
    close,
    closeAll,
    status,
    failClosed: true,
  };
}

module.exports = {
  createNetBinder,
  ProxyUnavailableError,
  BindingError,
  tcpProbe,
  fingerprintFor,
  createSemaphore,
  DEFAULT_KEEPALIVE_MS,
  DEFAULT_MAX_CONNECTIONS,
};
