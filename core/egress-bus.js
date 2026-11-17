'use strict';

/*
 * Local client for the openchamber-egress-matrix bus (port 19880).
 *
 * The bus is the single source of truth for slot health, leases and rotation
 * events. This client keeps a cached state snapshot for synchronous fail-closed
 * checks, a WebSocket subscription for PRE_ROTATION_FREEZE / POST_ROTATION_RESUME,
 * and thin HTTP helpers for manual rotation from the panel.
 *
 * Nothing here is allowed to crash the host: when the bus is absent every
 * method degrades to an explicit { ok: false } result and the matrix keeps
 * working in legacy (no-egress) mode.
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const {
  EGRESS_BUS_URL,
  normalizeFingerprint,
  normalizeHealthState,
  normalizeRoutingPlane,
} = require('./contract');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_PATH = '/api/v1/egress/ws';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
const MAX_FRAME = 1024 * 1024;

class EgressBusError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EgressBusError';
    this.code = details.code || 'ERR_EGRESS_BUS';
    this.status = details.status || 0;
    this.path = details.path || null;
    this.reason = details.reason || null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function encodeClientFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload === undefined ? '' : String(payload), 'utf8');
  const mask = crypto.randomBytes(4);
  const head = [];
  head.push(0x80 | (opcode & 0x0f));
  if (data.length < 126) {
    head.push(0x80 | data.length);
  } else if (data.length < 65536) {
    head.push(0x80 | 126, (data.length >> 8) & 0xff, data.length & 0xff);
  } else {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(data.length));
    head.push(0x80 | 127, ...length);
  }
  const masked = Buffer.allocUnsafe(data.length);
  for (let index = 0; index < data.length; index += 1) {
    masked[index] = data[index] ^ mask[index & 3];
  }
  return Buffer.concat([Buffer.from(head), mask, masked]);
}

function createFrameReader(onFrame, onError) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;

  return function push(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const big = buffer.readBigUInt64BE(offset);
        if (big > BigInt(MAX_FRAME)) {
          onError(new EgressBusError('WebSocket frame too large', { code: 'ERR_WS_FRAME' }));
          return;
        }
        length = Number(big);
        offset += 8;
      }
      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (maskKey) {
        const unmasked = Buffer.allocUnsafe(payload.length);
        for (let index = 0; index < payload.length; index += 1) {
          unmasked[index] = payload[index] ^ maskKey[index & 3];
        }
        payload = unmasked;
      }

      if (opcode === OP_PING) {
        onFrame({ opcode: OP_PONG, payload });
        continue;
      }
      if (opcode === OP_PONG) continue;
      if (opcode === OP_CLOSE) {
        onFrame({ opcode: OP_CLOSE, payload });
        return;
      }
      if (opcode === OP_CONT) {
        if (!fragmentOpcode) continue;
        fragments.push(payload);
        const total = fragments.reduce((sum, part) => sum + part.length, 0);
        if (total > MAX_FRAME) {
          fragments = [];
          fragmentOpcode = 0;
          onError(new EgressBusError('WebSocket message too large', { code: 'ERR_WS_FRAME' }));
          return;
        }
        if (fin) {
          const data = Buffer.concat(fragments);
          const kind = fragmentOpcode;
          fragments = [];
          fragmentOpcode = 0;
          onFrame({ opcode: kind, payload: data });
        }
        continue;
      }
      if (opcode === OP_TEXT || opcode === OP_BINARY) {
        if (!fin) {
          fragments = [payload];
          fragmentOpcode = opcode;
          continue;
        }
        onFrame({ opcode, payload });
      }
    }
  };
}

function connectWebSocket(rawUrl, options = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      reject(new EgressBusError(`invalid egress bus URL: ${rawUrl}`, { code: 'ERR_WS_URL' }));
      return;
    }
    const secure = url.protocol === 'wss:' || url.protocol === 'https:';
    const transport = secure ? https : http;
    const key = crypto.randomBytes(16).toString('base64');
    const timeoutMs = Number(options.timeoutMs) || 2500;
    const request = transport.request(
      {
        protocol: secure ? 'https:' : 'http:',
        hostname: url.hostname,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-version': '13',
          'sec-websocket-key': key,
        },
        rejectUnauthorized: options.rejectUnauthorized !== false,
        timeout: timeoutMs,
      },
      (response) => {
        response.resume();
        reject(new EgressBusError(`egress bus refused upgrade (${response.statusCode})`, {
          code: 'ERR_WS_UPGRADE',
          status: response.statusCode,
        }));
      },
    );
    request.on('upgrade', (response, socket, head) => {
      const accept = crypto
        .createHash('sha1')
        .update(`${key}${WS_GUID}`)
        .digest('base64');
      if (response.headers['sec-websocket-accept'] !== accept) {
        socket.destroy();
        reject(new EgressBusError('egress bus sent an invalid WebSocket accept', { code: 'ERR_WS_ACCEPT' }));
        return;
      }
      socket.setNoDelay(true);
      resolve({ socket, head });
    });
    request.on('timeout', () => {
      request.destroy(new EgressBusError('egress bus upgrade timed out', { code: 'ERR_WS_TIMEOUT' }));
    });
    request.on('error', (error) => {
      reject(new EgressBusError(`egress bus unavailable: ${error.message}`, {
        code: error.code || 'ERR_WS_CONNECT',
      }));
    });
    request.end();
  });
}

class EgressSocket extends EventEmitter {
  constructor(socket, head) {
    super();
    this.socket = socket;
    this.closed = false;
    this.reader = createFrameReader(
      (frame) => this.handleFrame(frame),
      (error) => this.fail(error),
    );
    socket.on('data', (chunk) => this.reader(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.finish(1006, 'socket closed'));
    if (head && head.length) this.reader(head);
  }

  handleFrame(frame) {
    if (frame.opcode === OP_PONG) {
      this.sendRaw(OP_PONG, frame.payload);
      return;
    }
    if (frame.opcode === OP_CLOSE) {
      this.finish(1000, 'peer closed');
      return;
    }
    if (frame.opcode !== OP_TEXT) return;
    let payload;
    try {
      payload = JSON.parse(frame.payload.toString('utf8'));
    } catch {
      return;
    }
    this.emit('event', payload);
  }

  sendRaw(opcode, payload) {
    if (this.closed) return false;
    try {
      this.socket.write(encodeClientFrame(opcode, payload));
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  send(event) {
    return this.sendRaw(OP_TEXT, JSON.stringify(event));
  }

  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    this.emit('close', { code, reason });
  }

  fail(error) {
    if (this.closed) return;
    if (this.listenerCount('error')) this.emit('error', error);
    this.finish(1006, error.message || 'WebSocket error');
  }

  close() {
    if (this.closed) return;
    try {
      this.socket.write(encodeClientFrame(OP_CLOSE, Buffer.alloc(0)));
    } catch {
      /* ignore */
    }
    this.finish(1000, 'client closed');
  }
}

