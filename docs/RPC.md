# RPC 参考

扩展对外只暴露一个本地 HTTP 服务，所有能力都收敛成 JSON-RPC 方法。面板、CLI、脚本、后续的 agent 工具全部走同一入口。

## 传输

| 项目 | 值 |
| --- | --- |
| 监听 | `127.0.0.1:${OPENCHAMBER_SERVICE_PORT}`（由 OpenChamber host 注入） |
| 鉴权 | `Authorization: Bearer ${OPENCHAMBER_SERVICE_TOKEN}` |
| 健康检查 | `GET /health`，免鉴权，返回 `{ ok, name, version }` |
| 状态快照 | `GET /status`，需鉴权，等价于 `cf.matrix.status` |
| 槽位 REST | `GET /api/v1/cf/slots` → `{ ok, result: slot[] }` |
| 状态 REST | `GET /api/v1/cf/matrix/status`、`GET /api/v1/cf/egress/status` |
| Tunnel REST | `POST /api/v1/cf/tunnel/provision`、`POST /api/v1/cf/tunnel/teardown`，body 即 RPC `params` |
| RPC | `POST /rpc`，body `{ "method": "...", "params": { ... } }` |
| RPC（路径式） | `POST /rpc/<method>`，body 直接是 `params` 对象 |
| 请求体上限 | 2 MiB |
| 错误语义 | HTTP 恒为 200，结果在 `ok` 字段；只有传输层错误才用 4xx/5xx |

成功：

```json
{ "ok": true, "result": { } }
```

失败：

```json
{ "ok": false, "error": { "code": "ERR_NOT_FOUND", "message": "account \"x\" not found", "details": { } } }
```

常量时间比较 Bearer；错误码 `ERR_AUTH`、`ERR_JSON`、`ERR_METHOD`、`ERR_PARAMS`、`ERR_NOT_FOUND`、`ERR_PORT_RANGE`、`ERR_CONFIG_UNAVAILABLE` 是稳定契约。

```bash
curl -sS -X POST "http://127.0.0.1:$PORT/rpc" \
  -H "authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"method":"cf.matrix.status","params":{}}'
```

## 方法总览

| 方法 | 用途 | 是否写操作 |
| --- | --- | --- |
| `cf.rpc.methods` | 列出全部方法名 | 否 |
| `cf.matrix.status` | 运行状态、数据目录、配置路径、主密钥来源、绑定数、egress 快照 | 否 |
| `cf.matrix.slots` / `cf.slot.list` | 槽位视图：1:1 端口、风控、隧道、egress 指纹 | 否 |
| `cf.egress.status` | Egress 总线连接状态 + 槽位快照 + 绑定表 | 否 |
| `cf.slot.drain` | 立即排空一个槽位的连接池（绑定保留） | 是 |
| `cf.slot.rotate` | 排空后调用 Egress Matrix 强制换血 | 是 |
| `cf.config.get` | 读取完整运行配置 | 否 |
| `cf.config.patch` | 深合并配置并持久化，热生效 | 是 |
| `cf.account.add` | 添加账号，未给端口时自动分配 | 是 |
| `cf.account.update` | 修改账号字段，校验端口范围 | 是 |
| `cf.account.remove` | 关闭绑定并删除密封凭证与状态 | 是 |
| `cf.account.list` | 账号公开视图 + 运行状态 | 否 |
| `cf.account.status` | 单账号或全量状态 + 风控快照 | 否 |
| `cf.account.verify` | 调 Cloudflare 验证 Token/Key | 否（计一次预算） |
| `cf.proxy.probe` | 探测该账号代理出口 IP | 否（计一次预算） |
| `cf.dns.sync` | 确保 Zone 存在并幂等同步记录 | 是 |
| `cf.dns.list` | 分页列出 DNS 记录 | 否 |
| `cf.dns.delete` | 删除单条记录 | 是 |
| `cf.tunnel.spawn` | 创建/复用 Zero Trust Tunnel 并下发 ingress | 是 |
| `cf.tunnel.provision` | 槽位化签发：Tunnel + 代理 CNAME，返回 instabox 契约 | 是 |
| `cf.tunnel.teardown` | 删除 Tunnel、清理 CNAME 与本地记录 | 是 |
| `cf.tunnel.list` | 列出账号下 Tunnel | 否 |
| `cf.worker.deploy` | multipart 上传 Worker module | 是 |
| `cf.request` | 任意 Cloudflare v4 路径，单账号或自动故障转移 | 视 method |
| `cf.risk.report` | 熔断/预算快照，支持单账号 | 否 |
| `cf.risk.reset` | 手动清除冷却/隔离与窗口计数 | 是 |

