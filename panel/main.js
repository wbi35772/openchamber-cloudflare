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

  function toast(text, tone) {
    var root = document.getElementById('toast-root');
    var node = document.createElement('div');
    node.className = 'toast' + (tone ? ' ' + tone : '');
    node.textContent = String(text);
    root.appendChild(node);
    setTimeout(function () {
      node.remove();
    }, 4200);
  }

  function setBadge(id, mode, text) {
    var node = document.getElementById(id);
    node.className = 'badge' + (mode ? ' ' + mode : '');
    node.innerHTML = '<i></i>' + esc(text);
  }

  function setConn(text, tone) {
    var node = document.getElementById('conn-text');
    node.textContent = text;
    node.className = tone === 'ok' ? 'ok' : tone === 'bad' ? 'bad' : '';
    setBadge('badge-host', tone === 'ok' ? 'on' : tone === 'bad' ? 'off' : '', 'HOST');
  }

  /* The matrix never renders a raw upstream label: banned channel words are
     stripped before display, matching the polymorph resource-name rules. */
  var BANNED_WORDS = ['edgetunnel', 'vless', 'proxy', 'scan'];

  function safeName(text) {
    var out = String(text || '').toLowerCase();
    BANNED_WORDS.forEach(function (word) {
      out = out.split(word).join('-');
    });
    out = out
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '');
    return out || 'slot';
  }

  function clampPercent(value) {
    var number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, number));
  }

  function effectiveState(slot) {
    var egress = slot.egress || null;
    if (egress && egress.healthState === 'WARP_OVERFLOW') return 'WARP_OVERFLOW';
    if (egress && egress.healthState === 'ROTATING') return 'ROTATING';
    if (slot.status === 'QUARANTINED' || (egress && egress.healthState === 'QUARANTINED')) {
      return 'QUARANTINED';
    }
    if (slot.status === 'COOLDOWN' && Number(slot.cooldownUntil) > Date.now()) return 'COOLDOWN';
    if (slot.enabled === false) return 'OFFLINE';
    return 'ACTIVE';
  }

  function visualState(slot) {
    var state = effectiveState(slot);
    if (state === 'COOLDOWN') return 'cooldown';
    if (state === 'QUARANTINED') return 'quarantined';
    if (state === 'WARP_OVERFLOW') return 'warp';
    if (state === 'ROTATING') return 'rotating';
    if (state === 'OFFLINE') return 'offline';
    return 'active';
  }

  function matchesFilter(slot, filter) {
    if (filter === 'ALL') return true;
    var state = effectiveState(slot);
    if (filter === 'ACTIVE') return state === 'ACTIVE';
    if (filter === 'COOLDOWN') return state === 'COOLDOWN';
    if (filter === 'QUARANTINED') {
      return state === 'QUARANTINED' || state === 'WARP_OVERFLOW' || state === 'ROTATING' || state === 'OFFLINE';
    }
    return true;
  }

  /* ------------------------------------------------------------ state/view */

  var state = {
    slots: [],
    status: null,
    filter: 'ALL',
    lastSync: 0,
  };

  var inflight = null;

  function refresh() {
    if (inflight) return inflight;
    inflight = Promise.all([rpc('cf.matrix.slots'), rpc('cf.matrix.status')])
      .then(function (results) {
        state.slots = Array.isArray(results[0]) ? results[0] : [];
        state.status = results[1] || null;
        state.lastSync = Date.now();
        render();
        setConn('已连接', 'ok');
        return state;
      })
      .catch(function (error) {
        setConn(error.message || '连接失败', 'bad');
        throw error;
      })
      .then(
        function (value) {
          inflight = null;
          return value;
        },
        function (error) {
          inflight = null;
          throw error;
        },
      );
    return inflight;
  }

  function egressSummary() {
    var egress = (state.status && state.status.egress) || {};
    var status = egress.status || {};
    var slots = egress.state && Array.isArray(egress.state.slots) ? egress.state.slots : [];
    return {
      enabled: Boolean(egress.enabled),
      connected: Boolean(status.connected) || slots.length > 0,
      slots: slots.length,
      url: status.baseUrl || status.url || '',
    };
  }

  function tunnelCount() {
    return state.slots.reduce(function (total, slot) {
      return total + (Array.isArray(slot.tunnels) ? slot.tunnels.length : 0);
    }, 0);
  }

  function render() {
    var egress = egressSummary();
    setBadge(
      'badge-egress',
      egress.enabled ? (egress.connected ? 'on' : 'warn') : 'off',
      'EGRESS-BUS' + (egress.enabled ? (egress.connected ? '' : ' WAIT') : ' OFF'),
    );
    if (egress.url) document.getElementById('badge-egress').title = egress.url;

    var tunnels = tunnelCount();
    setBadge('badge-instabox', tunnels > 0 ? 'on' : '', 'INSTABOX' + (tunnels ? ' ' + tunnels : ''));
    document.getElementById('badge-instabox').title = tunnels
      ? tunnels + ' 条 Instabox 隧道在线'
      : '尚未签发 Instabox 隧道';

    var grid = document.getElementById('grid');
    var visible = state.slots.filter(function (slot) {
      return matchesFilter(slot, state.filter);
    });

    if (!visible.length) {
      grid.innerHTML =
        '<div class="empty"><strong>' +
        (state.slots.length ? '当前过滤条件下没有槽位' : '还没有槽位账号') +
        '</strong>' +
        (state.slots.length
          ? '切换 ALL 查看全部槽位，或等待冷却结束。'
          : '点击右上角「+ 新增槽位账号」，账号会按 slot-001…slot-250 顺序绑定 24001–24250 端口。') +
        '</div>';
    } else {
      grid.innerHTML = visible.map(cardHtml).join('');
    }

    document.getElementById('last-sync').textContent = state.lastSync
      ? '最后同步 ' + new Date(state.lastSync).toLocaleTimeString()
      : '';
  }

  function cardHtml(slot) {
    var visual = visualState(slot);
    var slotId = slot.matrixSlotId || 'slot-???';
    var port = slot.egressPort || slot.proxyPort || '—';
    var fingerprint = (slot.egress && slot.egress.egressFingerprint) || {};
    var used = slot.window && Number.isFinite(Number(slot.window.used)) ? Number(slot.window.used) : 0;
    var limit = slot.window && Number.isFinite(Number(slot.window.limit)) ? Number(slot.window.limit) : 950;
    var health = Number(slot.healthScore);
    if (!Number.isFinite(health)) health = 100;
    var cooldown = Number(slot.cooldownUntil) > Date.now() ? fmtMs(Number(slot.cooldownUntil) - Date.now()) : '—';
    var tunnels = Array.isArray(slot.tunnels) ? slot.tunnels : [];
    var hostnames = tunnels.length
      ? tunnels
          .slice(0, 3)
          .map(function (tunnel) {
            return '<div class="hostname" title="' + esc(tunnel.publicHostname) + '"><i></i>' + esc(tunnel.publicHostname) + '</div>';
          })
          .join('') +
        (tunnels.length > 3
          ? '<div class="hostname empty-host"><i></i>+' + (tunnels.length - 3) + ' more</div>'
          : '')
      : '<div class="hostname empty-host"><i></i>未签发 Instabox 隧道</div>';
    var disabled = slot.matrixSlotId ? '' : ' disabled';
    var stateLabel = effectiveState(slot);

    return (
      '<article class="card state-' + visual + '">' +
      '<header class="card-head">' +
      '<div class="slot-id"><span class="pulse"></span><b>' + esc(slotId) + '</b><span class="port">:' + esc(port) + '</span></div>' +
      '<span class="status-pill">' + esc(stateLabel) + '</span>' +
      '</header>' +
      '<div class="card-name" title="' + esc(slot.label) + '">' + esc(safeName(slot.label)) +
      '<small>' + esc((slot.authType || 'token').toUpperCase()) + ' · ' + esc(slot.accountId) + '</small></div>' +
      '<dl class="meta">' +
      '<div><dt>CF-RAY</dt><dd title="' + esc(slot.lastRay || '') + '">' + esc(slot.lastRay || '—') + '</dd></div>' +
      '<div><dt>EXIT IP</dt><dd title="' + esc(fingerprint.exitIp || '') + '">' + esc(fingerprint.exitIp || '—') + '</dd></div>' +
      '<div><dt>PREFIX /64</dt><dd title="' + esc(fingerprint.ipv6Prefix64 || '') + '">' + esc(fingerprint.ipv6Prefix64 || '—') + '</dd></div>' +
      '</dl>' +
      '<div class="hostnames">' + hostnames + '</div>' +
      '<div class="meters">' +
      '<div class="meter">' +
      '<div class="meter-label"><span>5m API QUOTA</span><b>' + used + ' / ' + limit + '</b></div>' +
      '<div class="meter-track"><i style="width:' + clampPercent(limit ? (used / limit) * 100 : 0) + '%"></i></div>' +
      '</div>' +
      '<div class="meter health">' +
      '<div class="meter-label"><span>HEALTH · COOLDOWN ' + esc(cooldown) + '</span><b>' + Math.round(health) + '%</b></div>' +
      '<div class="meter-track"><i style="width:' + clampPercent(health) + '%"></i></div>' +
      '</div>' +
      '</div>' +
      '<footer class="card-actions">' +
      '<button class="btn" type="button" data-act="tunnel" data-slot="' + esc(slot.matrixSlotId || '') + '"' + disabled + '>签发 Instabox 隧道</button>' +
      '<button class="btn" type="button" data-act="dns" data-slot="' + esc(slot.matrixSlotId || '') + '"' + disabled + '>同步 DNS</button>' +
      '<button class="btn" type="button" data-act="drain" data-slot="' + esc(slot.matrixSlotId || '') + '"' + disabled + '>排空连接池</button>' +
      '<button class="btn btn-danger" type="button" data-act="rotate" data-slot="' + esc(slot.matrixSlotId || '') + '"' + disabled + '>强制换血(联动 Egress)</button>' +
      '</footer>' +
      '</article>'
    );
  }

  function slotById(slotId) {
    for (var index = 0; index < state.slots.length; index += 1) {
      if (state.slots[index].matrixSlotId === slotId) return state.slots[index];
    }
    return null;
  }

  /* ---------------------------------------------------------------- modals */

  var modalEscape = null;

  function closeModal() {
    document.getElementById('modal-root').innerHTML = '';
    if (modalEscape) {
      document.removeEventListener('keydown', modalEscape);
      modalEscape = null;
    }
  }

  function fieldHtml(field) {
    var id = 'f-' + field.name;
    var label = '<label for="' + esc(id) + '">' + esc(field.label) + '</label>';
    var control;
    if (field.type === 'select') {
      control =
        '<select id="' + esc(id) + '" name="' + esc(field.name) + '">' +
        (field.options || [])
          .map(function (option) {
            return (
              '<option value="' + esc(option.value) + '"' +
              (String(field.value) === String(option.value) ? ' selected' : '') +
              '>' + esc(option.label) + '</option>'
            );
          })
          .join('') +
        '</select>';
    } else if (field.type === 'textarea') {
      control =
        '<textarea id="' + esc(id) + '" name="' + esc(field.name) + '" placeholder="' +
        esc(field.placeholder || '') + '">' + esc(field.value || '') + '</textarea>';
    } else {
      control =
        '<input id="' + esc(id) + '" name="' + esc(field.name) + '" type="' +
        esc(field.type || 'text') + '" value="' + esc(field.value || '') +
        '" placeholder="' + esc(field.placeholder || '') + '" autocomplete="off" />';
    }
    return '<div class="field">' + label + control + '</div>';
  }

  function openModal(options) {
    var root = document.getElementById('modal-root');
    root.innerHTML =
      '<div class="modal-backdrop">' +
      '<div class="modal" role="dialog" aria-modal="true">' +
      '<h2>' + esc(options.title) + '</h2>' +
      '<p class="modal-sub">' + esc(options.subtitle || '') + '</p>' +
      '<form novalidate>' +
      (options.fields || []).map(fieldHtml).join('') +
      '<div class="modal-error"></div>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn btn-ghost" data-modal-close>取消</button>' +
      '<button type="submit" class="btn ' + (options.danger ? 'btn-danger' : 'btn-primary') + '">' +
      esc(options.submitLabel || '提交') + '</button>' +
      '</div>' +
      '</form>' +
      '</div>' +
      '</div>';

    var form = root.querySelector('form');
    var errorBox = form.querySelector('.modal-error');
    var submit = form.querySelector('button[type="submit"]');
    var first = form.querySelector('input, select, textarea');
    if (first) first.focus();

    root.querySelector('.modal-backdrop').addEventListener('click', function (event) {
      if (event.target === event.currentTarget) closeModal();
    });
    root.querySelectorAll('[data-modal-close]').forEach(function (node) {
      node.addEventListener('click', function () {
        closeModal();
      });
    });
    if (modalEscape) document.removeEventListener('keydown', modalEscape);
    modalEscape = function onEscape(event) {
      if (event.key !== 'Escape') return;
      closeModal();
    };
    document.addEventListener('keydown', modalEscape);

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var values = {};
      form.querySelectorAll('[name]').forEach(function (input) {
        values[input.name] = input.value.trim();
      });
      submit.disabled = true;
      errorBox.style.display = 'none';
      Promise.resolve()
        .then(function () {
          return options.onSubmit ? options.onSubmit(values) : undefined;
        })
        .then(function (message) {
          closeModal();
          if (message) toast(message);
          refresh().catch(function () {});
        })
        .catch(function (error) {
          errorBox.textContent = error.message || String(error);
          errorBox.style.display = 'block';
          submit.disabled = false;
        });
    });
  }

  function confirmModal(title, subtitle, submitLabel, onConfirm) {
    openModal({
      title: title,
      subtitle: subtitle,
      submitLabel: submitLabel,
      danger: true,
      fields: [],
      onSubmit: onConfirm,
    });
  }

  /* --------------------------------------------------------------- actions */

  function openAddAccount() {
    openModal({
      title: '+ 新增槽位账号',
      subtitle: '账号会按 slot-001…slot-250 顺序占用 24001–24250 的 egress 端口；凭证写入本机 AES-256-GCM 仓。',
      submitLabel: '创建并绑定',
      fields: [
        { name: 'label', label: '标签', placeholder: 'main-account' },
        {
          name: 'authType',
          label: '鉴权方式',
          type: 'select',
          value: 'token',
          options: [
            { value: 'token', label: 'API Token' },
            { value: 'key', label: 'Global Key + Email' },
          ],
        },
        { name: 'token', label: 'API Token', placeholder: 'cf token' },
        { name: 'email', label: 'Email（Global Key）', placeholder: 'ops@example.com' },
        { name: 'apiKey', label: 'Global API Key', placeholder: '仅 Global Key 模式' },
        { name: 'matrixSlotId', label: '指定槽位（留空自动分配）', placeholder: 'slot-001' },
        { name: 'tags', label: '标签（逗号分隔）', placeholder: 'prod,instabox' },
      ],
      onSubmit: function (values) {
        var params = {
          label: values.label,
          authType: values.authType,
          tags: values.tags
            ? values.tags.split(',').map(function (tag) {
                return tag.trim();
              }).filter(Boolean)
            : undefined,
        };
        if (values.matrixSlotId) params.matrixSlotId = values.matrixSlotId;
        if (values.authType === 'key') {
          params.email = values.email;
          params.apiKey = values.apiKey;
        } else {
          params.token = values.token;
        }
        return rpc('cf.account.add', params).then(function (result) {
          return '已新增 ' + (result.matrixSlotId || result.egressPort || result.id);
        });
      },
    });
  }

  function openDeployWorker() {
    var options = state.slots
      .filter(function (slot) {
        return Boolean(slot.matrixSlotId);
      })
      .map(function (slot) {
        return {
          value: slot.matrixSlotId,
          label: slot.matrixSlotId + ' :' + (slot.egressPort || slot.proxyPort) + ' · ' + safeName(slot.label),
        };
      });
    if (!options.length) {
      toast('先新增一个槽位账号，再部署 Worker', 'err');
      return;
    }
    openModal({
      title: '多态部署 Worker',
      subtitle: '同一份逻辑按 Cloudflare 账号 id 生成不同 SHA-256 的模块；脚本名会先去敏。',
      submitLabel: '部署',
      fields: [
        { name: 'matrixSlotId', label: '槽位', type: 'select', value: options[0].value, options: options },
        { name: 'scriptName', label: '脚本名', value: 'instabox-edge', placeholder: 'instabox-edge' },
        {
          name: 'code',
          label: '模块源码',
          type: 'textarea',
          value:
            'export default {\n' +
            '  async fetch(request) {\n' +
            '    return new Response("matrix-ok", { status: 200 });\n' +
            '  },\n' +
            '};\n',
        },
      ],
      onSubmit: function (values) {
        var slot = slotById(values.matrixSlotId);
        if (!slot) throw new Error('槽位不存在：' + values.matrixSlotId);
        return rpc('cf.worker.deploy', {
          id: slot.accountId,
          scriptName: values.scriptName,
          code: values.code,
          polymorph: true,
        }).then(function (result) {
          return '已部署 ' + result.script + ' · ' + String(result.digest || '').slice(0, 12) + '…';
        });
      },
    });
  }

  function openTunnel(slot) {
    openModal({
      title: '签发 Instabox 隧道',
      subtitle: slot.matrixSlotId + ' :' + (slot.egressPort || slot.proxyPort) + ' · 生成 Zero Trust 隧道 + 代理 CNAME',
      submitLabel: '签发',
      fields: [
        { name: 'vmInstanceId', label: 'VM 实例 ID', placeholder: 'vm-instance-01' },
        { name: 'localPort', label: 'VM 本地端口', value: '8080', type: 'number' },
        { name: 'domainZone', label: '域名 Zone', placeholder: 'example.com' },
        { name: 'publicHostname', label: '公开主机名（留空自动）', placeholder: 'vm1.example.com' },
        { name: 'tunnelName', label: '隧道名（留空自动去敏）', placeholder: 'instabox-vm1' },
      ],
      onSubmit: function (values) {
        var params = {
          matrixSlotId: slot.matrixSlotId,
          vmInstanceId: values.vmInstanceId,
          localPort: Number(values.localPort || 8080),
          domainZone: values.domainZone,
        };
        if (values.publicHostname) params.publicHostname = values.publicHostname;
        if (values.tunnelName) params.tunnelName = values.tunnelName;
        return rpc('cf.tunnel.provision', params).then(function (result) {
          return '隧道 ' + result.tunnelId + ' → ' + result.publicHostname;
        });
      },
    });
  }

  function actDns(slot) {
    var tunnel = (slot.tunnels || [])[0];
    if (!tunnel) {
      toast('该槽位还没有 Instabox 隧道，先签发一条', 'warn');
      return;
    }
    rpc('cf.tunnel.provision', {
      matrixSlotId: slot.matrixSlotId,
      vmInstanceId: tunnel.vmInstanceId,
      localPort: tunnel.localPort,
      domainZone: tunnel.domainZone || (tunnel.publicHostname || '').split('.').slice(1).join('.'),
      publicHostname: tunnel.publicHostname,
      tunnelName: tunnel.tunnelName,
    })
      .then(function () {
        toast('DNS 已同步 · ' + tunnel.publicHostname);
        return refresh();
      })
      .catch(function (error) {
        toast(error.message, 'err');
      });
  }

  function actDrain(slot) {
    rpc('cf.slot.drain', { matrixSlotId: slot.matrixSlotId })
      .then(function (result) {
        toast('已排空 ' + result.matrixSlotId + ' · ' + result.drained + ' 条连接池');
        return refresh();
      })
      .catch(function (error) {
        toast(error.message, 'err');
      });
  }

  function actRotate(slot) {
    confirmModal(
      '强制换血 ' + slot.matrixSlotId,
      '会在 Egress Matrix 上请求轮换该槽位的租约，立即排空连接池，并在 POST_ROTATION_RESUME 前保持 fail-closed。',
      '确认换血',
      function () {
        return rpc('cf.slot.rotate', {
          matrixSlotId: slot.matrixSlotId,
          reason: 'panel-manual',
        }).then(function (result) {
          return '换血已提交 · 排空 ' + (result.drained && result.drained.drained) + ' 条连接';
        });
      },
    );
  }

  function verifyAll() {
    var button = document.getElementById('btn-verify');
    if (button.disabled) return;
    button.disabled = true;
    var slots = state.slots.slice();
    var ok = 0;
    var failed = 0;
    var chain = Promise.resolve();
    slots.forEach(function (slot) {
      chain = chain.then(function () {
        return rpc('cf.account.verify', { id: slot.accountId })
          .then(function (result) {
            if (result && result.ok) ok += 1;
            else failed += 1;
          })
          .catch(function () {
            failed += 1;
          });
      });
    });
    chain
      .then(function () {
        toast('验活完成 · 通过 ' + ok + ' / 失败 ' + failed, failed ? 'warn' : undefined);
        return refresh();
      })
      .catch(function (error) {
        toast(error.message, 'err');
      })
      .then(function () {
        button.disabled = false;
      });
  }

  /* ---------------------------------------------------------------- wiring */

  document.getElementById('filters').addEventListener('click', function (event) {
    var button = event.target.closest('.filter');
    if (!button) return;
    state.filter = button.getAttribute('data-filter') || 'ALL';
    document.querySelectorAll('.filter').forEach(function (node) {
      node.classList.toggle('active', node === button);
    });
    render();
  });

  document.getElementById('grid').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-act]');
    if (!button) return;
    var slot = slotById(button.getAttribute('data-slot'));
    if (!slot) {
      toast('槽位已失效，刷新后重试', 'err');
      return;
    }
    var action = button.getAttribute('data-act');
    if (action === 'tunnel') openTunnel(slot);
    else if (action === 'dns') actDns(slot);
    else if (action === 'drain') actDrain(slot);
    else if (action === 'rotate') actRotate(slot);
  });

  document.getElementById('btn-add').addEventListener('click', openAddAccount);
  document.getElementById('btn-deploy').addEventListener('click', openDeployWorker);
  document.getElementById('btn-verify').addEventListener('click', verifyAll);

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
      }, 15000);
    } else {
      setConn('未嵌入', 'bad');
      document.getElementById('grid').innerHTML =
        '<div class="empty"><strong>请从 OpenChamber 扩展面板打开</strong>' +
        '这个页面通过 openchamber.sdk 与本地服务通信，直接打开浏览器无法访问数据。</div>';
    }
  }

  boot();
})();
