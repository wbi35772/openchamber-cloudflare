# 架构详解 — openchamber-cloudflare

> 本文是 cf-matrix-channel 的长期维护文档：模块边界、数据流、状态机、失败语义、以及为什么这样设计。
> 面向后续迭代开发，不面向最终用户。用户安装说明见根目录 `README.md`。

## 1. 定位与目标

一个 OpenChamber 扩展，把 **多个 Cloudflare 账号** 组织成一个可编排的矩阵：

| 能力 | 实现 |
| --- | --- |
| 账号隔离 | 每个账号 1:1 绑定一个本地代理端口（默认 24001–24250） |
| 出口一致性 | 同一账号的所有请求走同一 `proxy-fetch` transport + 固定指纹（UA、Accept-Language、header 顺序） |
| 安全 | 凭证 AES-256-GCM 密封，跨进程文件锁，原子写 |
| 风控 | 双令牌桶 + 持久化滑动窗口 + 泊松抖动 + 三级熔断 |
| 可运维 | 面板 / CLI / JSON-RPC 三种入口共享同一数据目录 |
| fail-closed | 代理端口不可达时直接拒绝请求，绝不回退到宿主机直连 |

非目标：

- 不内置 sing-box / mihomo，端口由外部代理软件监听；扩展只负责「按账号选端口 + 探活 + 拒绝越界」。
- 不在扩展内做 Cloudflare 账号注册、验证码、支付等业务。
- IPv6 /64 仅作为账号元数据保存，Node 路径不做源地址绑定（见 §9 决策记录）。

## 2. 运行时拓扑

```
┌──────────────────────────── OpenChamber host ────────────────────────────┐
│  panel (iframe)  ── openchamber.sdk postMessage ──▶  service-request       │
│                                                        │                  │
│                                          Bearer OPENCHAMBER_SERVICE_TOKEN │
│                                                        ▼                  │
│                                    service/main.js (127.0.0.1:PORT)       │
│                                       │  /health  /rpc                     │
│                                       ▼                                   │
│                                    index.js createMatrix()                │
└───────────────────────────────────────┬───────────────────────────────────┘
                                        │
        ┌───────────────┬───────────────┼────────────────┬──────────────┐
        ▼               ▼               ▼                ▼              ▼
   vault-store     risk-engine      net-binder       cf-client     config-store
   (AES-GCM)      (bucket/breaker) (1:1 port)      (Cloudflare)   (JSON patch)
        │               │               │                │
        ▼               ▼               ▼                ▼
 cf-accounts.json  state.json     proxyHost:PORT   api.cloudflare.com
 master.key        (budget/状态)   (sing-box/mihomo)   (经代理传输)
```

三个入口：

1. **panel**（`panel/index.html`）— OpenChamber 内嵌页面，零构建 IIFE，只通过 host 的 `service-request` 访问 `/rpc`。
2. **CLI**（`node index.js ...`）— 直接调用库，适合脚本、首次初始化、排障。
3. **JSON-RPC**（`POST /rpc`）— host service 暴露给面板与外部集成。

三者共用同一 `dataDir`，没有第二份状态。

## 3. 数据目录与持久化

默认数据目录：`~/.openchamber-cf-matrix-channel`（可用 `CF_MATRIX_DATA_DIR` 或 `--data-dir` 覆盖）。

```
~/.openchamber-cf-matrix-channel/
├── master.key              # 32 字节随机主密钥，首次运行自动生成，权限 600
├── cf-matrix.config.json   # 非敏感运行参数（端口池、风控、HTTP）
├── cf-accounts.json        # 密封后的账号 profile（AES-256-GCM）
└── cf-accounts-state.json  # 运行时状态：熔断状态、strikes、预算桶
```

### 3.1 为什么要拆三个文件

- `cf-accounts.json` 变动少、含密文，整体重写成本低。
- `cf-accounts-state.json` 高频变动（每次请求都可能更新预算桶），单独文件降低写放大，也减少密文文件被反复打开。
- 配置与凭证彻底分离：`sanitizeConfig` 每次写配置时删除 `accounts` 字段，保证配置文件永远不含账号。

### 3.2 主密钥解析顺序

```
--master-key
  → CF_MATRIX_MASTER_KEY
  → --master-key-file / CF_MATRIX_MASTER_KEY_FILE
  → <dataDir>/master.key（不存在则生成 0600 文件）
```

`cf.matrix.status` 会返回 `masterKeySource`（`flag` / `env` / `file` / `generated` / `keyfile`）和 `masterKeyPath`，便于排障时确认用的是哪把钥匙。

### 3.3 密封格式

- 算法：AES-256-GCM。
- 每条 secret（token / apiKey）独立 IV；AAD 绑定账号 id 与字段名，防止密文在账号间搬运。
- 明文只存在于 RPC 进程内存与 outbound HTTP header，永不落盘、永不返回面板（`hasToken` / `hasApiKey` 布尔代替）。
- 密钥不匹配 → `ERR_VAULT_KEY_MISMATCH`，不会尝试解密或回退。