## cf.rpc.methods

无参数。返回排序后的方法名数组。

## cf.matrix.status

无参数。

```json
{
  "apiBase": "https://api.cloudflare.com/client/v4",
  "portRange": [24001, 24250],
  "risk": { "rps": 4, "burst": 4, "windowLimit": 950, "windowMs": 300000, "jitterMs": [800, 3200] },
  "dataDir": "C:\\Users\\you\\.openchamber-cf-matrix-channel",
  "configPath": "C:\\Users\\you\\.openchamber-cf-matrix-channel\\cf-matrix.config.json",
  "masterKeySource": "generated",
  "masterKeyPath": "C:\\Users\\you\\.openchamber-cf-matrix-channel\\master.key",
  "accounts": 2,
  "bindings": [ { "accountId": "acme", "proxyPort": 24001, "status": "ACTIVE" } ]
}
```

`masterKeySource` 取值：`flag` / `env` / `file` / `generated`。

T0 起额外返回 `egress` 与 `slots`：

```json
{
  "egress": {
    "enabled": true,
    "status": { "connected": true, "baseUrl": "http://127.0.0.1:19880", "clientId": "cf-matrix-host" },
    "state": { "ok": true, "updatedAt": 1763000000000, "slots": [ { "matrixSlotId": "slot-001", "egressPort": 24001, "routingPlane": "STRICT_CONTROL", "healthState": "ACTIVE", "leaseId": "lease-7f2c", "egressFingerprint": { "exitIp": "203.0.113.7", "ipv6Prefix64": "2001:db8:1::/64", "asn": 13335, "leaseId": "lease-7f2c", "updatedAt": 1763000000000 } } ] }
  },
  "slots": [ "同 cf.matrix.slots 的元素" ]
}
```

## cf.matrix.slots

无参数（`cf.slot.list` 为别名）。按 `matrixSlotId` 升序返回槽位数组：

```json
{
  "matrixSlotId": "slot-001",
  "egressPort": 24001,
  "accountId": "acme",
  "label": "Acme 主账号",
  "enabled": true,
  "authType": "token",
  "proxyPort": 24001,
  "cloudflareAccountId": "0123456789abcdef0123456789abcdef",
  "status": "ACTIVE",
  "cooldownUntil": 0,
  "quarantineReason": null,
  "healthScore": 100,
  "lastRay": "8f2c1d7e8a3b4c5d",
  "lastUsedAt": 1763000000000,
  "successCount": 42,
  "failureCount": 1,
  "window": { "used": 120, "limit": 950, "remaining": 830, "windowMs": 300000 },
  "zones": ["example.com"],
  "tunnels": [
    { "tunnelId": "tun-1", "tunnelName": "instabox-vm1", "vmInstanceId": "vm1", "publicHostname": "vm1.example.com", "localPort": 8080, "createdAt": 0, "updatedAt": 0 }
  ],
  "egress": { "matrixSlotId": "slot-001", "egressPort": 24001, "routingPlane": "STRICT_CONTROL", "healthState": "ACTIVE", "leaseId": "lease-7f2c", "egressFingerprint": { } }
}
```

`egress` 来自 net-binder 的实时绑定检查；未配置 egress 总线时为 `null`。

## cf.egress.status

无参数。返回 `{ enabled, status, state, bindings }`：`status` 是 19880 总线连接状态，`state` 是最近一次 `GET /api/v1/egress/state` 快照，`bindings` 是每个账号/槽位的实时绑定（含 `drainCount`、`lastDrainedAt`）。

## cf.slot.drain

