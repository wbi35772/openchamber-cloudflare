'use strict';

/*
 * Risk engine: local token bucket, persisted sliding window, Poisson pacing,
 * response classification and the three-level circuit breaker
 * (ACTIVE -> COOLDOWN -> QUARANTINED).
 *
 * Split of responsibility:
 *   - the in-memory token bucket enforces the short-term 4 req/s ceiling
 *   - the vault-persisted 10s bucket array enforces the 950 req / 5 min budget
 *     across every process that shares the same data directory
 *   - evaluateResponseRisk() is the single place where Cloudflare status codes
 *     and cf-ray headers move an account between breaker states
 */

const { hash32 } = require('../lib/scheduler');

const ACTIVE = 'ACTIVE';
const COOLDOWN = 'COOLDOWN';
const QUARANTINED = 'QUARANTINED';

class RiskError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RiskError';
    this.code = code;
    if (details.accountId) this.accountId = details.accountId;
    if (Number.isFinite(details.retryAfterMs)) this.retryAfterMs = details.retryAfterMs;
    if (Number.isFinite(details.retryAt)) this.retryAt = details.retryAt;
    if (details.status) this.status = details.status;
    if (details.reason) this.reason = details.reason;
  }
}

function headerValue(headers, name) {
  if (!headers) return null;
  const key = String(name).toLowerCase();
  if (typeof headers.get === 'function') {
    const value = headers.get(key);
    return value == null ? null : String(value);
  }
  if (typeof headers.has === 'function' && headers.has(key)) {
    return String(headers.get(key));
  }
  for (const [header, value] of Object.entries(headers)) {
    if (header.toLowerCase() === key) {
      return Array.isArray(value) ? value.join(',') : String(value);
    }
  }
  return null;
}

function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Math.max(0, Math.round(Number(text) * 1000));
  }
  const date = Date.parse(text);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return 0;
}

function errorCodes(bodyJson) {
  const sources = [];
  if (Array.isArray(bodyJson?.errors)) sources.push(...bodyJson.errors);
  if (Array.isArray(bodyJson?.error_chain)) {
    for (const link of bodyJson.error_chain) {
      if (Array.isArray(link?.errors)) sources.push(...link.errors);
    }
  }
  return sources
    .map((entry) => (entry && typeof entry === 'object' ? entry.code : entry))
    .map((code) => Number(code))
    .filter((code) => Number.isInteger(code));
}

function poissonDelay(minMs, maxMs, random = Math.random) {
  const min = Math.max(0, Number(minMs) || 0);
  const max = Math.max(min, Number(maxMs) || min);
  if (max === 0) return 0;
  const mean = (min + max) / 2;
  const sample = -Math.log(1 - random());
  return Math.max(min, Math.min(max, Math.round(sample * mean)));
}

function computeBackoff(strikes, retryAfterMs, risk, random = Math.random) {
  if (retryAfterMs > 0) {
    return retryAfterMs + poissonDelay(risk.backoff.jitterMinMs, risk.backoff.jitterMaxMs, random);
  }
  const exponential = Math.min(risk.backoff.maxMs, risk.backoff.baseMs * Math.pow(2, strikes));
  return (
    Math.min(risk.backoff.maxMs, exponential) +
    poissonDelay(risk.backoff.jitterMinMs, risk.backoff.jitterMaxMs, random)
  );
}

/*
 * Pure-ish classifier. Mutates the supplied account state (the vault hands out
 * a mutable copy) and returns the action the caller must take.
 */
