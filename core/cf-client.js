'use strict';

/*
 * Cloudflare API v4 client bound to the multi-account matrix.
 *
 * Every call goes through risk-engine (token bucket, window budget, breaker)
 * and net-binder (1:1 proxy port, fail-closed). There is deliberately no code
 * path that talks to api.cloudflare.com directly.
 */

const crypto = require('node:crypto');
const { RiskError } = require('./risk-engine');

const MIN_QUOTA_DEFAULT = 5;
const DNS_TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA', 'PTR']);

class CfApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CfApiError';
    this.code = details.code || 'CF_API_ERROR';
    this.accountId = details.accountId || null;
    this.status = details.status || 0;
    this.cfRay = details.cfRay || null;
    this.errors = details.errors || [];
    this.messages = details.messages || [];
    this.result = details.result ?? null;
    this.retryOther = Boolean(details.retryOther);
    this.retryAfterMs = details.retryAfterMs || 0;
  }
}

function makeErrorFromBody(accountId, status, cfRay, body) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const codes = errors.map((entry) => Number(entry?.code)).filter(Number.isInteger);
  const auth = status === 401 || status === 403 || codes.some((code) => [10000, 9103, 9106, 9109].includes(code));
  const throttled = status === 429 || codes.includes(1015);
  const description =
    errors.map((entry) => `${entry.code ?? '?'} ${entry.message ?? ''}`.trim()).join('; ') ||
    `HTTP ${status}`;
  return new CfApiError(`Cloudflare API error: ${description}`, {
    accountId,
    status,
    cfRay,
    errors,
    messages,
    result: body?.result ?? null,
    retryOther: auth || throttled,
  });
}

function joinUrl(base, path) {
  const root = base.replace(/\/+$/, '');
  const text = String(path);
  if (/^https?:\/\//i.test(text)) {
    if (text !== root && !text.startsWith(`${root}/`) && !text.startsWith(`${root}?`)) {
      throw new CfApiError('absolute request URL must stay inside apiBase', {
        code: 'ERR_URL_SCOPE',
      });
    }
    return text;
  }
  return `${root}/${text.replace(/^\/+/, '')}`;
}

function withQuery(url, query) {
  if (!query) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) parsed.searchParams.append(key, String(item));
    } else {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
}

function buildMultipart(fields) {
  const boundary = `----cfmatrix${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];
  for (const field of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const filename = field.filename ? `; filename="${field.filename}"` : '';
    chunks.push(
      Buffer.from(
        `Content-Disposition: form-data; name="${field.name}"${filename}\r\nContent-Type: ${
          field.contentType || 'text/plain'
        }\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.isBuffer(field.value) ? field.value : Buffer.from(String(field.value)));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function normalizeRecordName(name, zoneName) {
  const text = String(name || '@').trim();
  if (!text || text === '@') return zoneName;
  if (text === zoneName || text.endsWith(`.${zoneName}`)) return text;
  return `${text}.${zoneName}`;
}

function zoneFromState(state, zoneName) {
  const cached = state?.zones?.[zoneName];
  if (!cached || !cached.id) return null;
  return cached;
}