`{ "matrixSlotId": "slot-001" }`。立即销毁该槽位的全部连接池（`PRE_ROTATION_FREEZE` 的手动版本），绑定与密封凭证保留，下一次请求自动重建传输。返回 `{ matrixSlotId, drained }`。

## cf.slot.rotate

`{ "matrixSlotId": "slot-001", "reason": "panel-manual" }`。先本地排空，再调用 Egress 总线 `POST /api/v1/egress/slots/<slot>/rotate`。总线未启用时抛 `ERR_EGRESS_BUS_UNAVAILABLE`。返回 `{ matrixSlotId, drained, rotation }`。

## cf.config.get

无参数。返回 `{ configPath, dataDir, masterKeySource, masterKeyPath, config }`。`config` 是深拷贝，不含 `accounts` 与 `dataDir`。

## cf.config.patch

参数二选一：扁平对象，或 `{ "patch": { ... } }`。只接受白名单键：

`apiBase`、`proxyHost`、`proxyAuth`、`egressBusUrl`、`routingPlane`、`portStart`、`portEnd`、`probe`、`risk`、`http`

`accounts`、`dataDir` 在写入前被剥离。写入走 tmp + rename 原子替换，并把同一个 `config` 对象原地更新，所以 net-binder / cf-client 的动态读取立刻生效，无需重启 service。

```json
{ "patch": { "risk": { "rps": 3, "jitter": { "minMs": 500 } }, "proxyAuth": "user:pass" } }
```

返回 `{ configPath, config }`。

## cf.account.add

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `label` | string | 是 | 展示名 |
| `id` | string | 否 | 省略时由 label 生成 slug |
| `authType` | `token` \| `key` | 否 | 默认 `token` |
| `token` | string | 二选一 | API Token |
| `apiKey` + `email` | string | 二选一 | Global API Key 模式 |
| `cloudflareAccountId` | string | 否 | 多账号用户必填 |
| `tags` | string[] | 否 | 用于筛选与选路 |
| `proxyPort` | int | 否 | 省略则取第一个未绑定的 egress 槽位端口（24001 起） |
| `matrixSlotId` | string | 否 | `slot-001`…`slot-250`；给定时 `proxyPort` 必须等于 `24000 + index` |
| `egressIpv6` | string | 否 | /64 元数据，Node 路径仍走本地端口 |
| `enabled` | boolean | 否 | 默认 true |

返回账号公开视图（不含 token/apiKey，只给 `hasToken` / `hasApiKey`）。

## cf.account.update

`{ "id": "...", "patch": { ... } }`。`proxyPort` 会校验在 `[portStart, portEnd]`；其它字段原样交给 vault 归一化。返回更新后的公开视图。

## cf.account.remove

`{ "id": "..." }`。先 `net.close()` 释放绑定，再删密封记录与状态。返回 `{ removed: true }` 一类结果；不存在时报 `ERR_NOT_FOUND`。

## cf.account.list

无参数。返回 `{ accounts: [...] }`，账号公开视图带 `state`（`status`、`strikes`、`healthScore` 等）。

## cf.account.status

- `{ "id": "..." }` → `{ account, state, risk }`
- `{}` → `{ accounts: [{ ...state, risk }], bindings }`

## cf.account.verify

`{ "id": "..." }`。Token 模式请求 `GET /user/tokens/verify`，Global Key 模式请求 `GET /user`。结果写回 `lastVerifiedAt` / `verifyStatus`。返回 `{ accountId, ok, status, expiresOn, cfRay }`；API 拒绝时 `ok:false` 并带 `error`，不抛异常。

## cf.proxy.probe

`{ "id": "..." }`。经该账号 1:1 端口做出口探测，返回 `{ accountId, proxyPort, ip, ... }`。端口不可达时抛 `ERR_PROXY_UNREACHABLE`（fail-closed，绝不直连）。

## cf.dns.sync

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `domain` | string | 必填，Zone 名 |
| `records` | array | 必填，`[{ type, name, content, proxied?, ttl?, priority? }]` |
| `id` | string | 省略时按标签/负载选路 |
| `cloudflareAccountId` | string | 覆盖账号内的 account id |
| `createZone` | boolean | 默认 true；false 且 Zone 不存在时报 `ERR_ZONE_NOT_FOUND` |