### 3.4 跨进程一致性

`lib/store-lock.js` 提供 `withStateLock`：

1. 打开/创建 `.lock` 文件；
2. 重试式独占锁（跨进程）；
3. 读最新 JSON → 应用变更 → 写临时文件 → `fs.rename` 原子替换；
4. 释放锁。

自检里有一条 20 并发 mutation 的用例，确认无丢更新；还有跨进程 spawn 用例，确认两个进程同时 add 账号不会互相覆盖。

## 4. 请求生命周期

以 `cf.dns.sync` 为例：

```
RPC/CLI 调用
  └─ cf-client.ensureZoneAndDns(accountId, zoneName, record)
       ├─ resolveProfile(accountId)            # 从 vault 取密封 profile，内存解密
       ├─ risk.reserve(accountId, {urgent})    # 双桶 + 窗口；失败抛 RiskError
       ├─ net.bind(accountId)                  # 端口绑定；已绑定则复用
       │    ├─ tcpProbe(proxyPort)             # 不可达 → ERR_PROXY_UNREACHABLE（fail-closed）
       │    └─ createProxyFetch(proxyPort)     # CONNECT 隧道 + TLS
       ├─ transport.fetch(apiBase + path)      # 固定 UA / Accept-Language / header 顺序
       ├─ risk.report(status, headers, body)   # 分类：正常 / 冷却 / 隔离
       └─ 返回 result + cfRay
```

关键点：

- **先风险检查，再网络调用**。预算不足时请求根本不会发出。
- **先探活，再 fetch**。代理端口关闭时错误在本地产生，不会出现「悄悄直连」。
- **响应回写风险状态**。429/1015/低 remaining → COOLDOWN；401/403 且错误码命中 → QUARANTINED。

## 5. 风控状态机

### 5.1 双令牌桶

| 桶 | 默认 | 作用 |
| --- | --- | --- |
| 速率桶 | 4 req/s，burst 4 | 限制瞬时并发 |
| 窗口桶 | 950 req / 300000 ms，10s 粒度 | 限制 Cloudflare 侧滑动窗口配额 |

窗口桶持久化在 `cf-accounts-state.json`，进程重启不清零；每组 `[bucketStart, count]`，超过 `maxBuckets` 截断最旧。

`urgent: true` 跳过**抖动**与排队，但仍消耗预算（避免「紧急」成为绕过配额的借口）。

### 5.2 泊松抖动

非紧急写操作在真正发出前等待 `exp(λ)` 抖动，裁剪到 `[jitter.minMs, jitter.maxMs]`（默认 800–3200ms）。目的：把批量账号操作摊平成接近泊松到达，避免同相位脉冲。

### 5.3 三级熔断

```
            429 / 1015 / remaining < threshold
   ACTIVE ─────────────────────────────────────▶ COOLDOWN
      ▲                                             │
      │ 冷却到期 + 成功请求                          │ 401/403 且 code ∈ {10000,9103,9106,9109}
      └─────────────────────────────────────────────┤
                                                    ▼
                                              QUARANTINED
                                        （只能人工 reset / 修复凭证）
```

- **ACTIVE**：正常参与 `pickAccount` 排名。
- **COOLDOWN**：记录 `cooldownUntil`。优先采用 `Retry-After`；缺失时指数退避 `base 30s → max 1h` + 1–5s 抖动。冷却中的账号不参与排名。
- **QUARANTINED**：凭证级故障，永久退出直到 `cf.risk.reset`。`quarantineReason` 保留证据。
- 每次失败累加 `strikes`，`healthScore` 递减；成功后回升。`cf.risk.report` 输出完整快照供面板展示。
- 状态变更会触发 `risk-alert` 事件（`matrix.on('risk-alert', ...)`），供宿主或测试订阅。

## 6. 网络绑定（net-binder）

### 6.1 1:1 端口

- `account.proxyPort` 必须落在 `[portStart, portEnd]`，否则 `ERR_PORT_OUT_OF_RANGE`。
- 未指定端口时 `nextFreePort()` 取池内第一个未被占用的端口（面板/CLI/RPC 行为一致）。
- 同一账号重复 bind 且端口/主机未变 → 复用现有 transport；变了 → 关闭旧 binding 重建。
- `proxyHost` / `proxyAuth` 是**动态读取**的：面板改完配置立即作用于下一次 bind，无需重启。

### 6.2 fail-closed

`bind()` 之后、每次 fetch 之前做 TCP 探活（`probe.tcpTimeoutMs`，默认 1200ms）。不可达直接抛：

```
ERR_PROXY_UNREACHABLE: proxy 127.0.0.1:24001 is unreachable for account X; request blocked (fail-closed)
```

没有 `try direct` 分支。这是硬约束，测试用例 `fail-closed: closed proxy port blocks before any fetch` 守着它。

