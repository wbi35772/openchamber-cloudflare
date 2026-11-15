# cf-matrix-channel

多 Cloudflare 账号矩阵扩展：**1:1 本地代理端口绑定、加密凭证仓、持久化滑动窗口预算、三级熔断状态机、JSON-RPC 桥**。

该目录是一个独立 OpenChamber 扩展仓库，复用了 `openchamber-instabox-matrix` 的四个底座模块：

| 底座 | 本扩展中的用途 |
| --- | --- |
| `lib/proxy-fetch.js` | 每个账号独立的代理传输实例，CONNECT 隧道，fail-closed |
| `lib/store-lock.js` | `withStateLock` 跨进程互斥 + tmp/rename 原子写 |
| `lib/scheduler.js` | 账号相位散列（FNV-1a） |
| `lib/sub2port.js` | 端口池约定（24001–24250）随仓库复制，供后续 sing-box 编排复用 |

## 目录

```text
openchamber-cf-matrix-channel/
├── index.js                  # 库入口 + CLI
├── icon.svg                  # 扩展/面板图标
├── package.json              # OpenChamber extension 清单（panel + page + service）
├── config/
│   ├── defaults.js           # 默认值 / 归一化
│   ├── config-store.js       # 配置文件读写 / 运行时 patch
│   ├── cf-matrix.schema.json # 配置 JSON Schema
│   └── cf-matrix.config.example.json # 种子账号与风控参数示例
├── core/
│   ├── vault-store.js        # AES-256-GCM 加密账号仓 + 原子状态文件
│   ├── risk-engine.js        # 令牌桶、泊松抖动、滑动窗口、熔断器
│   ├── net-binder.js         # 1:1 端口绑定、TCP 探活、连接槽位
│   └── cf-client.js          # Cloudflare v4 API（DNS / Tunnel / Worker）
├── bridge/
│   └── rpc-handler.js        # JSON-RPC 方法表
├── panel/
│   ├── index.html            # 扩展面板（OpenChamber SDK 桥）
│   ├── main.js               # 零构建 IIFE，账号/风控/设置全部在此操作
│   └── style.css
├── service/
│   └── main.js               # OpenChamber host service
└── test/
    ├── self-check.js         # 断流 / 并发 / 429 自检
    ├── integration-check.js  # 环回 mock Cloudflare 集成检验
    └── panel-host.html       # 面板假 host（本地调试用）
```

## 安装即用

这个目录就是完整扩展，没有构建步骤、没有 runtime 依赖，也不需要先跑 `npm install`：

1. OpenChamber → 设置 → 扩展 → 从本地目录安装，选择本目录。
2. 在扩展设置里允许本地服务，然后从面板打开 **Cloudflare Matrix**。
3. 首次打开会自动在 `~/.openchamber-cf-matrix-channel` 生成 `master.key` 和 `cf-matrix.config.json`，无需 `.env`、无需手动初始化。
4. 点面板右上角 **添加账号**，粘贴 Cloudflare API Token 即可；代理端口自动分配，配置项全部在 **设置** 里热更新。

面板、CLI、RPC 共用同一份数据目录和服务；换一台机器、换一个 OpenChamber 安装，只要目录被安装并允许服务就能直接用。Host 会在空闲 10 分钟后停掉 service，下次访问自动拉起，状态不会丢。

## 零配置启动

首次运行不需要写任何 `.env`，也不需要手改配置文件。面板第一次打开或 service 第一次启动就会自动生成；也可以在 CLI 里显式跑一次 `node index.js init`：

首次初始化会在数据目录（默认 `~/.openchamber-cf-matrix-channel`）生成：

| 文件 | 用途 |
| --- | --- |
| `master.key` | 自动生成的 32 字节高熵主密钥（0600） |
| `cf-matrix.config.json` | 运行参数（风控、端口池、apiBase、probe） |
| `cf-accounts.json` | 加密账号仓（首次加账号时创建） |

之后用 CLI 或 RPC 改参数即可，改动立即生效并落盘：

```bash
node index.js config get
node index.js config set risk.rps=3 risk.jitter.minMs=500 portStart=24100
node index.js config patch '{"risk":{"windowLimit":900}}'
node index.js account add --label "Acme" --token-stdin --tags prod,eu   # 自动分配空闲端口
node index.js accounts
```

全局参数可临时覆盖（不写盘）：

```bash
node index.js --data-dir D:\cf-data --port-start 25000 status
node index.js --config D:\cf-data\alt.json config get
node index.js --master-key-file D:\secrets\cf.key accounts
```

### 环境变量（全部可选）

```bash
CF_MATRIX_MASTER_KEY=<密钥>          # 显式密钥，优先于 master.key 文件
CF_MATRIX_MASTER_KEY_FILE=<文件>     # 指定密钥文件
CF_MATRIX_DATA_DIR=<状态目录>        # 默认 ~/.openchamber-cf-matrix-channel
CF_MATRIX_CONFIG=<JSON 配置>         # 默认 <dataDir>/cf-matrix.config.json
CF_PORT_RANGE_START=24001            # 覆盖端口池下界
CF_PORT_RANGE_END=24250              # 覆盖端口池上界
CF_API_BASE=https://api.cloudflare.com/client/v4
CF_FAIL_CLOSED=true                  # 只接受 true；false 会在启动时报错
OPENCHAMBER_SERVICE_PORT / OPENCHAMBER_SERVICE_TOKEN  # 由 OpenChamber host 注入
```

