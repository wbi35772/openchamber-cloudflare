# 开发与迭代指南

面向要在本仓库上继续加功能的人（包括未来的 agent）。设计动因见 [ARCHITECTURE.md](./ARCHITECTURE.md)，接口细节见 [RPC.md](./RPC.md)。

## 环境

| 依赖 | 要求 |
| --- | --- |
| Node | `>=20`（本机验证 24.22.1） |
| 包管理 | 无 runtime 依赖，`npm install` 只是为了跑脚本也非必需 |
| 宿主 | OpenChamber `>=2.7.0`（面板 SDK v1 + host service） |
| 构建 | 无。CommonJS，源码即产物 |

```bash
node --version
npm test
```

## 本地跑法

```bash
# 1. 单元 + 集成 + 全新安装
npm test

# 2. 只看单元
npm run check

# 3. 面板调试（不需要 OpenChamber）
node test/panel-host-server.js
# 打开 http://127.0.0.1:4599/test/panel-host.html

# 4. 手动起 service（host 会注入这两个变量）
OPENCHAMBER_SERVICE_PORT=4711 OPENCHAMBER_SERVICE_TOKEN=dev-token node service/main.js
```

`service/main.js` 缺 `OPENCHAMBER_SERVICE_PORT` / `OPENCHAMBER_SERVICE_TOKEN` 会直接退出，这是 host 契约，不要为“方便”加默认值。

## 装进 OpenChamber

设置 → 扩展 → 从本地目录安装 → 选本目录 → 允许本地服务 → 打开 **Cloudflare Matrix** 面板。

宿主行为（2.7.2 实测）：

- service 空闲 10 分钟被停，下次访问自动拉起；状态必须落在磁盘，本扩展全部落 `~/.openchamber-cf-matrix-channel`。
- 面板运行在 sandbox iframe 里，没有网络；一切数据经 `openchamber.sdk` 的 `service-request` 走 host 转发。
- `contributes.page: true` 让左侧栏图标能打开全屏页面，复用 `panel.entry`。

## 数据目录

默认 `~/.openchamber-cf-matrix-channel`，可用 `--data-dir` / `CF_MATRIX_DATA_DIR` 覆盖。

```text
~/.openchamber-cf-matrix-channel/
├── master.key              # 32 字节，0600；AES-256-GCM 主密钥
├── cf-matrix.config.json   # 运行参数；绝不存凭证
├── cf-accounts.json        # 密封后的账号档案
└── cf-accounts-state.json  # 运行状态、窗口桶、熔断、健康分
```

密钥解析顺序：

1. `--master-key <hex>`
2. `CF_MATRIX_MASTER_KEY`
3. `--master-key-file <path>` / `CF_MATRIX_MASTER_KEY_FILE`
4. `<dataDir>/master.key`，不存在则生成

前三种优先级意味着迁移机器时把 `master.key` 带过去即可解密旧仓；密钥不匹配会报 `ERR_VAULT_KEY_MISMATCH`，不会静默重建（那会毁掉旧凭证）。

## CLI

```bash
node index.js init
node index.js status
node index.js accounts
node index.js account add --label "Acme" --token-stdin --tags prod,eu
node index.js account update acme --port 24005
node index.js account remove acme
node index.js verify acme
node index.js config get
node index.js config set risk.rps=3 risk.jitter.minMs=500
node index.js config patch '{"proxyHost":"127.0.0.1"}'
node index.js rpc cf.risk.report '{"id":"acme"}'
```

全局参数：`--data-dir`、`--config`、`--master-key`、`--master-key-file`、`--json`。

凭证只从 `--token` / `--token-stdin` / `--token-env VAR` 进（`--api-key` 同理），不进 shell history 就选后两种。

## 测试分层

| 文件 | 覆盖 |
| --- | --- |
| `test/self-check.js` | 17 项：密封、公开视图、20 并发不丢更新、窗口预算、429→COOLDOWN、403→QUARANTINE、fail-closed、指纹稳定、滑窗裁剪、密钥不匹配、multipart 结构、端口归一化、告警、跨进程合并、`matrix.ready` 后才播种、URL 作用域 |
| `test/integration-check.js` | 环回 mock Cloudflare，走真实 CONNECT 代理路径，验证鉴权头、DNS 幂等、Tunnel、Worker multipart、429 故障转移、UA 指纹 |
| `test/fresh-install-check.js` | 空目录 + host 注入 PORT/TOKEN 起 service，断言自动建密钥/配置、首账号拿 24001 |

新增行为时先加断言再改代码。跨进程相关改动必须跑 `self-check` 里的并发段，它用子进程写仓，能抓到丢更新。

## 面板约定

`panel/` 是零构建 IIFE，刻意不用框架：宿主沙箱只保证一个 `postMessage` 通道，多一层打包没有收益。

协议关键点：

