'use strict';

/*
 * JSON-RPC style bridge used by the OpenChamber host, the CLI and tests.
 * Method names follow the `cf.*` namespace from the design document.
 */

const { VaultError } = require('../core/vault-store');
const { RiskError } = require('../core/risk-engine');
const { CfApiError } = require('../core/cf-client');
const { ProxyUnavailableError, BindingError } = require('../core/net-binder');

class RpcError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    if (details) this.details = details;
  }
}

function requireString(params, key) {
  const value = params[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcError('ERR_PARAMS', `"${key}" must be a non-empty string`);
  }
  return value.trim();
}

function optionalBoolean(params, key) {
  return params[key] === undefined ? undefined : Boolean(params[key]);
}

function serializeError(error) {
  const details = {};
  for (const key of [
    'accountId',
    'proxyPort',
    'status',
    'retryAt',
    'retryAfterMs',
    'reason',
    'cfRay',
    'errors',
    'messages',
    'failures',
    'accounts',
    'cause',
  ]) {
    if (error[key] !== undefined && error[key] !== null) details[key] = error[key];
  }
  if (error.details) details.details = error.details;
  return {
    code: error.code || 'ERR_INTERNAL',
    message: error.message || String(error),
    details: Object.keys(details).length ? details : undefined,
  };
}