function createEgressBus(options = {}) {
  const enabled = options.enabled !== false;
  const baseUrl = String(options.url || EGRESS_BUS_URL || '').replace(/\/+$/, '');
  const clientId = String(options.clientId || `cf-matrix-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  const stateTtlMs = Math.max(250, Number(options.stateTtlMs) || 2000);
  const connectTimeoutMs = Math.max(250, Number(options.connectTimeoutMs) || 2500);
  const ackTimeoutMs = Math.max(100, Number(options.ackTimeoutMs) || 1500);
  const reconnectMinMs = Math.max(250, Number(options.reconnectMinMs) || 1000);
  const reconnectMaxMs = Math.max(reconnectMinMs, Number(options.reconnectMaxMs) || 15000);
  const events = new EventEmitter();

  let started = false;
  let stopped = false;
  let socket = null;
  let reconnectTimer = null;
  let refreshTimer = null;
  let reconnectDelay = reconnectMinMs;
  let connecting = false;
  let lastMessageAt = 0;
  let cache = {
    ok: false,
    connected: false,
    stale: true,
    state: null,
    updatedAt: 0,
    error: null,
  };

  function apiUrl(path) {
    return new URL(`${baseUrl}${path}`).toString();
  }

  function wsUrl() {
    const url = new URL(`${baseUrl}${WS_PATH}`);
    url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
    url.searchParams.set('clientId', clientId);
    return url.toString();
  }

  async function request(path, init = {}) {
    if (!enabled) {
      throw new EgressBusError('egress bus client is disabled', { code: 'ERR_EGRESS_BUS_DISABLED', path });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(init.timeoutMs) || connectTimeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetch(apiUrl(path), {
        method: init.method || 'GET',
        headers: {
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.headers || {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { raw: text };
      }
      if (!response.ok) {
        const message = body?.error?.message || body?.message || `egress bus HTTP ${response.status}`;
        throw new EgressBusError(message, {
          code: body?.error?.code || 'ERR_EGRESS_BUS_HTTP',
          status: response.status,
          path,
        });
      }
      return body;
    } catch (error) {
      if (error instanceof EgressBusError) throw error;
      if (error.name === 'AbortError') {
        throw new EgressBusError(`egress bus request timed out: ${path}`, {
          code: 'ERR_EGRESS_BUS_TIMEOUT',
          path,
        });
      }
      throw new EgressBusError(`egress bus unreachable: ${error.message}`, {
        code: error.code || 'ERR_EGRESS_BUS_NET',
        path,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function applyState(payload, error = null) {
    const state = payload && typeof payload === 'object' ? payload : null;
    cache = {
      ok: Boolean(state) && !error,
      connected: Boolean(state) && !error,
      stale: Boolean(error),
      state,
      updatedAt: Date.now(),
      error: error ? String(error.message || error) : null,
    };
    if (state) events.emit('state', state);
    return cache;
  }

  async function refreshState() {
    try {
      const payload = await request('/api/v1/egress/state');
      return applyState(payload);
    } catch (error) {
      applyState(cache.state, error);
      return cache;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const base = reconnectDelay;
    const jitter = Math.floor(Math.random() * 400);
    reconnectDelay = Math.min(reconnectMaxMs, Math.round(reconnectDelay * 1.7));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch(() => {});
    }, base + jitter);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  async function handleFreeze(payload) {
    lastMessageAt = Date.now();
    events.emit('freeze', payload);
    try {
      if (typeof options.onFreeze === 'function') {
        await options.onFreeze(payload);
      }
    } catch (error) {
      events.emit('freeze-error', { error, event: payload });
    } finally {
      if (options.autoAck !== false && payload && payload.eventId) {
        try {
          await ackFreeze(payload.eventId);
        } catch (error) {
          events.emit('ack-error', { error, eventId: payload.eventId });
        }
      }
    }
  }

  function handleResume(payload) {
    lastMessageAt = Date.now();
    const slotId = String(payload?.matrixSlotId || '');
    if (cache.state && Array.isArray(cache.state.slots) && slotId) {
      const slot = cache.state.slots.find((entry) => entry.matrixSlotId === slotId);
      if (slot) {
        slot.healthState = normalizeHealthState(payload.healthState || 'ACTIVE');
        slot.routingPlane = normalizeRoutingPlane(payload.routingPlane, 'STRICT_CONTROL');
        if (payload.leaseId) slot.leaseId = String(payload.leaseId);
        if (payload.egressFingerprint) {
          slot.egressFingerprint = normalizeFingerprint(payload.egressFingerprint, payload.leaseId || slot.leaseId);
        }
      }
    }
    events.emit('resume', payload);
    if (typeof options.onResume === 'function') {
      try {
        options.onResume(payload);
      } catch (error) {
        events.emit('resume-error', { error, event: payload });
      }
    }
    refreshState().catch(() => {});
  }

  function handleEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    lastMessageAt = Date.now();
    const type = String(payload.type || '').toUpperCase();
    events.emit('event', payload);
    if (type === 'PRE_ROTATION_FREEZE') {
      handleFreeze(payload).catch(() => {});
      return;
    }
    if (type === 'POST_ROTATION_RESUME') {
      handleResume(payload);
      return;
    }
    if (type === 'SLOT_STATE_UPDATED' || type === 'ROTATION_FAILED') {
      refreshState().catch(() => {});
    }
  }

  async function connect() {
    if (!enabled || stopped || connecting || socket) return null;
    connecting = true;
    try {
      const { socket: raw, head } = await connectWebSocket(wsUrl(), { timeoutMs: connectTimeoutMs });
      const active = new EgressSocket(raw, head);
      socket = active;
      reconnectDelay = reconnectMinMs;
      lastMessageAt = Date.now();
      events.emit('connected', { clientId, url: wsUrl() });
      active.on('event', (payload) => handleEvent(payload));
      active.on('close', ({ code, reason }) => {
        if (socket === active) socket = null;
        events.emit('disconnected', { code, reason });
        scheduleReconnect();
      });
      active.on('error', (error) => events.emit('socket-error', error));
      refreshState().catch(() => {});
      return active;
    } catch (error) {
      events.emit('connect-error', error);
      scheduleReconnect();
      return null;
    } finally {
      connecting = false;
    }
  }

  function start() {
    if (!enabled || started) return bus;
    started = true;
    stopped = false;
    refreshState().catch(() => {});
    connect().catch(() => {});
    refreshTimer = setInterval(() => {
      refreshState().catch(() => {});
    }, stateTtlMs);
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
    return bus;
  }

  function stop() {
    stopped = true;
    started = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (socket) {
      const active = socket;
      socket = null;
      active.close();
    }
    events.emit('stopped');
  }

  async function ackFreeze(eventId) {
    const id = String(eventId || '').trim();
    if (!id) throw new EgressBusError('ackFreeze requires an eventId', { code: 'ERR_ACK_EVENT_ID' });
    if (socket && socket.send({ type: 'ACK_FREEZE', eventId: id })) {
      return { ok: true, via: 'ws', eventId: id };
    }
    const payload = await request('/api/v1/egress/ack-freeze', {
      method: 'POST',
      body: { clientId, eventId: id },
      timeoutMs: ackTimeoutMs,
    });
    return { ok: true, via: 'http', eventId: id, result: payload };
  }

  async function listLeases() {
    const payload = await request('/api/v1/egress/leases');
    return Array.isArray(payload?.leases) ? payload.leases : [];
  }

  async function listSlots() {
    const payload = await request('/api/v1/egress/slots');
    return Array.isArray(payload?.slots) ? payload.slots : [];
  }

  async function rotateSlot(matrixSlotId, body = {}) {
    const slotId = String(matrixSlotId || '').trim();
    const payload = await request(`/api/v1/egress/slots/${encodeURIComponent(slotId)}/rotate`, {
      method: 'POST',
      body: body || {},
      timeoutMs: Number(body.timeoutMs) || 30000,
    });
    refreshState().catch(() => {});
    return payload;
  }

  async function quarantineSlot(matrixSlotId, reason) {
    const payload = await request('/api/v1/egress/quarantine', {
      method: 'POST',
      body: { matrixSlotId: String(matrixSlotId || ''), reason: String(reason || 'panel') },
    });
    refreshState().catch(() => {});
    return payload;
  }

  async function releaseSlot(matrixSlotId) {
    const payload = await request('/api/v1/egress/release', {
      method: 'POST',
      body: { matrixSlotId: String(matrixSlotId || '') },
    });
    refreshState().catch(() => {});
    return payload;
  }

  async function probeSlot(matrixSlotId) {
    return request('/api/v1/egress/probe', {
      method: 'POST',
      body: { matrixSlotId: String(matrixSlotId || '') },
      timeoutMs: 15000,
    });
  }

  function findSlot(matrixSlotId) {
    const state = cache.state;
    if (!state || !Array.isArray(state.slots)) return null;
    return state.slots.find((entry) => entry && entry.matrixSlotId === matrixSlotId) || null;
  }

  function getEgressState() {
    return cache.state;
  }

  function status() {
    return {
      enabled,
      clientId,
      baseUrl,
      connected: Boolean(socket),
      started,
      lastMessageAt,
      stateUpdatedAt: cache.updatedAt,
      stateOk: cache.ok,
      stale: cache.stale,
      error: cache.error,
      slots: Array.isArray(cache.state?.slots) ? cache.state.slots.length : 0,
    };
  }

  const bus = {
    clientId,
    baseUrl,
    enabled,
    events,
    start,
    stop,
    connect,
    request,
    refreshState,
    ackFreeze,
    listLeases,
    listSlots,
    rotateSlot,
    quarantineSlot,
    releaseSlot,
    probeSlot,
    findSlot,
    getEgressState,
    status,
  };

  return bus;
}

module.exports = {
  createEgressBus,
  EgressBusError,
  connectWebSocket,
  encodeClientFrame,
  createFrameReader,
};