### 6.3 指纹

每个账号的指纹由账号 id 散列得到：UA（`openchamber-cf-matrix/1.0 (platform; arch)`）、`Accept-Language`、header 顺序稳定。同一账号跨进程、跨重启保持一致；不同账号彼此不同。

### 6.4 连接槽位

`maxConnections` 信号量限制单账号并发连接；空闲超过 `keepAliveTimeoutMs` 自动关闭 transport，防止端口泄漏。

## 7. Cloudflare 客户端

`core/cf-client.js` 封装 v4 API：

| 方法 | 说明 |
| --- | --- |
| `verifyAccount` | token → `/user/tokens/verify`；global key → `/user` |
| `listZones` / `ensureZoneAndDns` | zone 查找 + DNS 记录幂等创建（dot-boundary 匹配，避免 `a.example.com` 命中 `example.com.evil`） |
| `provisionZeroTunnel` | 创建/复用 tunnel，返回 token |
| `deployWorkerScript` | multipart 上传（metadata + module 两部分） |
| `rawRequest` | 受 `apiBase` 约束的通用请求 |

约束：

- 只允许相对路径；绝对 URL 必须同源于 `apiBase`，否则 `ERR_URL_SCOPE`。
- 每次请求带 `cfRay` 回传，便于对账。
- `apiBase` 可运行时 patch（测试/私有网关场景），同样经过 URL 校验。

## 8. 配置系统

`config/defaults.js`（纯函数） + `config/config-store.js`（文件 IO）。

- 默认值 → 文件 → 环境变量 → 显式 options 四层合并（`merge` 带原型污染防护）。
- 所有数值都做 clamp：端口区间、rps、burst、窗口、抖动、退避、HTTP 超时/重试。
- 可 patch 的键白名单：`apiBase`、`proxyHost`、`proxyAuth`、`portStart`、`portEnd`、`probe`、`risk`、`http`。
- `accounts` / `dataDir` 在写入时被剥离；`sanitizeConfig` 保证凭证永不进入配置文件。
- `saveConfig` **原地修改共享 config 对象**，因此 cf-client / net-binder 的动态读取立即生效。

### 8.1 环境变量（全部可选）

| 变量 | 作用 |
| --- | --- |
| `CF_MATRIX_DATA_DIR` | 数据目录 |
| `CF_MATRIX_CONFIG` | 配置文件路径 |
| `CF_MATRIX_MASTER_KEY` | 主密钥（hex/base64） |
| `CF_MATRIX_MASTER_KEY_FILE` | 主密钥文件 |
| `CF_MATRIX_API_BASE` | API 基址 |
| `CF_FAIL_CLOSED` | 仅接受 `true`/`1`；其它值启动即拒绝 |

## 9. 决策记录

| 决策 | 原因 | 放弃的方案 |
| --- | --- | --- |
| 独立仓库，不依赖 instabox | 安装即用，零 runtime 依赖 | 复用 instabox 包路径（换机器即断） |
| 复制 `lib/proxy-fetch.js` | 不引入 `undici`，Node 内置即可 | 依赖 `undici.ProxyAgent`（多一个依赖） |
| IPv6 /64 只存元数据 | Node 无法稳定做源地址绑定；失败要显式 | 强行 `localAddress` 绑定（跨平台不可靠） |
| 配置/凭证/状态三文件 | 写放大、密钥暴露面、审计清晰 | 单 JSON 全量重写 |
| 端口池默认 24001 起 | 与既有 sing-box 编排约定一致 | 随机高位端口（难排查） |
| `urgent` 只跳过抖动 | 保留配额纪律 | 完全绕过预算（会被滥用） |
| 面板零构建 IIFE | 安装即用，无需 npm build | React/Vite 构建产物（增加发布步骤） |
| 主机空闲 10 分钟停 service | host 行为，非本扩展控制；状态必须落盘 | 内存态（重启即丢） |

## 10. 扩展点

- **新 RPC 方法**：在 `bridge/rpc-handler.js` 的 `methods` 表注册；参数校验放在方法内；错误用 `RpcError`。
- **新风控维度**：`core/risk-engine.js` 的 `report` / `reserve`；状态字段加到 state（注意向后兼容）。
- **新传输**：`net-binder` 的 `createTransport` 注入点；测试里用假 transport 替换。
- **面板视图**：`panel/main.js` 的 `render*`；数据一律来自 RPC，不在前端存凭证。

## 11. 已知边界

- 代理软件本身（sing-box/mihomo）需由用户或外部编排提供并监听对应端口；扩展只探活。
- 面板单页，账号很多时（>200）一次性渲染会变慢；后续可加虚拟列表。
- `cf-accounts-state.json` 只增不减的 strikes 需要 `cf.risk.reset` 清理。
- SQLite/多进程高频写场景未覆盖；当前按「人工操作 + 中低频自动化」设计。