function evaluateResponseRisk(accountState, status, headers, bodyJson, options = {}) {
  const risk = options.risk || {};
  const random = options.random || Math.random;
  const at = typeof options.now === 'function' ? Number(options.now()) : Number(options.now || Date.now());
  const cfRay = headerValue(headers, 'cf-ray') || 'unknown';
  const remainingHeader = headerValue(headers, 'ratelimit-remaining');
  const remaining = remainingHeader == null ? 999 : Number(remainingHeader);
  const retryAfterMs = parseRetryAfter(headerValue(headers, 'retry-after'), at);
  const codes = errorCodes(bodyJson);
  const quarantineCodes = risk.quarantineCodes || [10000, 9103, 9106, 9109];
  const cooldownCodes = risk.cooldownCodes || [1015];
  const remainingThreshold = Number.isFinite(risk.remainingThreshold) ? risk.remainingThreshold : 50;

  if (accountState.status === QUARANTINED) {
    return { action: 'ALREADY_QUARANTINED', cfRay, status: QUARANTINED };
  }

  accountState.lastRay = cfRay;
  accountState.lastStatus = status;
  accountState.lastCheckedAt = at;

  const bannedByStatus = status === 401 || status === 403;
  const bannedByCode = codes.some((code) => quarantineCodes.includes(code));
  if (bannedByStatus || bannedByCode) {
    accountState.status = QUARANTINED;
    accountState.strikes = (accountState.strikes || 0) + 1;
    accountState.healthScore = 0;
    accountState.quarantineReason = `auth/ban (HTTP ${status}, codes ${codes.join(',') || 'none'}, ray ${cfRay})`;
    accountState.quarantinedAt = at;
    accountState.updatedAt = at;
    accountState.lastError = accountState.quarantineReason;
    accountState.failureCount = (accountState.failureCount || 0) + 1;
    return {
      action: 'ABORT_AND_ISOLATE',
      cfRay,
      status: QUARANTINED,
      reason: accountState.quarantineReason,
    };
  }

  const throttled =
    status === 429 ||
    codes.some((code) => cooldownCodes.includes(code)) ||
    (remainingHeader != null && remaining < remainingThreshold);
  if (throttled) {
    accountState.strikes = (accountState.strikes || 0) + 1;
    const backoffMs = computeBackoff(accountState.strikes, retryAfterMs, {
      backoff: risk.backoff || { baseMs: 30000, maxMs: 3600000, jitterMinMs: 1000, jitterMaxMs: 5000 },
    }, random);
    accountState.status = COOLDOWN;
    accountState.cooldownUntil = at + backoffMs;
    accountState.healthScore = Math.max(0, (accountState.healthScore ?? 100) - 10);
    accountState.updatedAt = at;
    accountState.lastError = `rate limited (HTTP ${status}, remaining ${remainingHeader ?? 'n/a'}, ray ${cfRay})`;
    accountState.failureCount = (accountState.failureCount || 0) + 1;
    return {
      action: 'RETRY_ON_OTHER_ACCOUNT',
      cfRay,
      status: COOLDOWN,
      backoffMs,
      retryAt: accountState.cooldownUntil,
      reason: 'rate-limited',
    };
  }

  if (status >= 500) {
    accountState.strikes = Math.min(10, (accountState.strikes || 0) + 1);
    accountState.healthScore = Math.max(0, (accountState.healthScore ?? 100) - 5);
    accountState.failureCount = (accountState.failureCount || 0) + 1;
    accountState.updatedAt = at;
    accountState.lastError = `upstream error HTTP ${status} (ray ${cfRay})`;
    return { action: 'FAIL', cfRay, status: accountState.status, reason: `http-${status}` };
  }

  accountState.strikes = Math.max(0, (accountState.strikes || 0) - 1);
  accountState.status = ACTIVE;
  accountState.cooldownUntil = 0;
  accountState.healthScore = Math.min(100, (accountState.healthScore ?? 100) + (status < 400 ? 1 : 0));
  accountState.updatedAt = at;
  if (status < 400) {
    accountState.successCount = (accountState.successCount || 0) + 1;
    accountState.lastError = null;
  } else {
    accountState.failureCount = (accountState.failureCount || 0) + 1;
    accountState.lastError = `HTTP ${status} (ray ${cfRay})`;
  }
  return { action: 'PASS', cfRay, status: ACTIVE };
}

function bucketStartFor(at, bucketMs) {
  return Math.floor(at / bucketMs) * bucketMs;
}

function pruneBuckets(buckets, now, windowMs, bucketMs) {
  const oldest = now - windowMs;
  return (Array.isArray(buckets) ? buckets : []).filter(
    (bucket) => Array.isArray(bucket) && Number(bucket[0]) + bucketMs > oldest,
  );
}

function windowUsage(buckets, now, windowMs, bucketMs) {
  return pruneBuckets(buckets, now, windowMs, bucketMs).reduce(
    (sum, bucket) => sum + (Number(bucket[1]) || 0),
    0,
  );
}

