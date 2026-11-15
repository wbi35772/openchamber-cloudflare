/* Cloudflare Matrix — zero-build OpenChamber panel. Classic IIFE on purpose. */
(function () {
  'use strict';

  /* ------------------------------------------------------------ host bridge */

  var CHANNEL = 'openchamber.sdk';
  var WIRE = 1;
  var seq = 0;
  var pending = new Map();
  var readyHandlers = new Set();
  var connected = false;

  function post(type, payload, id) {
    var message = { channel: CHANNEL, v: WIRE, type: type };
    if (id !== undefined) message.id = id;
    if (payload !== undefined) message.payload = payload;
    try {
      window.parent.postMessage(message, '*');
    } catch (error) {
      /* host gone */
    }
  }

  function call(type, payload, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = 'p' + (++seq);
      var timer = setTimeout(function () {
        pending.delete(id);
        var error = new Error('OpenChamber 主程序没有响应');
        error.code = 'HOST_TIMEOUT';
        reject(error);
      }, timeoutMs || 18000);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      post(type, payload, id);
    });
  }

  window.addEventListener('message', function (event) {
    if (window.parent !== window && event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.channel !== CHANNEL || data.v !== WIRE) return;
    if (data.type === 'ready') {
      connected = true;
      readyHandlers.forEach(function (fn) {
        try {
          fn(data.payload || {});
        } catch (error) {
          /* ignore handler error */
        }
      });
      return;
    }
    if (!data.id) return;
    var entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    clearTimeout(entry.timer);
    if (data.ok === false) {
      entry.resolve({
        ok: false,
        payload: data.payload,
        error: data.error,
        code: data.code,
      });
      return;
    }
    entry.resolve({ ok: true, payload: data.payload });
  });

  var CODE_HINTS = {
    HOST_TIMEOUT: 'OpenChamber 主程序响应超时，稍后重试',
    HOST_UNAVAILABLE: 'OpenChamber 主程序不可用',
    NO_SERVICE: '本地服务未启动或未授权：到 设置 → 扩展 → Cloudflare Matrix 允许本地服务',
    NOT_GRANTED: '本地服务尚未授权：到 设置 → 扩展 中允许',
    DISABLED: '扩展已被暂停：到 设置 → 扩展 中启用',
    SERVICE_FAILED: '本地服务启动失败：查看扩展日志后重试',
    REQUEST_FAILED: '本地服务没有返回结果，操作可能已生效',
    RESPONSE_TOO_LARGE: '服务返回内容过大',
    HOST_REJECTED: '主程序拒绝了请求',
    BAD_PATH: '请求路径不合法',
  };

  function hostError(result) {
    var hint = CODE_HINTS[result.code];
    var error = new Error(hint || result.error || '请求失败');
    error.code = result.code;
    return error;
  }

  function service(method, path, options) {
    var opts = options || {};
    var payload = { method: method, path: path };
    if (opts.query) payload.query = opts.query;
    if (opts.body !== undefined) payload.body = JSON.stringify(opts.body);
    return call('service-request', payload, opts.timeoutMs || 45000).then(function (result) {
      if (!result.ok) throw hostError(result);
      var envelope = result.payload || {};
      var data = null;
      if (envelope.body) {
        try {
          data = JSON.parse(envelope.body);
        } catch (error) {
          data = { raw: String(envelope.body) };
        }
      }
      if (envelope.status >= 400 || (data && data.ok === false)) {
        var detail = (data && data.error) || {};
        var failure = new Error(detail.message || '本地服务返回 HTTP ' + envelope.status);
        failure.code = detail.code || 'http_' + envelope.status;
        failure.status = envelope.status;
        throw failure;
      }
      return data;
    });
  }

  function rpc(method, params) {
    return service('POST', '/rpc', { body: { method: method, params: params || {} } }).then(function (data) {
      if (!data || data.ok !== true) {
        var error = new Error((data && data.error && data.error.message) || 'RPC 调用失败');
        error.code = data && data.error && data.error.code;
        error.details = data && data.error && data.error.details;
        throw error;
      }
      return data.result;
    });
  }

  /* ------------------------------------------------------------ utilities */

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function fmtMs(ms) {
    var seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return seconds + ' 秒';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + ' 分钟';
    return Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分';
  }

  function toast(text, isError) {
    var root = document.getElementById('toast-root');
    var node = document.createElement('div');
    node.className = 'toast' + (isError ? ' err' : '');
    node.textContent = String(text);
    root.appendChild(node);
    setTimeout(function () {
      node.remove();
    }, isError ? 6000 : 3200);
  }

  function setConn(label, state) {
    var node = document.getElementById('conn');
    node.className = 'conn' + (state ? ' ' + state : '');
    node.querySelector('span').textContent = label;
  }

  /* ------------------------------------------------------------ state */

  var state = {
    status: null,
    accounts: [],
    risk: new Map(),
    filter: '',
    needsService: false,
  };

  function accountState(profile) {
    var snapshot = state.risk.get(profile.id);
    if (snapshot) return snapshot;
    return profile.state || { status: 'ACTIVE', healthScore: 100, strikes: 0 };
  }

  /* ------------------------------------------------------------ render */

  function renderStats() {
    var accounts = state.accounts;
    var active = 0;
    var cooling = 0;
    var quarantined = 0;
    accounts.forEach(function (profile) {
      var st = accountState(profile).status || 'ACTIVE';
      if (st === 'ACTIVE') active += 1;
      else if (st === 'COOLDOWN') cooling += 1;
      else quarantined += 1;
    });
    var used = 0;
    var limit = 0;
    state.risk.forEach(function (snapshot) {
      used += snapshot.window ? snapshot.window.used : 0;
      limit += snapshot.window ? snapshot.window.limit : 0;
    });
    var cards = [
      { label: '账号', value: accounts.length },
      { label: 'ACTIVE', value: active },
      { label: 'COOLDOWN / 隔离', value: cooling + ' / ' + quarantined },
      { label: '窗口请求', value: limit ? used + ' / ' + limit : '—' },
    ];
    document.getElementById('stats').innerHTML = cards
      .map(function (card) {
        return '<div class="stat"><b>' + esc(card.value) + '</b><span>' + esc(card.label) + '</span></div>';
      })
      .join('');
  }

  function statusBadge(status) {
    if (status === 'ACTIVE') return '<span class="badge ok">ACTIVE</span>';
    if (status === 'COOLDOWN') return '<span class="badge warn">COOLDOWN</span>';
    return '<span class="badge bad">' + esc(status || 'UNKNOWN') + '</span>';
  }

  function renderGrid() {
    var grid = document.getElementById('grid');
    var needle = state.filter.trim().toLowerCase();
    var list = state.accounts.filter(function (profile) {
      if (!needle) return true;
      var haystack = [profile.id, profile.label, profile.proxyPort]
        .concat(profile.tags || [])
        .join(' ')
        .toLowerCase();
      return haystack.indexOf(needle) >= 0;
    });

    if (!state.accounts.length) {
      grid.innerHTML =
        '<div class="empty"><strong>还没有 Cloudflare 账号</strong>' +
        '添加一个 API Token 和代理端口即可开始；端口留空会自动分配。' +
        '<br><button class="primary-btn" data-act="add-account">添加账号</button></div>';
      return;
    }
    if (!list.length) {
      grid.innerHTML = '<div class="empty">没有匹配的账号</div>';
      return;
    }

    grid.innerHTML = list
      .map(function (profile) {
        var snapshot = accountState(profile);
        var status = snapshot.status || 'ACTIVE';
        var windowInfo = snapshot.window || { used: 0, limit: 0 };
        var ratio = windowInfo.limit ? Math.min(1, windowInfo.used / windowInfo.limit) : 0;
        var barClass = ratio > 0.95 ? 'bad' : ratio > 0.75 ? 'warn' : '';
        var cooldown =
          status === 'COOLDOWN' && snapshot.cooldownUntil && snapshot.cooldownUntil > Date.now()
            ? ' · 冷却 ' + fmtMs(snapshot.cooldownUntil - Date.now())
            : '';
        var tags = (profile.tags || [])
          .map(function (tag) {
            return '<span class="tag">' + esc(tag) + '</span>';
          })
          .join('');
        return (
          '<article class="card' + (profile.enabled === false ? ' off' : '') + '" data-id="' + esc(profile.id) + '">' +
          '<div class="card-head"><div class="card-title"><strong>' + esc(profile.label) + '</strong>' +
          '<code>' + esc(profile.id) + '</code></div>' + statusBadge(status) + '</div>' +
          '<div class="meta"><span>代理端口 <b>' + esc(profile.proxyPort) + '</b></span>' +
          '<span>健康分 <b>' + esc(snapshot.healthScore == null ? 100 : snapshot.healthScore) + '</b></span>' +
          '<span>窗口 <b>' + esc(windowInfo.used) + ' / ' + esc(windowInfo.limit) + '</b>' + esc(cooldown) + '</span></div>' +
          '<div class="bar"><i class="' + barClass + '" style="width:' + Math.round(ratio * 100) + '%"></i></div>' +
          (tags ? '<div class="tags">' + tags + '</div>' : '') +
          '<div class="card-actions">' +
          '<button class="ghost-btn" data-acc="verify">验证</button>' +
          '<button class="ghost-btn" data-acc="probe">探活</button>' +
          '<button class="ghost-btn" data-acc="toggle">' + (profile.enabled === false ? '启用' : '停用') + '</button>' +
          '<button class="ghost-btn danger" data-acc="remove">删除</button>' +
          '</div></article>'
        );
      })
      .join('');
  }

  function renderFooter() {
    var status = state.status;
    var text = '等待连接…';
    var hint = '凭证只存在于本机加密仓，面板不显示明文';
    if (status) {
      text = '数据目录：' + status.dataDir;
      hint =
        '配置：' +
        (status.configPath || '默认') +
        ' · 主密钥：' +
        (status.masterKeySource || 'unknown') +
        (status.masterKeyPath ? '（' + status.masterKeyPath + '）' : '');
    }
    document.getElementById('footer-status').textContent = text;
    document.getElementById('footer-hint').textContent = hint;
    document.getElementById('toolbar-meta').textContent =
      state.accounts.length ? state.accounts.length + ' 个账号' : '';
  }

  function render() {
    renderStats();
    renderGrid();
    renderFooter();
  }

  /* ------------------------------------------------------------ data */

  function refresh() {
    return Promise.all([rpc('cf.matrix.status'), rpc('cf.account.list'), rpc('cf.risk.report', {})])
      .then(function (results) {
        state.status = results[0];
        state.accounts = (results[1] && results[1].accounts) || [];
        var riskAccounts = (results[2] && results[2].accounts) || [];
        state.risk = new Map(
          riskAccounts.map(function (snapshot) {
            return [snapshot.accountId, snapshot];
          }),
        );
        state.needsService = false;
        setConn('已连接', 'on');
        render();
      })
      .catch(function (error) {
        if (
          error.code === 'NO_SERVICE' ||
          error.code === 'NOT_GRANTED' ||
          error.code === 'DISABLED' ||
          error.code === 'SERVICE_FAILED'
        ) {
          state.needsService = true;
          setConn('服务未授权', 'off');
          document.getElementById('footer-status').textContent =
            CODE_HINTS[error.code] || '本地服务不可用';
        } else {
          setConn('连接失败', 'off');
          document.getElementById('footer-status').textContent = error.message;
        }
        throw error;
      });
  }

  /* ------------------------------------------------------------ modals */

  function closeModal() {
    document.getElementById('modal-root').innerHTML = '';
  }

  function openModal(title, bodyHtml, footerHtml) {
    var root = document.getElementById('modal-root');
    root.innerHTML =
      '<div class="modal-backdrop" data-close="1"><section class="modal" role="dialog" aria-modal="true">' +
      '<header><strong>' + esc(title) + '</strong><button data-close="1" aria-label="关闭">×</button></header>' +
      '<div class="body">' + bodyHtml + '</div>' +
      '<footer>' + footerHtml + '</footer></section></div>';
    root.querySelectorAll('[data-close]').forEach(function (node) {
      node.addEventListener('click', function (event) {
        if (event.target === node) closeModal();
      });
    });
    var first = root.querySelector('input, select, textarea');
    if (first) setTimeout(function () { first.focus(); }, 30);
  }

  function field(label, inner, hint) {
    return (
      '<label class="field"><span>' + esc(label) + '</span>' + inner +
      (hint ? '<span class="hint">' + esc(hint) + '</span>' : '') +
      '</label>'
    );
  }

  function confirmAction(title, message, confirmLabel, onConfirm) {
    openModal(
      title,
      '<p class="confirm-text">' + esc(message) + '</p>',
      '<button class="ghost-btn" data-close="1">取消</button>' +
        '<button class="ghost-btn danger" data-act="confirm-ok">' + esc(confirmLabel) + '</button>',
    );
    var root = document.getElementById('modal-root');
    var button = root.querySelector('[data-act="confirm-ok"]');
    button.addEventListener('click', function () {
      button.disabled = true;
      Promise.resolve()
        .then(onConfirm)
        .then(function () { closeModal(); })
        .catch(function (error) {
          button.disabled = false;
          toast(error.message, true);
        });
    });
  }

  function openAddAccount() {
    var body =
      '<div class="grid-2">' +
      field('名称', '<input name="label" placeholder="例如 Acme 主账号" required>') +
      field('认证方式', '<select name="authType"><option value="token">API Token</option><option value="key">Global API Key</option></select>') +
      '</div>' +
      '<div data-auth="token">' +
      field('API Token', '<textarea name="token" placeholder="粘贴 Cloudflare API Token"></textarea>', '建议使用最小权限 Token；只保存在本机加密仓') +
      '</div>' +
      '<div data-auth="key" hidden>' +
      '<div class="grid-2">' +
      field('邮箱', '<input name="email" placeholder="you@example.com">') +
      field('Global API Key', '<input name="apiKey" type="password" placeholder="Global API Key">') +
      '</div></div>' +
      '<div class="grid-2">' +
      field('代理端口', '<input name="proxyPort" type="number" min="1" max="65535" placeholder="留空自动分配">') +
      field('标签', '<input name="tags" placeholder="prod,eu">') +
      '</div>' +
      field('Cloudflare Account ID', '<input name="cloudflareAccountId" placeholder="可选；多账号用户必填">');
    openModal(
      '添加 Cloudflare 账号',
      body,
      '<button class="ghost-btn" data-close="1">取消</button>' +
        '<button class="primary-btn" data-act="submit-add">添加</button>',
    );

    var root = document.getElementById('modal-root');
    var select = root.querySelector('select[name="authType"]');
    select.addEventListener('change', function () {
      var isKey = select.value === 'key';
      root.querySelector('[data-auth="token"]').hidden = isKey;
      root.querySelector('[data-auth="key"]').hidden = !isKey;
    });
    root.querySelector('[data-act="submit-add"]').addEventListener('click', function () {
      var button = this;
      var get = function (name) {
        var node = root.querySelector('[name="' + name + '"]');
        return node ? node.value.trim() : '';
      };
      var authType = get('authType');
      var params = {
        label: get('label'),
        authType: authType,
        tags: get('tags') ? get('tags').split(',').map(function (tag) { return tag.trim(); }).filter(Boolean) : undefined,
        cloudflareAccountId: get('cloudflareAccountId') || undefined,
        enabled: true,
      };
      if (!params.label) return toast('请填写名称', true);
      if (authType === 'token') {
        if (!get('token')) return toast('请填写 API Token', true);
        params.token = get('token');
      } else {
        if (!get('email') || !get('apiKey')) return toast('Global API Key 需要邮箱和 Key', true);
        params.email = get('email');
        params.apiKey = get('apiKey');
      }
      if (get('proxyPort')) params.proxyPort = Number(get('proxyPort'));
      button.disabled = true;
      rpc('cf.account.add', params)
        .then(function (profile) {
          closeModal();
          toast('已添加 ' + profile.label + '（端口 ' + profile.proxyPort + '）');
          return refresh();
        })
        .catch(function (error) {
          button.disabled = false;
          toast(error.message, true);
        });
    });
  }

  function openSettings() {
    rpc('cf.config.get')
      .then(function (data) {
        var config = data.config || {};
        var risk = config.risk || {};
        var jitter = risk.jitter || {};
        function num(name, value, extra) {
          return field(name, '<input type="number" name="' + name + '" value="' + esc(value) + '"' + (extra || '') + '>');
        }
        var body =
          '<div class="grid-2">' +
          field('API 基址', '<input name="apiBase" value="' + esc(config.apiBase || '') + '">') +
          field('代理主机', '<input name="proxyHost" value="' + esc(config.proxyHost || '') + '">', 'sing-box / mihomo 所在主机') +
          '</div>' +
          '<div class="grid-2">' +
          num('portStart', config.portStart) +
          num('portEnd', config.portEnd) +
          '</div>' +
          '<div class="grid-2">' +
          num('risk.rps', risk.rps, ' step="0.1" min="0.1"') +
          num('risk.burst', risk.burst, ' min="1"') +
          '</div>' +
          '<div class="grid-2">' +
          num('risk.windowLimit', risk.windowLimit, ' min="1"') +
          num('risk.windowMs', risk.windowMs, ' min="1000"') +
          '</div>' +
          '<div class="grid-2">' +
          num('risk.jitter.minMs', jitter.minMs, ' min="0"') +
          num('risk.jitter.maxMs', jitter.maxMs, ' min="0"') +
          '</div>' +
          field('代理认证', '<input name="proxyAuth" placeholder="user:pass，可留空" value="' + esc(config.proxyAuth || '') + '">') +
          '<div class="hint">配置保存到 ' + esc(data.configPath || '数据目录') + '，立即生效。主密钥来源：' + esc(data.masterKeySource || 'unknown') + '。</div>';
        openModal(
          '运行参数',
          body,
          '<button class="ghost-btn" data-close="1">取消</button>' +
            '<button class="primary-btn" data-act="submit-settings">保存</button>',
        );
        var root = document.getElementById('modal-root');
        root.querySelector('[data-act="submit-settings"]').addEventListener('click', function () {
          var button = this;
          var pick = function (name) {
            var node = root.querySelector('[name="' + name + '"]');
            return node ? node.value.trim() : '';
          };
          var patch = {
            apiBase: pick('apiBase'),
            proxyHost: pick('proxyHost'),
            proxyAuth: pick('proxyAuth') || null,
            portStart: Number(pick('portStart')),
            portEnd: Number(pick('portEnd')),
            risk: {
              rps: Number(pick('risk.rps')),
              burst: Number(pick('risk.burst')),
              windowLimit: Number(pick('risk.windowLimit')),
              windowMs: Number(pick('risk.windowMs')),
              jitter: {
                minMs: Number(pick('risk.jitter.minMs')),
                maxMs: Number(pick('risk.jitter.maxMs')),
              },
            },
          };
          button.disabled = true;
          rpc('cf.config.patch', patch)
            .then(function () {
              closeModal();
              toast('参数已保存并生效');
              return refresh();
            })
            .catch(function (error) {
              button.disabled = false;
              toast(error.message, true);
            });
        });
      })
      .catch(function (error) {
        toast(error.message, true);
      });
  }

  /* ------------------------------------------------------------ actions */

  function withCard(button, handler) {
    var card = button.closest('.card');
    var id = card && card.getAttribute('data-id');
    if (!id) return;
    button.disabled = true;
    Promise.resolve(handler(id))
      .catch(function (error) {
        toast(error.message, true);
      })
      .then(function () {
        button.disabled = false;
      });
  }

  function act(button) {
    var action = button.getAttribute('data-acc');
    if (action === 'verify') {
      return withCard(button, function (id) {
        return rpc('cf.account.verify', { id }).then(function (result) {
          toast(result.ok ? 'Token 有效（' + (result.status || 'active') + '）' : '验证失败：' + (result.error || 'unknown'), !result.ok);
          return refresh();
        });
      });
    }
    if (action === 'probe') {
      return withCard(button, function (id) {
        return rpc('cf.proxy.probe', { id }).then(function (trace) {
          var ip = trace && (trace.ip || trace.clientIp || trace.origin);
          toast(ip ? '出口 IP：' + ip : '探活成功');
        });
      });
    }
    if (action === 'toggle') {
      return withCard(button, function (id) {
        var profile = state.accounts.find(function (item) { return item.id === id; });
        var enabled = !profile || profile.enabled === false;
        return rpc('cf.account.update', { id: id, patch: { enabled: enabled } }).then(function () {
          toast(enabled ? '已启用' : '已停用');
          return refresh();
        });
      });
    }
    if (action === 'remove') {
      var card = button.closest('.card');
      var id = card && card.getAttribute('data-id');
      var profile = state.accounts.find(function (item) { return item.id === id; });
      if (!id) return;
      confirmAction(
        '删除账号',
        '删除 ' + (profile ? profile.label : id) + '？密封凭证会一并移除。',
        '删除',
        function () {
          return rpc('cf.account.remove', { id: id }).then(function () {
            toast('已删除');
            return refresh();
          });
        },
      );
    }
  }

  /* ------------------------------------------------------------ wiring */

  document.addEventListener('click', function (event) {
    var node = event.target.closest('[data-act]');
    if (!node) return;
    var action = node.getAttribute('data-act');
    if (action === 'add-account') openAddAccount();
    else if (action === 'settings') openSettings();
    else if (action === 'refresh') {
      node.disabled = true;
      refresh()
        .catch(function (error) {
          toast(error.message, true);
        })
        .then(function () {
          node.disabled = false;
        });
    }
  });

  document.addEventListener('click', function (event) {
    var node = event.target.closest('[data-acc]');
    if (node) act(node);
  });

  document.getElementById('filter-input').addEventListener('input', function () {
    state.filter = this.value;
    renderGrid();
  });

  function boot() {
    readyHandlers.add(function () {
      refresh().catch(function () {});
    });
    if (window.parent !== window) {
      post('hello');
      setConn('连接中', '');
      setTimeout(function () {
        if (!connected) refresh().catch(function () {});
      }, 1600);
      setInterval(function () {
        refresh().catch(function () {});
      }, 30000);
    } else {
      setConn('未嵌入', 'off');
      document.getElementById('grid').innerHTML =
        '<div class="empty"><strong>请从 OpenChamber 扩展面板打开</strong>' +
        '这个页面通过 openchamber.sdk 与本地服务通信，直接打开浏览器无法访问数据。</div>';
    }
  }

  boot();
})();
