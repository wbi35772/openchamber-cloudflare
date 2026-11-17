'use strict';

/*
 * Local mirror of the openchamber-egress-matrix contract.
 *
 * cf-matrix-channel is a control-plane client of the egress matrix: every
 * Cloudflare account is statically bound to one matrix slot, and the slot's
 * egress port is the ONLY path that may reach api.cloudflare.com. This file
 * keeps the mapping/validation rules in one place so the rest of the module can
 * fail closed without importing the egress extension.
 */

const crypto = require('node:crypto');

const SLOT_MIN_INDEX = 1;
const SLOT_MAX_INDEX = 250;
const SLOT_COUNT = SLOT_MAX_INDEX - SLOT_MIN_INDEX + 1;
const EGRESS_PORT_BASE = 24000;
const EGRESS_PORT_MIN = EGRESS_PORT_BASE + SLOT_MIN_INDEX;
const EGRESS_PORT_MAX = EGRESS_PORT_BASE + SLOT_MAX_INDEX;

const ROUTING_PLANES = Object.freeze(['STRICT_CONTROL', 'ELASTIC_DATA']);
const HEALTH_STATES = Object.freeze([
  'ACTIVE',
  'COOLDOWN',
  'QUARANTINED',
  'WARP_OVERFLOW',
  'ROTATING',
]);

const CONTROL_ROUTING_PLANE = 'STRICT_CONTROL';
const STRICT_CONTROL_HEADER = 'x-oc-routing-plane';
const UNSAFE_HEALTH_STATES = Object.freeze(['QUARANTINED', 'WARP_OVERFLOW', 'ROTATING']);

const DEFAULT_EGRESS_BUS_URL = 'http://127.0.0.1:19880';
const EGRESS_BUS_URL = process.env.OC_EGRESS_BUS_URL || DEFAULT_EGRESS_BUS_URL;
const CF_SERVICE_PORT = Number(process.env.OC_CF_PORT || 19882);

const CONTROL_HOSTS = Object.freeze([
  'api.cloudflare.com',
  'dash.cloudflare.com',
  'cloudflare.com',
  'api.cloudflare.com/client/v4',
]);

function isMatrixIndex(index) {
  return Number.isInteger(index) && index >= SLOT_MIN_INDEX && index <= SLOT_MAX_INDEX;
}

function slotIdForIndex(index) {
  const value = Number(index);
  if (!isMatrixIndex(value)) {
    throw new RangeError(`matrix slot index must be ${SLOT_MIN_INDEX}..${SLOT_MAX_INDEX}`);
  }
  return `slot-${String(value).padStart(3, '0')}`;
}

function indexForSlotId(slotId) {
  const match = /^slot-(\d{3})$/.exec(String(slotId || '').trim());
  if (!match) return null;
  const index = Number(match[1]);
  return isMatrixIndex(index) ? index : null;
}

function egressPortForIndex(index) {
  return EGRESS_PORT_BASE + Number(index);
}

function egressPortForSlotId(slotId) {
  const index = indexForSlotId(slotId);
  return index === null ? null : egressPortForIndex(index);
}

function matrixSlotIdForPort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < EGRESS_PORT_MIN || value > EGRESS_PORT_MAX) return null;
  return slotIdForIndex(value - EGRESS_PORT_BASE);
}

function isMatrixPort(port) {
  return matrixSlotIdForPort(port) !== null;
}

function normalizeRoutingPlane(value, fallback = 'ELASTIC_DATA') {
  const plane = String(value || '').toUpperCase();
  return ROUTING_PLANES.includes(plane) ? plane : fallback;
}

function normalizeHealthState(value, fallback = 'ACTIVE') {
  const state = String(value || '').toUpperCase();
  return HEALTH_STATES.includes(state) ? state : fallback;
}

function expandIpv6(value) {
  let text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    const ipv4 = text.slice(lastColon + 1);
    const octets = ipv4.split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const words = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    words.push(group.padStart(4, '0'));
  }
  return words;
}

function compressIpv6Words(words) {
  if (!Array.isArray(words) || words.length !== 8) return null;
  let bestStart = -1;
  let bestLength = 0;
  let start = -1;
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] === '0000') {
      if (start === -1) start = index;
      const length = index - start + 1;
      if (length > bestLength) {
        bestStart = start;
        bestLength = length;
      }
    } else {
      start = -1;
    }
  }
  const parts = words.map((word) => word.replace(/^0+(?=.)/, ''));
  if (bestLength < 2) return parts.join(':');
  const before = parts.slice(0, bestStart).join(':');
  const after = parts.slice(bestStart + bestLength).join(':');
  return `${before}::${after}`;
}

function normalizePrefix64(value) {
  const text = String(value || '').trim().toLowerCase();
  const match = /^(.+)\/(\d{1,3})$/.exec(text);
  if (!match) return null;
  const bits = Number(match[2]);
  if (bits !== 64) return null;
  const words = expandIpv6(match[1]);
  if (!words) return null;
  const prefix = compressIpv6Words([...words.slice(0, 4), '0000', '0000', '0000', '0000']);
  return `${prefix}/64`;
}

function normalizeIpv4(value) {
  const text = String(value || '').trim();
  const parts = text.split('.');
  if (parts.length !== 4) return '';
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return '';
    const number = Number(part);
    if (number < 0 || number > 255) return '';
  }
  return parts.map((part) => String(Number(part))).join('.');
}