function createCfClient(options = {}) {
  const vault = options.vault;
  const risk = options.risk;
  const net = options.net;
  const config = options.config;
  if (!vault || !risk || !net) throw new Error('createCfClient requires vault, risk and net');
  const currentApiBase = () => config.apiBase;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleep =
    typeof options.sleep === 'function'
      ? options.sleep
      : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};

  function profiles() {
    return vault.list().filter((account) => account.enabled !== false);
  }

  function resolveProfile(idOrLabel) {
    const found = vault.get(idOrLabel);
    if (!found) throw new CfApiError(`account "${idOrLabel}" not found`, { code: 'ERR_ACCOUNT_NOT_FOUND' });
    return found;
  }

  function authHeaders(credentials) {
    if (credentials.authType === 'key') {
      return { 'x-auth-email': credentials.email, 'x-auth-key': credentials.apiKey };
    }
    return { authorization: `Bearer ${credentials.token}` };
  }

  function selectOptimalAccount(selector = {}) {
    const tag = selector.tag ? String(selector.tag) : null;
    const requiredQuota = Number.isFinite(selector.requiredQuota)
      ? Number(selector.requiredQuota)
      : MIN_QUOTA_DEFAULT;
    const exclude = new Set(selector.exclude || []);
    const candidates = profiles().filter((account) => {
      if (exclude.has(account.id) || exclude.has(account.label)) return false;
      if (tag && !(account.tags || []).includes(tag)) return false;
      return true;
    });
    const ranked = risk.rank(candidates);
    for (const entry of ranked) {
      if (entry.state.status === 'QUARANTINED') continue;
      if (entry.state.status === 'COOLDOWN' && Number(entry.state.cooldownUntil) > now()) continue;
      const remaining = config.risk.windowLimit - entry.used;
      if (remaining < requiredQuota) continue;
      if (selector.zoneName) {
        const zone = zoneFromState(entry.state, selector.zoneName);
        if (selector.requireZoneCache && !zone) continue;
      }
      return {
        id: entry.account.id,
        label: entry.account.label,
        profile: entry.account,
        status: entry.state.status || 'ACTIVE',
        healthScore: entry.state.healthScore ?? 100,
        remaining,
        used: entry.used,
      };
    }
    return null;
  }

  async function requestOnce(accountId, path, requestOptions = {}) {
    const profile = resolveProfile(accountId);
    const credentials = vault.credentials(profile.id);
    const url = withQuery(joinUrl(currentApiBase(), path), requestOptions.query);
    const method = String(requestOptions.method || 'GET').toUpperCase();
    const headers = { ...authHeaders(credentials), ...(requestOptions.headers || {}) };
    let body = requestOptions.body;
    if (body !== undefined && body !== null && !Buffer.isBuffer(body) && typeof body !== 'string') {
      body = JSON.stringify(body);
      headers['content-type'] = headers['content-type'] || 'application/json';
    }
    if (Buffer.isBuffer(body) && !headers['content-length']) {
      headers['content-length'] = String(body.length);
    }

    const reservation = await risk.acquire(profile.id, { urgent: Boolean(requestOptions.urgent) });
    let response;
    try {
      response = await net.request(profile.id, url, {
        method,
        headers,
        body: body ?? undefined,
        timeoutMs: requestOptions.timeoutMs || config.http.timeoutMs,
        signal: requestOptions.signal,
      });
    } catch (error) {
      const verdict = await risk.report(profile.id, { error });
      onEvent({
        type: 'request-error',
        accountId: profile.id,
        method,
        url,
        code: error.code,
        verdict: verdict.action,
      });
      throw error;
    }

    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    const verdict = await risk.report(profile.id, {
      status: response.status,
      headers: response.headers,
      body: parsed,
    });
    onEvent({
      type: 'request',
      accountId: profile.id,
      method,
      path: url.startsWith(currentApiBase()) ? url.slice(currentApiBase().length) : url,
      status: response.status,
      cfRay: verdict.cfRay,
      action: verdict.action,
      budget: reservation.budget,
    });

    const result = {
      accountId: profile.id,
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body: parsed,
      text,
      cfRay: verdict.cfRay || response.headers.get('cf-ray') || null,
      verdict,
    };

    if (!response.ok) {
      const error = makeErrorFromBody(profile.id, response.status, result.cfRay, parsed);
      error.retryAfterMs = Number(verdict.backoffMs) || 0;
      throw error;
    }
    if (parsed && parsed.success === false) {
      const error = makeErrorFromBody(profile.id, response.status || 400, result.cfRay, parsed);
      throw error;
    }
    return result;
  }

  async function call(accountId, path, requestOptions = {}) {
    const attempts = Math.max(1, (requestOptions.retries ?? config.http.maxRetries) + 1);
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await requestOnce(accountId, path, requestOptions);
      } catch (error) {
        lastError = error;
        const retryableStatus =
          error instanceof CfApiError && (config.http.retryStatuses.includes(error.status) || error.status === 0);
        if (!retryableStatus || attempt === attempts - 1) throw error;
        await sleep(config.http.retryBaseMs * (attempt + 1));
      }
    }
    throw lastError;
  }

  async function callWithFailover(primaryId, path, requestOptions = {}) {
    const tried = new Set();
    const ordered = [];
    if (primaryId) ordered.push(primaryId);
    if (requestOptions.allowFailover !== false) {
      const selector = {
        tag: requestOptions.tag,
        requiredQuota: requestOptions.requiredQuota || MIN_QUOTA_DEFAULT,
        zoneName: requestOptions.zoneName,
      };
      for (let index = 0; index < 8; index += 1) {
        const pick = selectOptimalAccount({ ...selector, exclude: [...tried, ...ordered] });
        if (!pick) break;
        ordered.push(pick.id);
      }
    }
    if (!ordered.length) {
      throw new CfApiError('no usable Cloudflare account in the matrix', { code: 'ERR_NO_ACCOUNT' });
    }

    const failures = [];
    for (const accountId of ordered) {
      if (tried.has(accountId)) continue;
      tried.add(accountId);
      try {
        return await call(accountId, path, requestOptions);
      } catch (error) {
        failures.push({ accountId, code: error.code, status: error.status || 0, message: error.message });
        const canFailover =
          error instanceof RiskError
            ? ['RISK_COOLDOWN', 'RISK_QUARANTINED', 'RISK_WINDOW_EXHAUSTED'].includes(error.code)
            : error instanceof CfApiError && error.retryOther;
        if (!canFailover || requestOptions.allowFailover === false) throw error;
      }
    }
    const error = new CfApiError('every matrix account failed for this call', {
      code: 'ERR_ALL_ACCOUNTS_FAILED',
    });
    error.failures = failures;
    throw error;
  }

  async function verifyAccount(accountId) {
    const profile = resolveProfile(accountId);
    const path = profile.authType === 'key' ? 'user' : 'user/tokens/verify';
    let response;
    try {
      response = await requestOnce(profile.id, path, { urgent: true, retries: 0 });
    } catch (error) {
      if (error instanceof CfApiError && error.retryOther) {
        return { accountId: profile.id, ok: false, status: error.status, error: error.message };
      }
      throw error;
    }
    const result = response.body?.result || null;
    await vault.mutateState(profile.id, (state) => {
      state.lastVerifiedAt = now();
      state.verifyStatus = result?.status || 'active';
      return state;
    });
    return {
      accountId: profile.id,
      ok: true,
      status: result?.status || 'active',
      expiresOn: result?.expires_on || null,
      cfRay: response.cfRay,
    };
  }

  async function listZones(accountId, options = {}) {
    const runner = accountId ? call : callWithFailover;
    const response = await runner(accountId, 'zones', {
      query: { page: options.page || 1, per_page: options.perPage || 50, name: options.name },
      urgent: options.urgent,
      tag: options.tag,
    });
    return response.body?.result || [];
  }

  async function ensureZone(accountId, domain, options = {}) {
    const profile = resolveProfile(accountId);
    const existing = await call(profile.id, 'zones', {
      query: { name: domain, per_page: 5 },
      urgent: false,
    });
    const zone = (existing.body?.result || []).find((entry) => entry.name === domain);
    if (zone) {
      await vault.mutateState(profile.id, (state) => {
        state.zones = state.zones || {};
        state.zones[domain] = { id: zone.id, status: zone.status, cachedAt: now() };
      });
      return { zone, created: false };
    }
    if (options.createZone === false) {
      throw new CfApiError(`zone ${domain} does not exist on account "${profile.label}"`, {
        code: 'ERR_ZONE_NOT_FOUND',
        accountId: profile.id,
      });
    }
    const cfAccountId = options.cloudflareAccountId || profile.cloudflareAccountId;
    if (!cfAccountId) {
      throw new CfApiError(
        `account "${profile.label}" has no cloudflareAccountId; cannot create zone ${domain}`,
        { code: 'ERR_CF_ACCOUNT_ID', accountId: profile.id },
      );
    }
    const created = await call(profile.id, 'zones', {
      method: 'POST',
      body: {
        name: domain,
        account: { id: cfAccountId },
        type: options.type || 'full',
        jump_start: Boolean(options.jumpStart),
      },
    });
    const createdZone = created.body?.result;
    await vault.mutateState(profile.id, (state) => {
      state.zones = state.zones || {};
      state.zones[domain] = { id: createdZone.id, status: createdZone.status, cachedAt: now() };
    });
    return { zone: createdZone, created: true };
  }

  async function listDnsRecords(accountId, zoneId, query = {}) {
    const profile = resolveProfile(accountId);
    const response = await call(profile.id, `zones/${zoneId}/dns_records`, {
      query: { per_page: query.perPage || 100, page: query.page || 1, ...query },
    });
    return response.body?.result || [];
  }

  async function ensureZoneAndDns(accountId, domain, records = [], options = {}) {
    const profile = resolveProfile(accountId);
    const { zone, created: zoneCreated } = await ensureZone(profile.id, domain, options);
    const zoneId = zone.id;
    const summary = { zoneId, zoneName: domain, zoneCreated, created: [], updated: [], unchanged: [], records: [] };

    for (const input of records) {
      if (!input || !input.type) throw new CfApiError('each DNS record needs a type', { code: 'ERR_DNS_INPUT' });
      const type = String(input.type).toUpperCase();
      if (!DNS_TYPES.has(type)) {
        throw new CfApiError(`unsupported DNS record type "${type}"`, { code: 'ERR_DNS_TYPE' });
      }
      const name = normalizeRecordName(input.name, domain);
      const desired = {
        type,
        name,
        content: String(input.content ?? ''),
        ttl: input.ttl === undefined ? 1 : Number(input.ttl),
        proxied: input.proxied === undefined ? undefined : Boolean(input.proxied),
        priority: input.priority === undefined ? undefined : Number(input.priority),
        comment: input.comment === undefined ? undefined : String(input.comment),
      };
      if (desired.content === '') {
        throw new CfApiError(`DNS record ${name} (${type}) has empty content`, { code: 'ERR_DNS_CONTENT' });
      }
      if (desired.proxied && type !== 'A' && type !== 'AAAA' && type !== 'CNAME') {
        delete desired.proxied;
      }

      const listed = await call(profile.id, `zones/${zoneId}/dns_records`, {
        query: { name, type, per_page: 100 },
      });
      const matches = (listed.body?.result || []).filter(
        (entry) => entry.name === name && entry.type === type,
      );

      if (matches.length) {
        const current = matches[0];
        const changed =
          current.content !== desired.content ||
          Number(current.ttl ?? 1) !== Number(desired.ttl ?? 1) ||
          (desired.proxied !== undefined && Boolean(current.proxied) !== desired.proxied) ||
          (desired.priority !== undefined && Number(current.priority) !== desired.priority) ||
          (desired.comment !== undefined && String(current.comment || '') !== desired.comment);

        if (!changed) {
          summary.unchanged.push({ id: current.id, name, type });
          summary.records.push({ id: current.id, name, type, content: current.content });
          continue;
        }
        const patch = { type, name, content: desired.content, ttl: desired.ttl };
        if (desired.proxied !== undefined) patch.proxied = desired.proxied;
        if (desired.priority !== undefined) patch.priority = desired.priority;
        if (desired.comment !== undefined) patch.comment = desired.comment;
        const updated = await call(profile.id, `zones/${zoneId}/dns_records/${current.id}`, {
          method: 'PATCH',
          body: patch,
        });
        summary.updated.push({ id: updated.body?.result?.id || current.id, name, type });
        summary.records.push({ id: updated.body?.result?.id || current.id, name, type, content: desired.content });
        continue;
      }

      const createBody = { type, name, content: desired.content, ttl: desired.ttl };
      if (desired.proxied !== undefined) createBody.proxied = desired.proxied;
      if (desired.priority !== undefined) createBody.priority = desired.priority;
      if (desired.comment !== undefined) createBody.comment = desired.comment;
      const created = await call(profile.id, `zones/${zoneId}/dns_records`, {
        method: 'POST',
        body: createBody,
      });
      summary.created.push({ id: created.body?.result?.id, name, type });
      summary.records.push({
        id: created.body?.result?.id,
        name,
        type,
        content: desired.content,
      });
    }
    return summary;
  }

  async function deleteDnsRecord(accountId, zoneId, recordId) {
    const profile = resolveProfile(accountId);
    const response = await call(profile.id, `zones/${zoneId}/dns_records/${recordId}`, {
      method: 'DELETE',
    });
    return response.body?.result || null;
  }

  async function resolveCfAccountId(accountId, options = {}) {
    const profile = resolveProfile(accountId);
    if (options.cloudflareAccountId) return String(options.cloudflareAccountId);
    if (profile.cloudflareAccountId) return profile.cloudflareAccountId;
    const response = await call(profile.id, 'accounts', { query: { per_page: 50 } });
    const accounts = response.body?.result || [];
    if (accounts.length === 1) {
      await vault.mutateState(profile.id, (state) => {
        state.resolvedCloudflareAccountId = accounts[0].id;
      });
      return accounts[0].id;
    }
    if (accounts.length === 0) {
      throw new CfApiError('token cannot see any Cloudflare account', { code: 'ERR_NO_CF_ACCOUNT' });
    }
    const error = new CfApiError(
      `account "${profile.label}" can see ${accounts.length} Cloudflare accounts; pass cloudflareAccountId`,
      { code: 'ERR_AMBIGUOUS_CF_ACCOUNT' },
    );
    error.accounts = accounts.map((entry) => ({ id: entry.id, name: entry.name }));
    throw error;
  }

  async function provisionZeroTrustTunnel(accountId, tunnelName, ingressRules = [], options = {}) {
    const profile = resolveProfile(accountId);
    const cfAccountId = await resolveCfAccountId(profile.id, options);
    const name = String(tunnelName || '').trim();
    if (!name) throw new CfApiError('tunnelName is required', { code: 'ERR_TUNNEL_NAME' });

    let tunnel = null;
    const listed = await call(profile.id, `accounts/${cfAccountId}/cfd_tunnel`, {
      query: { name, is_deleted: false, per_page: 20 },
    });
    tunnel = (listed.body?.result || []).find((entry) => entry.name === name) || null;

    if (!tunnel) {
      const created = await call(profile.id, `accounts/${cfAccountId}/cfd_tunnel`, {
        method: 'POST',
        body: { name, config_src: options.configSrc || 'cloudflare' },
      });
      tunnel = created.body?.result;
    }

    const ingress = [...ingressRules];
    if (!ingress.some((rule) => !rule.hostname && rule.service)) {
      ingress.push({ service: 'http_status:404' });
    }
    if (ingress.length) {
      await call(profile.id, `accounts/${cfAccountId}/cfd_tunnel/${tunnel.id}/configurations`, {
        method: 'PUT',
        body: { config: { ingress } },
      });
    }

    let token = tunnel.token || null;
    if (!token) {
      const tokenResponse = await call(profile.id, `accounts/${cfAccountId}/cfd_tunnel/${tunnel.id}/token`);
      token = tokenResponse.body?.result || null;
    }

    return {
      accountId: profile.id,
      cloudflareAccountId: cfAccountId,
      tunnelId: tunnel.id,
      name: tunnel.name,
      token,
      ingress,
    };
  }

  async function deployWorkerScript(accountId, scriptName, code, bindings = [], options = {}) {
    const profile = resolveProfile(accountId);
    const cfAccountId = await resolveCfAccountId(profile.id, options);
    const name = String(scriptName || '').trim();
    if (!name) throw new CfApiError('scriptName is required', { code: 'ERR_WORKER_NAME' });
    const filename = options.filename || 'worker.js';
    const metadata = {
      main_module: filename,
      bindings: bindings || [],
      compatibility_date: options.compatibilityDate || new Date().toISOString().slice(0, 10),
      ...(options.metadata || {}),
    };
    if (options.compatibilityFlags) metadata.compatibility_flags = options.compatibilityFlags;

    const multipart = buildMultipart([
      {
        name: 'metadata',
        contentType: 'application/json',
        value: JSON.stringify(metadata),
      },
      {
        name: filename,
        filename,
        contentType: options.contentType || 'application/javascript+module',
        value: Buffer.isBuffer(code) ? code : Buffer.from(String(code), 'utf8'),
      },
    ]);

    const response = await call(profile.id, `accounts/${cfAccountId}/workers/scripts/${name}`, {
      method: 'PUT',
      headers: { 'content-type': multipart.contentType },
      body: multipart.body,
      retries: options.retries,
    });
    return {
      accountId: profile.id,
      cloudflareAccountId: cfAccountId,
      script: response.body?.result?.id || name,
      etag: response.headers.get('etag') || null,
    };
  }

  async function listTunnels(accountId, options = {}) {
    const profile = resolveProfile(accountId);
    const cfAccountId = await resolveCfAccountId(profile.id, options);
    const response = await call(profile.id, `accounts/${cfAccountId}/cfd_tunnel`, {
      query: { is_deleted: false, per_page: options.perPage || 50 },
    });
    return response.body?.result || [];
  }

  return {
    profiles,
    resolveProfile,
    selectOptimalAccount,
    requestOnce,
    call,
    callWithFailover,
    verifyAccount,
    listZones,
    ensureZone,
    listDnsRecords,
    ensureZoneAndDns,
    deleteDnsRecord,
    resolveCfAccountId,
    provisionZeroTrustTunnel,
    deployWorkerScript,
    listTunnels,
    get apiBase() {
      return config.apiBase;
    },
  };
}

module.exports = {
  createCfClient,
  CfApiError,
  makeErrorFromBody,
  buildMultipart,
  normalizeRecordName,
  joinUrl,
  withQuery,
  DNS_TYPES,
};