返回 `{ zoneId, zoneName, createdZone, created, updated, unchanged, accountId }` 汇总。重复调用幂等。

## cf.dns.list / cf.dns.delete

`list`：`{ zoneId, id?, page?, perPage? }`，返回分页记录。
`delete`：`{ zoneId, recordId, id? }`，返回删除结果。

## cf.tunnel.spawn

`{ tunnelName, ingress: [{ hostname, service }], id?, cloudflareAccountId? }`。创建或复用同名 Tunnel，写入 ingress 配置并返回 `{ tunnelId, tunnelName, token, connections }` 一类结果。ingress 省略时为空数组。

## cf.tunnel.list

`{ id?, perPage?, cloudflareAccountId? }`。返回账号下 Tunnel 列表。

## cf.tunnel.provision

槽位化签发，供 openchamber-instabox 直接调用。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `matrixSlotId` | string | 是 | `slot-001`…`slot-250`，决定账号与出口 |
| `vmInstanceId` | string | 是 | 调用方 VM 实例 ID |
| `localPort` | int | 否 | VM 内服务端口，默认 8080 |
| `domainZone` | string | 是 | 公开主机名所在的 Zone |
| `publicHostname` | string | 否 | 省略则为 `<sanitized-tunnel-name>.<domainZone>` |
| `tunnelName` | string | 否 | 省略时按 `vmInstanceId` + 槽位生成去敏名 |
| `cloudflareAccountId` | string | 否 | 覆盖账号内 account id |
| `createZone` | boolean | 否 | 默认 true；false 且 Zone 不存在时报 `ERR_ZONE_NOT_FOUND` |
| `ingress` | array | 否 | 追加 ingress 规则 |

返回：

```json
{
  "matrixSlotId": "slot-001",
  "egressPort": 24001,
  "accountId": "acme",
  "tunnelId": "tun-1",
  "tunnelToken": "eyJh...",
  "tunnelName": "instabox-vm1",
  "publicHostname": "vm1.example.com",
  "localPort": 8080,
  "vmInstanceId": "vm1",
  "cfRay": "8f2c1d7e8a3b4c5d",
  "dns": { "created": [], "updated": [], "unchanged": [] }
}
```

幂等：同槽位 + 同 VM + 同 Zone 的重复调用会复用已记录的 Tunnel 与主机名。`tunnelToken` 只在响应里出现一次，本地以 AES-256-GCM 密封保存在 `cf-accounts-state.json`。

## cf.tunnel.teardown

`{ tunnelId, matrixSlotId?, cloudflareAccountId? }`。删除 Tunnel（`cascade=true`）、删除对应 CNAME、清理本地记录，返回 `{ matrixSlotId, accountId, tunnelId, deleted, dnsDeleted }`。Tunnel 不存在（404）也视为已删除。

## 出口绑定（STRICT_CONTROL）

- 账号与槽位静态 1:1：`cfAccountId → matrixSlotId → egressPort = 24000 + index`。
- 每次请求前检查 egress 快照：`WARP_OVERFLOW` / `ROTATING` / `QUARANTINED` / 缺失槽位 / 快照不可用 → `ERR_EGRESS_UNSAFE_FOR_CF_CONTROL`，绝不直连、绝不复用共享 WARP。
- 请求头固定注入 `X-OC-Routing-Plane: STRICT_CONTROL`、`X-OC-Matrix-Slot: <slot>`，代理认证为 `Proxy-Authorization: Basic base64("<slot>:STRICT_CONTROL")`。
- 订阅总线事件：`PRE_ROTATION_FREEZE` 立即排空该槽位连接池并回 `ACK_FREEZE`；`POST_ROTATION_RESUME` 更新 `egressFingerprint` 后恢复。

## cf.worker.deploy

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `scriptName` | string | 必填 |
| `code` | string | 必填，ES module 源码 |
| `id` | string | 省略时选路 |
| `bindings` | array | KV / D1 / secret 等绑定 |
| `filename` | string | multipart 内的文件名，默认 `worker.js` |
| `compatibilityDate` | string | 默认取当天 |
| `compatibilityFlags` | string[] | 可选 |
| `metadata` | object | 覆盖自动生成的 metadata |