function emptyFingerprint(leaseId = '') {
  return {
    exitIp: '',
    ipv6Prefix64: null,
    asn: null,
    leaseId: String(leaseId || ''),
    updatedAt: 0,
  };
}

function normalizeFingerprint(value, fallbackLeaseId = '') {
  const input = value && typeof value === 'object' ? value : {};
  const prefix = normalizePrefix64(input.ipv6Prefix64);
  const asnValue = Number(input.asn);
  const updatedAt = Number(input.updatedAt);
  return {
    exitIp: normalizeIpv4(input.exitIp),
    ipv6Prefix64: prefix,
    asn: Number.isFinite(asnValue) && asnValue > 0 ? Math.round(asnValue) : null,
    leaseId: String(input.leaseId || fallbackLeaseId || ''),
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
  };
}

function validateLeaseRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object') return ['record must be an object'];
  if (indexForSlotId(record.matrixSlotId) === null) errors.push('matrixSlotId invalid');
  const expectedPort = egressPortForSlotId(record.matrixSlotId);
  if (expectedPort !== null && Number(record.egressPort) !== expectedPort) {
    errors.push(`egressPort must be ${expectedPort} for ${record.matrixSlotId}`);
  }
  if (!ROUTING_PLANES.includes(record.routingPlane)) errors.push('routingPlane invalid');
  if (!HEALTH_STATES.includes(record.healthState)) errors.push('healthState invalid');
  if (!record.egressFingerprint || typeof record.egressFingerprint !== 'object') {
    errors.push('egressFingerprint missing');
  } else if (
    record.egressFingerprint.ipv6Prefix64
    && normalizePrefix64(record.egressFingerprint.ipv6Prefix64) !== record.egressFingerprint.ipv6Prefix64
  ) {
    errors.push('egressFingerprint.ipv6Prefix64 must be a normalized /64 prefix');
  }
  return errors;
}

function isEgressSafeForControl(healthState) {
  return !UNSAFE_HEALTH_STATES.includes(String(healthState || '').toUpperCase());
}

function hostMatchesDomain(host, domain) {
  const target = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  const zone = String(domain || '').trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '');
  if (!target || !zone) return false;
  return target === zone || target.endsWith(`.${zone}`);
}

function isControlPlaneHost(host, extraDomains = []) {
  const target = String(host || '').trim().toLowerCase();
  if (!target) return false;
  return [...CONTROL_HOSTS, ...extraDomains].some((domain) => hostMatchesDomain(target, domain));
}

function controlAuthorization(slotId) {
  const slot = String(slotId || '').trim();
  return `Basic ${Buffer.from(`${slot}:${CONTROL_ROUTING_PLANE}`, 'utf8').toString('base64')}`;
}

function strictControlHeaders(slotId) {
  return {
    [STRICT_CONTROL_HEADER]: CONTROL_ROUTING_PLANE,
    'x-oc-matrix-slot': String(slotId || ''),
  };
}

class EgressSafetyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EgressSafetyError';
    this.code = details.code || 'ERR_EGRESS_UNSAFE_FOR_CF_CONTROL';
    this.matrixSlotId = details.matrixSlotId || null;
    this.egressPort = details.egressPort || null;
    this.healthState = details.healthState || null;
    this.reason = details.reason || null;
    this.status = 503;
  }
}

function unsafeEgress(details = {}) {
  const slot = details.matrixSlotId || 'slot-???';
  const state = details.healthState || 'OFFLINE';
  const reason = details.reason ? `: ${details.reason}` : '';
  return new EgressSafetyError(
    `egress ${slot} is ${state}; refusing to route Cloudflare control traffic${reason}`,
    { ...details, healthState: state },
  );
}

function fingerprintDigest(fingerprint) {
  const normalized = normalizeFingerprint(fingerprint);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([
      normalized.exitIp,
      normalized.ipv6Prefix64,
      normalized.asn,
      normalized.leaseId,
    ]))
    .digest('hex');
}

module.exports = {
  SLOT_MIN_INDEX,
  SLOT_MAX_INDEX,
  SLOT_COUNT,
  EGRESS_PORT_BASE,
  EGRESS_PORT_MIN,
  EGRESS_PORT_MAX,
  ROUTING_PLANES,
  HEALTH_STATES,
  CONTROL_ROUTING_PLANE,
  STRICT_CONTROL_HEADER,
  UNSAFE_HEALTH_STATES,
  DEFAULT_EGRESS_BUS_URL,
  EGRESS_BUS_URL,
  CF_SERVICE_PORT,
  CONTROL_HOSTS,
  EgressSafetyError,
  unsafeEgress,
  isMatrixIndex,
  slotIdForIndex,
  indexForSlotId,
  egressPortForIndex,
  egressPortForSlotId,
  matrixSlotIdForPort,
  isMatrixPort,
  normalizeRoutingPlane,
  normalizeHealthState,
  expandIpv6,
  normalizePrefix64,
  normalizeIpv4,
  emptyFingerprint,
  normalizeFingerprint,
  validateLeaseRecord,
  isEgressSafeForControl,
  hostMatchesDomain,
  isControlPlaneHost,
  controlAuthorization,
  strictControlHeaders,
  fingerprintDigest,
};