- 频段 `openchamber.sdk`，版本 `v: 1`；
- 加载后先发 `{ type: 'hello' }`，host 回 `{ type: 'ready', payload }`；
- 请求带自增 `id`；应答按 `id` 匹配，**没有 `type: 'result'`**，形如 `{ id, ok, payload, code, error }`；
- `service-request` 的 payload 是 `{ method, path, body: string }`，宿主回 `{ status, body }`；
- body 上限 64 KiB，host 请求超时 20 s，面板侧自设 18 s。

面板内调用链：

```js
rpc('cf.account.add', params)
  → service('POST', '/rpc', { body: { method, params } })
  → host 转发到 service
  → { ok, result } → 刷新三份快照
```

调试：改 `panel/main.js` 后刷新 iframe 即可；假 host 在 `test/panel-host.html`，mock 了账号、配置、风控与全部读写方法，`window.__METHODS` / `window.__CALLS` 可看调用序列。

## 加一个运行参数

1. `config/defaults.js`：`DEFAULTS` 加键，`normalizeConfig` 做类型收敛；
2. `config/config-store.js`：若允许运行时改，把键加进 `PATCHABLE`；
3. `config/cf-matrix.schema.json` 同步；
4. 消费方改成“每次读 `config.x`”，不要启动时缓存（`saveConfig` 原地更新同一对象）；
5. `panel/main.js` 设置弹窗加输入并进 patch；
6. README / RPC 文档补一行；
7. `npm test`。

注意 `sanitizeConfig` 会删掉 `accounts` 与 `dataDir`，新增敏感字段也要在这里剥离。

## 加一个 RPC 方法

在 `bridge/rpc-handler.js` 的 `methods` 表里加条目即可，路由与鉴权自动生效：

```js
async 'cf.zone.list'(params) {
  const id = pickAccount(params, { zoneName: params.domain });
  return client.listZones(id, { page: params.page });
},
```

规则：

- 参数用 `requireString` / `optionalBoolean` 收敛，别把原始对象直接透传；
- 抛 `RpcError(code, message, details)`，别抛裸 Error；
- 写操作考虑 `vault.mutateState` 的锁语义，禁止读-改-写跨 await；
- 方法名进 `cf.rpc.methods` 自动可见，文档同步到 `docs/RPC.md`；
- 面板只调用，不复制业务逻辑。

## 加一个面板动作

1. `panel/index.html` 放按钮/容器；
2. `panel/main.js` 在 `act()` 或 `data-act` 分支接 RPC；
3. 失败走 `toast(error.message, true)`，破坏性操作走 `confirmAction()`，不要 `window.confirm`（宿主沙箱里体验差）；
4. 操作后 `refresh()` 重拉三份快照，不要本地猜测状态。

## 状态与并发

- 跨进程互斥：`lib/store-lock.js` 的 `withStateLock`，锁文件 + 过期清理；
- 原子写：tmp 文件写完后 `rename`，Windows 上带重试；
- 单进程内：`vault.mutateState` 串行化同一账号的读改写；
- 预算计数持久化在 state 文件，service 重启不重置（这是防 429 的关键，别改成内存态）。

## fail-closed 纪律

本扩展永远不直连 Cloudflare：

- 端口不可达 → `ERR_PROXY_UNREACHABLE`；
- 账号隔离/冷却且无替代 → 抛错；
- `CF_FAIL_CLOSED=false` 在启动时被拒绝。

任何“降级直连”的 PR 都不接受，这会让多账号隔离失去意义。

## 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| 面板显示“服务未授权” | 设置 → 扩展里允许本地服务；host 不会自动授权 |
| 面板一直“连接中” | host 未回 `ready`；确认 `contributes.panel.entry` 指向存在的 HTML |
| `ERR_VAULT_KEY_MISMATCH` | 数据目录里的 `master.key` 被换过；换回原密钥或换新目录 |
| 首账号端口不是 24001 | 24001 被占；`nextFreePort()` 取池内最小空闲，属正常 |
| `npm test` 卡住 | 集成测试占用环回端口；杀残留 `node test/*` 进程后重跑 |
| Windows 下 rename 偶发失败 | 已带重试；若持续，检查杀软是否锁 tmp 文件 |

## 版本与发布

`package.json` 的 `version` 同时用于 `/health`。变更时：

1. 更新 `version`；
2. `docs/ARCHITECTURE.md` 的决策记录追加一条（日期 + 决策 + 原因）；
3. 本文件补新坑；
4. `npm test` 全绿；
5. 打 tag，推 GitHub。

## 迭代记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-15 | 初版：vault/风控/net-binder/cf-client/RPC；零配置密钥与配置文件自动生成 |
| 2026-11-15 | 加面板（OpenChamber SDK 桥）、`contributes.page`、`proxyHost`/`proxyAuth` 热更新 |
| 2026-11-15 | 修复面板启用/停用反向；新增 fresh-install 自检；Node 要求降至 20 |
| 2026-11-15 | 文档体系：ARCHITECTURE / RPC / DEVELOPMENT + Canvas 图文归档 |