function createRiskEngine(options = {}) {
  const vault = options.vault;
  if (!vault) throw new Error('createRiskEngine requires a vault');
  const config = options.config;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep =
    typeof options.sleep === 'function'
      ? options.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const onAlert = typeof options.onAlert === 'function' ? options.onAlert : () => {};

  const local = new Map();

  function localFor(accountId) {
    let bucket = local.get(accountId);
    if (!bucket) {
      bucket = {
        tokens: config.risk.burst,
        lastRefillAt: now(),
        phase: (hash32(accountId) % 1000) / 1000,
      };
      local.set(accountId, bucket);
    }
    return bucket;
  }

  function refill(bucket, at) {
    const elapsed = Math.max(0, at - bucket.lastRefillAt);
    const gained = (elapsed / 1000) * config.risk.rps;
    bucket.tokens = Math.min(config.risk.burst, bucket.tokens + gained);
    bucket.lastRefillAt = at;
  }

  async function waitForLocalToken(accountId) {
    const bucket = localFor(accountId);
    for (;;) {
      const at = now();
      refill(bucket, at);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      const deficit = 1 - bucket.tokens;
      await sleep(Math.max(5, Math.ceil((deficit / config.risk.rps) * 1000)));
    }
  }

  async function reserveWindow(accountId) {
    return vault.mutateState(accountId, (state) => {
      const at = now();
      const { windowMs, windowBucketMs, windowLimit } = config.risk;
      let buckets = pruneBuckets(state.budget?.buckets, at, windowMs, windowBucketMs);
      const used = buckets.reduce((sum, bucket) => sum + (Number(bucket[1]) || 0), 0);
      if (used >= windowLimit) {
        const oldest = buckets.reduce(
          (min, bucket) => Math.min(min, Number(bucket[0])),
          Number.POSITIVE_INFINITY,
        );
        const resetAt = oldest + windowMs;
        throw new RiskError(
          'RISK_WINDOW_EXHAUSTED',
          `account ${accountId} hit the ${windowLimit} req / ${windowMs} ms window`,
          { accountId, retryAfterMs: Math.max(0, resetAt - at), retryAt: resetAt },
        );
      }
      const start = bucketStartFor(at, windowBucketMs);
      const current = buckets.find((bucket) => Number(bucket[0]) === start);
      if (current) current[1] = (Number(current[1]) || 0) + 1;
      else buckets.push([start, 1]);
      buckets = buckets.sort((a, b) => a[0] - b[0]);
      const maxBuckets = Math.ceil(windowMs / windowBucketMs) + 2;
      if (buckets.length > maxBuckets) buckets = buckets.slice(-maxBuckets);
      state.budget = { buckets, lastReservedAt: at };
      return { used: used + 1, remaining: windowLimit - used - 1 };
    });
  }

  async function acquire(accountId, options = {}) {
    const urgent = Boolean(options.urgent);
    const state = vault.state(accountId);
    if (!state) {
      throw new RiskError('RISK_UNKNOWN_ACCOUNT', `account "${accountId}" not found`, { accountId });
    }
    if (state.status === QUARANTINED) {
      throw new RiskError('RISK_QUARANTINED', `account ${accountId} is quarantined`, {
        accountId,
        status: QUARANTINED,
        reason: state.quarantineReason,
      });
    }
    const at = now();
    if (state.status === COOLDOWN && state.cooldownUntil > at) {
      throw new RiskError('RISK_COOLDOWN', `account ${accountId} cooling down`, {
        accountId,
        status: COOLDOWN,
        retryAt: state.cooldownUntil,
        retryAfterMs: state.cooldownUntil - at,
      });
    }
    if (state.status === COOLDOWN && state.cooldownUntil <= at) {
      await vault.mutateState(accountId, (current) => {
        if (current.status === COOLDOWN && current.cooldownUntil <= now()) {
          current.status = ACTIVE;
          current.cooldownUntil = 0;
          current.strikes = 0;
        }
        return current;
      });
    }

    await waitForLocalToken(accountId);
    const budget = await reserveWindow(accountId);

    if (!urgent) {
      const phaseDelay = state.lastUsedAt
        ? 0
        : Math.round((localFor(accountId).phase * config.risk.jitter.minMs) / 2);
      const delay = poissonDelay(
        config.risk.jitter.minMs,
        config.risk.jitter.maxMs,
        random,
      );
      await sleep(delay + phaseDelay);
    }

    return { accountId, budget, at: now() };
  }

  async function report(accountId, result = {}) {
    const outcome = await vault.mutateState(accountId, (state) => {
      if (state.status === QUARANTINED) {
        return { verdict: { action: 'ALREADY_QUARANTINED', status: QUARANTINED }, state: { ...state } };
      }
      state.lastUsedAt = now();
      if (result.error) {
        state.strikes = Math.min(10, (state.strikes || 0) + 1);
        state.healthScore = Math.max(0, (state.healthScore ?? 100) - 3);
        state.failureCount = (state.failureCount || 0) + 1;
        state.lastError = `${result.error.code || 'ERR'}: ${result.error.message || result.error}`;
        state.updatedAt = now();
        return { verdict: { action: 'ERROR', reason: state.lastError }, state: { ...state } };
      }
      const verdict = evaluateResponseRisk(state, result.status, result.headers, result.body, {
        risk: config.risk,
        random,
        now,
      });
      state.updatedAt = now();
      return { verdict, state: { ...state } };
    });

    const { verdict, state } = outcome;
    if (verdict.action === 'ABORT_AND_ISOLATE') {
      local.delete(accountId);
      onAlert({ type: 'quarantine', accountId, reason: verdict.reason, cfRay: verdict.cfRay });
    } else if (verdict.action === 'RETRY_ON_OTHER_ACCOUNT') {
      onAlert({ type: 'cooldown', accountId, retryAt: verdict.retryAt, cfRay: verdict.cfRay });
    }
    return { ...verdict, state };
  }

  return {
    acquire,
    report,
    evaluate(accountId, status, headers, body) {
      const state = vault.state(accountId);
      const verdict = evaluateResponseRisk(state, status, headers, body, {
        risk: config.risk,
        random,
        now,
      });
      return verdict;
    },
    snapshot(accountId) {
      const state = vault.state(accountId);
      if (!state) return null;
      const at = now();
      const used = windowUsage(state.budget?.buckets, at, config.risk.windowMs, config.risk.windowBucketMs);
      return {
        accountId,
        status: state.status,
        strikes: state.strikes || 0,
        cooldownUntil: state.cooldownUntil || 0,
        quarantineReason: state.quarantineReason || null,
        healthScore: state.healthScore ?? 100,
        lastRay: state.lastRay || null,
        window: {
          used,
          limit: config.risk.windowLimit,
          remaining: Math.max(0, config.risk.windowLimit - used),
          windowMs: config.risk.windowMs,
        },
        local: { ...(local.get(accountId) || { tokens: config.risk.burst }) },
      };
    },
    report429(accountId, retryAfterSeconds) {
      return report(accountId, {
        status: 429,
        headers: { 'retry-after': String(retryAfterSeconds || 0) },
        body: null,
      });
    },
    reset(accountId) {
      local.delete(accountId);
    },
    rank(accounts) {
      const at = now();
      return [...accounts]
        .map((account) => {
          const state = vault.state(account.id) || {};
          const used = windowUsage(
            state.budget?.buckets,
            at,
            config.risk.windowMs,
            config.risk.windowBucketMs,
          );
          const statusRank = state.status === ACTIVE ? 0 : state.status === COOLDOWN ? 1 : 2;
          return { account, state, used, statusRank };
        })
        .sort((a, b) => {
          if (a.statusRank !== b.statusRank) return a.statusRank - b.statusRank;
          if (b.state.healthScore !== a.state.healthScore) {
            return (b.state.healthScore ?? 100) - (a.state.healthScore ?? 100);
          }
          if (a.used !== b.used) return a.used - b.used;
          return (a.state.lastUsedAt || 0) - (b.state.lastUsedAt || 0);
        });
    },
  };
}

module.exports = {
  createRiskEngine,
  evaluateResponseRisk,
  computeBackoff,
  poissonDelay,
  parseRetryAfter,
  headerValue,
  errorCodes,
  windowUsage,
  RiskError,
  ACTIVE,
  COOLDOWN,
  QUARANTINED,
};