实现是真实 multipart：`metadata` part（JSON）+ module part（源码），不是 JSON 包一层。

## cf.request

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | 必填，相对 `apiBase` 的路径，例如 `zones` |
| `id` | string | 指定账号；省略则自动故障转移 |
| `method` | string | 默认 GET |
| `body` | any | JSON body |
| `query` | object | 查询串 |
| `urgent` | boolean | 跳过泊松抖动 |
| `tag` | string | 选路标签（仅无 `id` 时） |

拒绝绝对 URL 与越界路径（`ERR_URL_SCOPE`）。返回 `{ accountId, status, cfRay, result }`，`result` 是 Cloudflare 响应体。

## cf.risk.report

- `{ "id": "..." }` → 单个快照
- `{}` → `{ accounts: [snapshot...], bindings }`

快照结构：

```json
{
  "accountId": "acme",
  "status": "ACTIVE",
  "strikes": 0,
  "cooldownUntil": 0,
  "quarantineReason": null,
  "healthScore": 100,
  "lastRay": "8f2...",
  "window": { "used": 120, "limit": 950, "remaining": 830, "windowMs": 300000 },
  "local": { "tokens": 3.2 }
}
```

## cf.risk.reset

`{ "id": "..." }`。清空本地令牌桶、滑动窗口与熔断状态，回到 `ACTIVE`、健康分 100。返回重置后的状态。

## 选路规则（pickAccount）

未显式给 `id` 时：

1. 候选 = `enabled !== false` 的账号；
2. 优先标签匹配 `tag` / 域名推断的标签；
3. 过滤 `QUARANTINED`，再过滤冷却未结束的 `COOLDOWN`；
4. 按健康分、窗口余量、最近使用时间排序；
5. 全不可用时抛错，绝不直连绕过。

## 错误码

| code | 含义 |
| --- | --- |
| `ERR_PARAMS` | 参数缺失或类型不对 |
| `ERR_NOT_FOUND` | 账号/记录不存在 |
| `ERR_PORT_RANGE` | 端口在池外或非法 |
| `ERR_PORT_IN_USE` | 目标端口已被占用 |
| `ERR_ACCOUNT_DISABLED` | 账号被停用 |
| `ERR_PROXY_UNREACHABLE` | 代理端口不可达，fail-closed 拦截 |
| `ERR_QUARANTINED` | 账号处于隔离态 |
| `ERR_COOLDOWN` | 冷却中且无其它可用账号 |
| `ERR_TOKEN_BUDGET` | 窗口预算耗尽 |
| `ERR_URL_SCOPE` | 请求路径越出 apiBase |
| `ERR_ZONE_NOT_FOUND` | `createZone:false` 且 Zone 不存在 |
| `ERR_CF_API` | Cloudflare 返回业务错误，`details` 带 status / errors |
| `ERR_VAULT_KEY_MISMATCH` | 主密钥与仓不匹配 |
| `ERR_SLOT_TAKEN` | egress 槽位已绑定其它账号 |
| `ERR_SLOT_INVALID` | `matrixSlotId` 不在 `slot-001`…`slot-250` |
| `ERR_SLOT_UNBOUND` | 该槽位没有绑定账号 |
| `ERR_EGRESS_UNSAFE_FOR_CF_CONTROL` | 槽位处于 `WARP_OVERFLOW` / `ROTATING` / `QUARANTINED` / 快照缺失，fail-closed |
| `ERR_EGRESS_BUS_UNAVAILABLE` | 未配置 Egress 总线，无法执行联动换血 |
| `ERR_TUNNEL_NOT_FOUND` | 本地仓没有该 Tunnel 记录 |
| `ERR_TUNNEL_NAME` | Tunnel 名不符合去敏规则 |
| `ERR_HOSTNAME_ZONE` | 主机名不在给定 Zone 下 |
| `ERR_LOCAL_PORT` | `localPort` 非法 |
| `ERR_CONFIG_UNAVAILABLE` | 未启用运行时配置写入 |