function createRpcHandler(matrix) {
  if (!matrix) throw new Error('createRpcHandler requires a matrix instance');
  const {
    vault,
    risk,
    net,
    client,
    config,
    saveConfig,
    configPath,
    dataDir,
    masterKeySource,
    masterKeyPath,
    nextFreePort,
  } = matrix;

  function pickAccount(params, selector = {}) {
    if (params.id) return params.id;
    const pick = client.selectOptimalAccount({
      tag: params.tag,
      requiredQuota: params.requiredQuota,
      zoneName: selector.zoneName,
    });
    if (!pick) {
      throw new RpcError('ERR_NO_ACCOUNT', 'no ACTIVE account with enough budget for this request');
    }
    return pick.id;
  }

  const methods = {
    'cf.matrix.status'() {
      const snapshot = vault.snapshot();
      return {
        apiBase: config.apiBase,
        portRange: [config.portStart, config.portEnd],
        risk: {
          rps: config.risk.rps,
          burst: config.risk.burst,
          windowLimit: config.risk.windowLimit,
          windowMs: config.risk.windowMs,
          jitterMs: [config.risk.jitter.minMs, config.risk.jitter.maxMs],
        },
        dataDir: vault.dataDir,
        configPath,
        masterKeySource,
        masterKeyPath,
        accounts: snapshot.accounts.length,
        bindings: net.status(),
      };
    },

    'cf.config.get'() {
      return {
        configPath,
        dataDir,
        masterKeySource,
        masterKeyPath,
        config: JSON.parse(JSON.stringify(config)),
      };
    },

    'cf.config.patch'(params) {
      if (typeof saveConfig !== 'function') {
        throw new RpcError('ERR_CONFIG_UNAVAILABLE', 'runtime config patch is not enabled');
      }
      const patch = params && params.patch !== undefined ? params.patch : params;
      return saveConfig(patch || {});
    },

    'cf.account.add'(params) {
      const requested = params.proxyPort === undefined ? undefined : Number(params.proxyPort);
      const proxyPort =
        requested === undefined && typeof nextFreePort === 'function' ? nextFreePort() : requested;
      if (!Number.isInteger(proxyPort) || proxyPort < config.portStart || proxyPort > config.portEnd) {
        throw new RpcError(
          'ERR_PORT_RANGE',
          `proxyPort must be inside ${config.portStart}-${config.portEnd}`,
        );
      }
      return vault.add({
        id: params.id,
        label: requireString(params, 'label'),
        authType: params.authType,
        token: params.token,
        apiKey: params.apiKey,
        email: params.email,
        cloudflareAccountId: params.cloudflareAccountId,
        tags: params.tags,
        proxyPort,
        egressIpv6: params.egressIpv6,
        enabled: optionalBoolean(params, 'enabled'),
      });
    },

    'cf.account.update'(params) {
      const id = requireString(params, 'id');
      const patch = { ...(params.patch || {}) };
      if (patch.proxyPort !== undefined) {
        const proxyPort = Number(patch.proxyPort);
        if (!Number.isInteger(proxyPort) || proxyPort < config.portStart || proxyPort > config.portEnd) {
          throw new RpcError('ERR_PORT_RANGE', `proxyPort must be inside ${config.portStart}-${config.portEnd}`);
        }
        patch.proxyPort = proxyPort;
      }
      return vault.update(id, patch);
    },

    'cf.account.remove'(params) {
      const id = requireString(params, 'id');
      const profile = vault.get(id);
      if (!profile) throw new RpcError('ERR_NOT_FOUND', `account "${id}" not found`);
      net.close(profile.id);
      return vault.remove(profile.id);
    },

    'cf.account.list'() {
      return vault.snapshot();
    },

    'cf.account.status'(params) {
      if (params.id) {
        const profile = vault.get(params.id);
        if (!profile) throw new RpcError('ERR_NOT_FOUND', `account "${params.id}" not found`);
        return {
          account: profile,
          state: vault.state(profile.id),
          risk: risk.snapshot(profile.id),
        };
      }
      return {
        accounts: vault.states().map((state) => ({
          ...state,
          risk: risk.snapshot(state.id),
        })),
        bindings: net.status(),
      };
    },

    async 'cf.account.verify'(params) {
      const id = requireString(params, 'id');
      return client.verifyAccount(id);
    },

    async 'cf.proxy.probe'(params) {
      const id = requireString(params, 'id');
      return net.probeEgress(id);
    },

    async 'cf.dns.sync'(params) {
      const domain = requireString(params, 'domain');
      const records = params.records;
      if (!Array.isArray(records)) throw new RpcError('ERR_PARAMS', '"records" must be an array');
      const id = pickAccount(params, { zoneName: domain });
      const summary = await client.ensureZoneAndDns(id, domain, records, {
        cloudflareAccountId: params.cloudflareAccountId,
        createZone: params.createZone !== false,
      });
      return { ...summary, accountId: id };
    },

    async 'cf.dns.list'(params) {
      const id = pickAccount(params);
      const zoneId = requireString(params, 'zoneId');
      return client.listDnsRecords(id, zoneId, {
        page: params.page,
        perPage: params.perPage,
      });
    },

    async 'cf.dns.delete'(params) {
      const id = pickAccount(params);
      const zoneId = requireString(params, 'zoneId');
      const recordId = requireString(params, 'recordId');
      return client.deleteDnsRecord(id, zoneId, recordId);
    },

    async 'cf.tunnel.spawn'(params) {
      const tunnelName = requireString(params, 'tunnelName');
      const ingress = Array.isArray(params.ingress) ? params.ingress : [];
      const id = pickAccount(params);
      const result = await client.provisionZeroTrustTunnel(id, tunnelName, ingress, {
        cloudflareAccountId: params.cloudflareAccountId,
      });
      return result;
    },

    async 'cf.tunnel.list'(params) {
      const id = pickAccount(params);
      return client.listTunnels(id, { perPage: params.perPage, cloudflareAccountId: params.cloudflareAccountId });
    },

    async 'cf.worker.deploy'(params) {
      const scriptName = requireString(params, 'scriptName');
      const code = params.code;
      if (typeof code !== 'string' && !Buffer.isBuffer(code)) {
        throw new RpcError('ERR_PARAMS', '"code" must be a string (module source)');
      }
      const id = pickAccount(params);
      return client.deployWorkerScript(id, scriptName, code, params.bindings || [], {
        cloudflareAccountId: params.cloudflareAccountId,
        filename: params.filename,
        compatibilityDate: params.compatibilityDate,
        compatibilityFlags: params.compatibilityFlags,
        metadata: params.metadata,
      });
    },

    async 'cf.request'(params) {
      const path = requireString(params, 'path');
      if (params.id) {
        const response = await client.call(params.id, path, {
          method: params.method,
          body: params.body,
          query: params.query,
          urgent: params.urgent,
        });
        return {
          accountId: response.accountId,
          status: response.status,
          cfRay: response.cfRay,
          result: response.body,
        };
      }
      const response = await client.callWithFailover(null, path, {
        method: params.method,
        body: params.body,
        query: params.query,
        urgent: params.urgent,
        tag: params.tag,
      });
      return {
        accountId: response.accountId,
        status: response.status,
        cfRay: response.cfRay,
        result: response.body,
      };
    },

    'cf.risk.report'(params) {
      if (params.id) {
        const profile = vault.get(params.id);
        if (!profile) throw new RpcError('ERR_NOT_FOUND', `account "${params.id}" not found`);
        return risk.snapshot(profile.id);
      }
      return {
        accounts: vault.list().map((profile) => risk.snapshot(profile.id)),
        bindings: net.status(),
      };
    },

    'cf.risk.reset'(params) {
      const id = requireString(params, 'id');
      const profile = vault.get(id);
      if (!profile) throw new RpcError('ERR_NOT_FOUND', `account "${id}" not found`);
      risk.reset(profile.id);
      return vault.resetState(profile.id);
    },

    'cf.rpc.methods'() {
      return Object.keys(methods).sort();
    },
  };

  async function handle(method, params = {}) {
    const fn = methods[method];
    if (!fn) throw new RpcError('ERR_METHOD', `unknown method "${method}"`);
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      throw new RpcError('ERR_PARAMS', 'params must be an object');
    }
    return fn(params);
  }

  return { handle, methods, serializeError };
}

function toRpcResponse(error, result) {
  if (error) return { ok: false, error: serializeError(error) };
  return { ok: true, result };
}

module.exports = {
  createRpcHandler,
  RpcError,
  serializeError,
  toRpcResponse,
  knownErrorClasses: { VaultError, RiskError, CfApiError, ProxyUnavailableError, BindingError },
};