主密钥解析顺序：显式 `--master-key` → `CF_MATRIX_MASTER_KEY` → `--master-key-file`/`CF_MATRIX_MASTER_KEY_FILE` → `<dataDir>/master.key`（不存在则自动生成）。换错密钥会在启动时抛 `ERR_VAULT_KEY_MISMATCH`，不会静默写坏数据。

## 启动

```bash
# 作为 OpenChamber service（由 host 注入端口与 token）
node service/main.js

# 初始化 + 日常操作
node index.js init
node index.js status
node index.js accounts
node index.js verify <accountId|label>
node index.js rpc cf.dns.sync '{"domain":"example.com","records":[{"type":"A","name":"@","content":"203.0.113.10","proxied":true}]}'
```

配置文件里的 `accounts[]` 会在 `matrix.ready` 完成后按顺序写入加密仓；端口未写时自动从端口池取空闲值。service 会等 `matrix.ready` 再监听，CLI 也会等待，避免启动竞态。`account add` 未指定 `--proxy-port` 时同样自动取空闲端口。

## RPC 方法

所有方法通过 `POST /rpc`，请求体 `{"method":"...","params":{...}}`，或 `POST /rpc/<method>` 直接传参数对象。除 `GET /health` 外均需 `Authorization: Bearer <OPENCHAMBER_SERVICE_TOKEN>`。

| 方法 | 说明 |
| --- | --- |
| `cf.matrix.status` | 配置、端口池、账号数、绑定连接状态、主密钥来源 |
| `cf.config.get` | 当前配置全文 + 配置文件路径 + 主密钥来源 |
| `cf.config.patch` | 运行时热更新配置（`apiBase`/`portStart`/`portEnd`/`probe`/`risk`/`http`），立即落盘 |
| `cf.account.add` | 新增账号；省略 `proxyPort` 时自动取空闲端口，token 落盘即加密 |
| `cf.account.update` / `remove` / `list` / `status` | 账号 CRUD 与状态 |
| `cf.account.verify` | `/user/tokens/verify`（token）或 `/user`（global key） |
| `cf.proxy.probe` | 经绑定代理访问 `cdn-cgi/trace`，返回出口 IP / 地区 |
| `cf.dns.sync` | 幂等对齐 A/AAAA/CNAME/TXT/MX/NS/SRV/CAA/PTR |
| `cf.dns.list` / `cf.dns.delete` | Zone 内 DNS 记录操作 |
| `cf.tunnel.spawn` | 创建/复用 Argo Tunnel、写入 ingress、取回 tunnel token |
| `cf.tunnel.list` | 列出账号下 Tunnel |
| `cf.worker.deploy` | multipart 上传 ES module Worker |
| `cf.request` | 原始 v4 API 调用；无 `id` 时按健康分/预算自动选号 |
| `cf.risk.report` / `cf.risk.reset` | 熔断快照 / 重置预算与状态 |

## 风控基线

- 单账号本地令牌桶：`4 req/s`，突发 `4`。
- 持久化滑动窗口：`950 req / 5 min`（10 秒桶），低于 Cloudflare 1200 阈值。
- 非紧急写操作注入 `800–3200ms` 泊松抖动；`urgent: true` 跳过抖动。
- `429` / `1015` / `Ratelimit-Remaining < 50` → `COOLDOWN`，指数退避 + jitter，`Retry-After` 优先。
- `401/403` / `10000` / `9103` / `9106` / `9109` → `QUARANTINED`，释放传输实例并告警。
- 每个账号固定 UA / Accept-Language / Header 序列；请求必须经绑定端口，端口不可达直接 `ERR_PROXY_UNAVAILABLE`，**没有直连回退**。

## 自检

```bash
node test/self-check.js       # 单元 / 并发 / 风控状态机
node test/integration-check.js # 环回 mock Cloudflare，经真实代理 HTTP 路径
node test/fresh-install-check.js # 空目录启动 service，验证自动建密钥/配置/首个端口
npm test                       # 以上三项串联
```

面板本地调试（不需要 OpenChamber）：

```bash
node test/panel-host-server.js
# 浏览器打开 http://127.0.0.1:4599/test/panel-host.html
```

包含：加密落盘、20 并发状态写、8 进程跨进程写、20 并发预算抢占（5 成功 / 15 拒绝）、429 冷却与选号漂移、403 隔离、关闭端口 fail-closed、真实 TCP 探活 + 固定指纹、multipart 校验、密钥不匹配拒绝、apiBase 越界 URL 拒绝、种子账号 `matrix.ready` 时序。

## 与设计稿的差异

1. **CommonJS**：与 instabox 扩展及 OpenChamber host 的加载方式一致；未使用 ESM。
2. **不直接 `import undici`**：当前安装模型不暴露 undici，网络层复用 `lib/proxy-fetch.js`（零依赖 CONNECT/TLS 实现）。`keepAliveTimeout`/`maxConnections` 以“连接槽位 + 空闲回收”实现等价约束。
3. **IPv6 /64**：作为账号绑定元数据写入 vault 并随绑定状态暴露；实际出口由 sing-box 入站决定。Node 侧只认本地端口，仍然 fail-closed。
4. **凭证仓拆成两个文件**：`cf-accounts.json`（静态资料 + 密封凭证，低频写）与 `cf-accounts-state.json`（状态/预算/健康分，高频写）。两者都走 `withStateLock`，降低高频写时暴露密文的窗口。
