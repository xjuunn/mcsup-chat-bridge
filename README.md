# mcsup-chat-bridge

MCSUP 聊天桥插件：订阅 Minecraft 服务器的聊天、控制台与生命周期事件，归一化为统一消息模型，分类后分发到可插拔的聊天平台。

架构分两层：平台无关内核（采集 → 归一化 → 分类 → 入库 → 分发）与可插拔平台适配器。内置 **QQ 官方机器人（API v2）**、`log`、`null` 三种适配器。

QQ 适配器支持**双向互通**：

- 游戏 → QQ：玩家聊天按 `[玩家名]:消息` 发送到群/私聊；
- QQ → 游戏：群聊消息（可选私聊）经 `console:write` 以 `tellraw @a` 注入游戏，显示为 `[QQ] 昵称: 消息`（只有一个标签）。

## 快速开始

```powershell
npm install
npm run typecheck
npm test
npm run build
npm run test:real
```

一条命令跑完类型检查、单测、构建与真实进程测试：

```powershell
npm run verify
```

### 安装到 MCSUP 宿主

`build/` 只是编译产物，运行期仍需要 `mcsup-plugin`、`ws`、`zod`；而本仓库的
`mcsup-plugin` 是 `file:../mcsup/sdks/typescript`，npm 在 Windows 上会把它物化成
Junction。宿主把产物内的任何符号链接视为不可信，会直接拒绝
（`denied: symbolic link in artifact`），因此**不能把仓库根目录或 `build/` 直接
当作安装源**。

```powershell
npm run stage        # 生成自包含产物 artifact/（真实目录依赖，无符号链接）
mcsup plugin install --from .\artifact --yes
mcsup plugin verify .\artifact   # 可选：安装前让宿主校验一次
```

`scripts/stage-artifact.mjs` 会复制 `build/`，只把 SDK 的 `dist` + `package.json`
和 `ws`、`zod` 以真实目录放进 `artifact/node_modules/`，然后断言产物内没有符号
链接、文件数与体积未超宿主上限，并用一次真实 ESM 解析自检。

> 依赖 `mcsup-plugin@0.1.0`，通过 `file:../mcsup/sdks/typescript` 引用同级的 SDK 仓库。`scripts/ensure-sdk.mjs` 会比较 SDK 源码与 `dist/index.js` 的 mtime：缺失或过期时用 SDK 自带的 tsc 重新构建，已是最新时零开销。

## 目录结构

```
src/
  core/                     平台无关内核
    types.ts                消息模型、类别、来源、查询类型
    ids.ts                  内容摘要 id（sha256 base64url，16 字符）
    classify.ts             聊天 / 控制台行 / 生命周期 / 玩家的分类规则
    store.ts                环形缓存（头指针淘汰 + 文本截断）、去重、seq 游标分页
    dispatcher.ts           每平台固定大小环形队列 + 串行消费者 + 故障隔离
    bridge.ts               内核编排：启动、配置热更新、采集、入站注入、回声抑制
  platforms/                可插拔平台层
    types.ts                ChatPlatform / PlatformFactory / GamePort / 入站消息契约
    registry.ts             注册表（id 校验、实例化）
    qq.ts                   QQ 官方机器人 API v2（WebSocket Gateway + OpenAPI，双向）
    log.ts                  占位平台：写到插件日志
    null.ts                 空平台：只采集、不投递
    index.ts                内置平台注册入口
  events/normalize.ts       宿主事件校验（zod）与归一化
  config.ts                 配置 schema（含 QQ 与密钥字段）、resolveConfig
  ops/index.ts              messages（table + 分页）与 status（detail，含入站统计）
  index.ts                  definePlugin 接线、能力声明、GamePort（tellraw）
scripts/
  ensure-sdk.mjs            SDK 缺失或过期（mtime）时自动构建
  real-host-check.mjs       真实子进程 + 真实 TCP 假宿主 + 真实 QQ 官方协议（REST + Gateway）
test/                       分类、存储、分发、桥、入站、QQ、配置、事件、MockHost
```

构建产物在 `build/`：`manifest.json`、`descriptor.json`、`bin/run.cmd|run.sh`、`bin/entry.mjs`、`dist/`。`npm run stage` 会把它连同运行期依赖整理成可安装的 `artifact/`。

## 消息模型

每条消息归一化为：

| 字段 | 说明 |
| --- | --- |
| `id` | 内容摘要，用于去重 |
| `seq` | 入库顺序号，游标分页使用；只对真正入库的消息递增 |
| `category` | 见下表 |
| `source` | `chat` / `console` / `event` |
| `server` | 服务器名；缺失时为 `unknown` |
| `at` | RFC3339 UTC |
| `from` | 发送者或玩家名；无则为 `null`（op 输出为 `""`） |
| `text` | 清理颜色码/控制字符后的文本；入库截断到 1000 字符 |
| `raw` | 原始聊天文本或控制台整行；入库截断到 4000 字符；生命周期事件为 `null` |
| `rule` | 命中的规则 id，便于观测与调试 |

`server`、`from`、`rule` 各自最多保留 64 字符。去重使用截断前的原文，截断只影响存储与分页输出。

类别（`category`）：

| 类别 | 来源示例 |
| --- | --- |
| `chat` | 玩家聊天（`chat:message`） |
| `command` | 聊天以 `/` 开头，或 `Steve issued server command: ...` |
| `join` / `leave` | `player:joined` / `player:left` |
| `system` | 服务器状态行（启动、保存、完成加载等）与 INFO 兜底 |
| `warning` | 控制台 WARN / WARNING |
| `error` | ERROR / FATAL / SEVERE，以及异常栈 |
| `death` | 死亡消息（原版常见句式） |
| `advancement` | 进度、挑战、目标 |
| `other` | 未归类的控制台行（如 DEBUG） |

分类顺序：先处理控制台里的聊天投影（`<name> text`，含离线模式的 `[Not Secure]` 前缀）与玩家加入 / 离开，再按日志级别、异常栈、命令、进度、死亡、系统行、INFO 兜底、`other` 判定。

**为什么聊天要跨源去重**：在线模式下宿主会把同一条聊天同时投递为 `chat:message` 与 `console:line`；离线模式（`online-mode=false`）下宿主只留控制台行（带 `[Not Secure]`），结构化事件可能不来。因此控制台聊天行**不再直接丢弃**，而是按 `(发言人, 文本)` 与结构化事件做 3 秒跨源去重：两种投递顺序下都只保留一条，计入 `status.duplicates`。玩家自己连发两句相同内容不会被误判（同源不参与去重）。

`console:line` 噪音很大（繁忙服务器每秒数百行）。插件必须静态订阅，运行期无法退订；因此**控制台行默认不转发**（`consoleForward=false`，仍采集入库），需要把服务器 `say`、日志同步到平台时再显式打开。`forwardCategories` 默认也只保留玩家聊天 `chat`。

## 配置

配置由 `src/config.ts` 的 zod schema 校验，宿主下发的非法值会在握手阶段以配置错误退出（退出码 3）。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `platforms` | `["log"]` | 启用的适配器 id；空数组表示只采集 |
| `forwardCategories` | `["chat"]` | 转发到平台的类别；默认只转发玩家聊天。需要加入/离开、死亡、进度、系统行时再显式追加；仍会采集入库 |
| `consoleForward` | `false` | 默认不转发控制台/日志行（`source=console`）；只采集入库。需要把服务器 `say`、日志同步到平台时再打开 |
| `storeSize` | `200` | 环形缓存条数（10–5000） |
| `queueCapacity` | `256` | 单平台出站与全局入站队列的积压上限（8–4096），超出丢最旧 |
| `inbound` | `true` | 是否允许平台消息注入游戏；关闭后 QQ 仍可出站 |
| `inboundServer` | 自动 | 入站默认服务器；省略时选运行中的服务器 |
| `inboundMaxLength` | `200` | 单条入站文本上限（32–512），超长截断 |
| `injectMode` | `"tellraw"` | 平台消息注入游戏的方式：`tellraw` 游戏里只有 `[QQ]` 标签但不写服务器日志；`say` 会写入 `logs/latest.log`，但游戏内多出 `[Server]` 前缀（原版只有 `say`/`me` 这类服务器广播会进日志） |
| `log.prefix` | `"chat-bridge"` | 日志平台前缀 |
| `log.level` | `"info"` | `info` / `debug` |
| `qq.appId` | 无（必填） | QQ 开放平台机器人 AppID |
| `qq.clientSecret` | 无（必填） | 密钥；用于换取 `access_token`，界面遮蔽、读取打码 |
| `qq.sandbox` | `false` | 为 `true` 时用 `sandbox.api.sgroup.qq.com` |
| `qq.apiBase` | 按 sandbox 推导 | OpenAPI 基址，一般无需修改 |
| `qq.tokenUrl` | 官方凭证地址 | `https://bots.qq.com/app/getAppAccessToken` |
| `qq.intents` | `["group_and_c2c"]` | 事件订阅位；可选 `guilds` / `direct_message` / `interaction` 等 |
| `qq.markdown` | `false` | 为 `true` 用 `msg_type=2` 发 Markdown；默认纯文本避免符号被渲染。群/私聊镜像的图片始终优先用 Markdown 图文，与此开关无关 |
| `qq.groups` | `[]` | 出站 `group_openid`；同时是入站白名单 |
| `qq.privateUsers` | `[]` | 出站私聊 `user_openid`（官方 API 用 openid，不是 QQ 号） |
| `qq.allowedUsers` | `[]` | 非空时只允许这些 openid 进入游戏 |
| `qq.categories` | 沿用全局 | QQ 出站类别过滤 |
| `qq.inbound` | `true` | 是否把 QQ 消息注入游戏 |
| `qq.allowPrivate` | `false` | 是否接收私聊（默认关闭，避免陌生人打扰） |
| `qq.syncChannels` | `true` | 群聊与私聊互相同步：群里收到的消息也会发到私聊目标，私聊收到的也会发到群目标；只影响 QQ 内部会话，不影响游戏注入；来源会话不重复发送 |
| `qq.forwardMedia` | `true` | 群/私聊互转时用一条消息转发图片（文字在前、图片在后）。QQ 表情统一转为 `[表情]` |
| `qq.mediaMode` | `"markdown"` | `markdown`：单条 Markdown 图文，图片先转存平台素材库换成 `qqbot-media://` 引用并带 `#宽px #高px`（QQ 客户端不带宽高只显示 `[图片]`），普通图片最长边 480px、纯表情贴纸 160px；`rich`：单条富媒体（图片在上、文字在下）。Markdown 上传或发送失败会自动退回 `rich` |
| `qq.label` | `"QQ"` | 游戏内显示为 `[QQ] 昵称: 消息` |
| `qq.server` | 全局 | 该适配器的入站默认服务器 |
| `qq.maxLength` | `1500` | 单条出站上限，超出按此分片（官方上限约 4000） |
| `qq.passiveReply` | `true` | 优先用最近入站消息的 `msg_id` 被动回复 |
| `qq.passiveLimit` | `4` | 同一消息最多被动回复次数（群聊 5、管理员 50） |
| `qq.passiveTtlMs` | `3300000` | 被动回复时效，官方窗口 60 分钟 |
| `qq.sendIntervalMs` | `500` | 两次 OpenAPI 调用的最小间隔，温柔限流 |
| `qq.apiTimeoutMs` | `15000` | 单次 HTTP 调用超时 |
| `qq.reconnectMinMs` / `reconnectMaxMs` | `1000` / `60000` | 重连退避范围（带抖动） |
| `qq.reconnectMaxAttempts` | `0` | 最大重连次数，0 表示无限重试 |

平台专属配置放在与适配器 id 同名的字段下。QQ 示例：

```json
{
  "platforms": ["qq"],
  "forwardCategories": ["chat", "command", "join", "leave", "death", "advancement"],
  "inbound": true,
  "inboundServer": "survival",
  "qq": {
    "appId": "102000001",
    "clientSecret": "your-client-secret",
    "groups": ["GROUP_OPENID"],
    "allowedUsers": [],
    "allowPrivate": false,
    "syncChannels": true,
    "forwardMedia": true,
    "mediaMode": "markdown",
    "label": "QQ",
    "server": "survival"
  }
}
```

**密钥与持久化**：`qq.clientSecret` 用 SDK 的 `secretInput` 标记，descriptor 里是
`x-mcsup-secret: true`。宿主负责按插件隔离、加密持久化（`secrets.json`），
管理端读取时返回 `***`，插件握手时收到明文才能工作；插件自身不落盘任何密钥，
日志与 `status` 也不会输出 `clientSecret` 或 `access_token`。

**写入顺序（实测）**：`mcsup plugin config set` 每次都会对**合并后的完整配置**做
schema 校验，而 schema 的默认值里已经包含 `qq` 对象。`qq.appId` / `qq.clientSecret`
是必填项，所以必须先写完整 `qq` 块，再写 `platforms` 等顶层键；顺序反了会得到
`config.qq.appId: required field is missing`，且该次写入不会生效。

```powershell
# 先写 qq 整块（内部双引号写成 \"，见文首安装说明）
mcsup plugin config set chat-bridge qq '{\"appId\":\"...\",\"clientSecret\":\"...\"}'
# 再写其余顶层键
mcsup plugin config set chat-bridge platforms '[\"qq\",\"log\"]'
```

**能力声明**：`events`、`console:read`、`console:write`、`server:read`。
`console:write` 属高风险能力，必须由用户显式授予。未授予时插件仍会正常出站，
但 QQ → 游戏方向降级为仅计数并在日志与 `status.inbound.failed` 中体现，不会假装成功。

配置热更新的语义：

- 只改 `forwardCategories`、`consoleForward`、`storeSize`：立即生效，不重建平台。
- 平台列表、平台配置或 `queueCapacity` 变化：先启动新分发器，成功后停旧平台；新平台启动失败会抛错，宿主回滚配置，旧平台继续服务。

## Ops

### `messages`

最近的归一化消息，最新在前，支持类别 / 来源 / 服务器过滤与游标分页。

输入：`category?`、`source?`、`server?`、`cursor?`、`limit?`（默认 50，最大 200）。

输出：`{ items: [...], next?: string }`。`message` 项不含 `raw`，`from` 为空时是空字符串。

```powershell
# 宿主侧调用示例（伪代码）
messages { "limit": 20 }
messages { "category": "warning", "limit": 20, "cursor": "128" }
messages { "source": "console", "limit": 20 }
messages { "server": "survival", "limit": 20 }
```

分页游标是上一页最后一条的 `seq`；返回 `next` 时把它放进下一次请求的 `cursor`。非法游标按“从最新开始”处理，非法 `limit` 回退到 50。

### `status`

运行统计：

| 字段 | 说明 |
| --- | --- |
| `started` | 桥是否运行 |
| `uptimeSecs` | 运行秒数 |
| `accepted` | 入库成功条数 |
| `duplicates` | 内容摘要重复被丢弃条数 |
| `skipped` | 空行、结构化重复投影、未知事件等 |
| `filtered` | 已入库但按配置不转发的条数 |
| `suppressed` | 注入游戏后又被宿主回显、被回声抑制的条数 |
| `stored` | 当前缓存条数 |
| `categories` | 各类别累计计数（不受环形淘汰影响） |
| `platforms` | 每个平台的 `queued` / `delivered` / `failed` / `dropped` |
| `inbound` | `received` / `delivered` / `dropped` / `duplicates` / `failed` |

## QQ 机器人对接

本项目对接的是 **QQ 开放平台官方机器人 API v2**（`bot.q.qq.com`），不是 OneBot 社区实现。

### 前置条件

1. 在 [QQ 开放平台](https://q.qq.com/open) 创建机器人，取得 **AppID** 与 **ClientSecret**。
2. 在机器人管理端配置事件订阅：群聊/单聊消息；如需频道能力，另开 `guilds` 等 intents。
3. 把机器人拉进目标群，并取得群的 `group_openid` 填入 `qq.groups`；私聊对象用 `user_openid` 填入 `qq.privateUsers`。
4. 官方机器人在群里**默认只能收到 @ 它的消息**。若要在群里看到全部聊天，需在开放平台开通“接收所有消息”（适配器会自动处理 `GROUP_MESSAGE_CREATE`）；注意该权限可能影响 @ 消息的投递方式。

### 协议链路

- **访问凭证**：`POST https://bots.qq.com/app/getAppAccessToken`，body `{appId, clientSecret}`，返回 `{access_token, expires_in}`；随后所有 OpenAPI 请求带 `Authorization: QQBot <access_token>`。
- **事件**：`GET {apiBase}/gateway` 取 wss 地址，连上后等待 op 10 Hello，再发 op 2 Identify（`token: "QQBot <token>"` + `intents` + `shard`）。断线优先 op 6 Resume；会话失效才重新 Identify。
- **发送**：`POST /v2/groups/{group_openid}/messages` 或 `/v2/users/{user_openid}/messages`，`msg_type=0` 纯文本、`2` Markdown。
- **被动回复**：记录每个会话最近一条入站消息的 `msg_id`，出站时带 `msg_id + 递增 msg_seq`。额度用尽或窗口过期才降级为主动消息。

### 消息格式

| 方向 | 格式 | 说明 |
| --- | --- | --- |
| 游戏 → QQ | `[玩家名]:消息` | 玩家聊天严格使用此格式，例如 `[Steve]:你好` |
| 游戏 → QQ（非聊天） | `[加入] Alex: Alex 加入了游戏` | 用中文类别标签，避免歧义 |
| QQ → 游戏 | `[QQ] 昵称: 消息` | 通过 `injectMode` 注入（默认 `tellraw @a`，游戏内只有这一个标签）；可选 `qq.server` / `inboundServer` |

出站只发送纯文本（或显式开启的 Markdown），不拼任何平台标记；入站会把 `<@openid>` 映射成昵称、去掉机器人自身的 @，附件转为 `[图片]` / `[语音] ASR` / `[文件: 名称]` 占位文本。

### 可靠性行为

- **鉴权**：`clientSecret` 只用于换 token，且只发给官方凭证地址；OpenAPI 用 `Authorization: QQBot`。
- **重连**：指数退避 + 抖动；关闭码语义按官方协议处理——`4004` 清 token、`4006/4007/4900~4913` 重建会话、`4008` 限流等待 60 秒、`4013/4014/4914/4915` 等致命错误停止重连。
- **心跳**：按 Hello 下发的 `heartbeat_interval` 发送 op 1，并带最新 `s`。
- **限流**：两次 OpenAPI 调用之间至少 `sendIntervalMs`；429/5xx 退避重试；`msg_id+msg_seq` 重复时换 seq 重发。
- **去重**：入站按消息 id 记忆最近 1000 条，桥内核再按 `platform:id` 去重 10 分钟；重连后不会重复注入。
- **过滤**：只接收 `qq.groups` 内的群与 `qq.privateUsers` 内的私聊；`allowedUsers` 可进一步收窄发言人；机器人自己的消息不会被回灌。
- **群/私聊互通**：`qq.syncChannels`（默认 `true`）把一条 QQ 消息再发到除来源会话之外的所有目标：群里发的进私聊、私聊发的进群。消息带 `[群]` / `[私聊]` 前缀，来源会话跳过所以不会重复；机器人自己发的消息不触发入站事件，不会回环。图片（`qq.forwardMedia=true`）用**一条消息**转发：`qq.mediaMode=markdown`（默认）先转存平台素材库，再发单条 Markdown 图文 `[群] 昵称: 文字 ![图片 #宽px #高px](qqbot-media://...)`，文字在前、图片在后，手机 QQ 也能显示（实验确认：Markdown 图片不带宽高时手机和电脑都只显示 `[图片]`）。普通图片按最长边 480px 等比缩小，纯表情贴纸按 160px 缩小，避免表情被放大；`rich` 发单条富媒体（图片在上、文字在下）。素材引用保留 90 天滑动有效，配额满 100 张时自动淘汰最旧的一半。Markdown 转存或发送失败会自动退回 `rich`。纯表情消息会把贴纸并进同一条消息，不再额外补一条 `[表情]`；无贴纸可转发时显示 `[表情]` 文本。
- **注入安全**：`tellraw` 用 JSON 组件转义、`say` 用单行文本；两种方式都过滤控制字符，并在桥内核按注入文本做 60 秒回声抑制，避免「游戏 → QQ → 游戏」自激。注入成功时会在插件日志写一行 `[qq] 注入 <server>：[QQ] 昵称: 消息`，便于核对。
- **注入方式与日志**：原版 Minecraft 只有 `say`/`me` 这类服务器广播会写进 `logs/latest.log`。因此「游戏内只有 `[QQ]` 标签」与「QQ 消息出现在服务器日志」不可兼得：默认 `injectMode="tellraw"` 保证单标签，但服务器日志里没有；改成 `injectMode="say"` 则日志可查，但游戏内会显示 `[Server] [QQ] ...`。

### 官方频控（不可绕过）

- 主动消息：群 bot 维度 60 条/分钟、单关系 20 条/分钟、每群 1000 条/天；单聊 20 条/分钟、1000 条/天/用户。
- 被动回复：单聊 60 分钟内 4 次、群聊 5 次、群管理员 50 次，且必须带 60 分钟内的 `msg_id`。

因此适配器默认优先被动回复，并把 `sendIntervalMs` 当保护值；高频服务器建议只转发 `chat` / `join` / `leave` / `death` 等关键类别。

### 本地验证

没有真实 QQ 凭证时，`npm run test:real` 会启动一个真实的 **HTTP OpenAPI + WebSocket Gateway** 假服务端，并验证：

- `AppID/ClientSecret` 换 token，Identify 的 `token` 为 `QQBot <access_token>`、默认 intents 为 `group_and_c2c`；
- 游戏事件 → `POST /v2/groups/<openid>/messages`，`msg_type=0`、文本为 `[Steve]:有人吗`、带 `msg_seq`；
- QQ 群消息事件 → 宿主 `console:write/send_line`，命令为
  `tellraw @a {"text":"[QQ] 小A: 来自QQ"}`；
- 非白名单群与重复消息 id 不会二次注入；
- `status.inbound` 计数正确，进程最终以退出码 0 结束。

真实联调只需把 `qq.appId` / `qq.clientSecret` / `qq.groups` 换成机器人的实际配置。

## 扩展一个新的聊天平台

只需要三步，内核与 op 层都不用改。以下以 `telegram` 为例（QQ 已内置，可直接参照 `src/platforms/qq.ts`）。

### 1. 实现 `PlatformFactory`

```ts
// src/platforms/telegram.ts
import type { NormalizedMessage } from "../core/types.js";
import type { ChatPlatform, PlatformFactory } from "./types.js";

export const telegramPlatformFactory: PlatformFactory = {
  id: "telegram",
  title: "Telegram",
  description: "Telegram Bot API",
  create({ log, settings }) {
    const config = (settings ?? {}) as { token?: string; chatId?: string };
    if (config.token === undefined || config.chatId === undefined) {
      // 抛错会让启动失败，宿主按配置错误处理并回滚
      throw new Error("telegram.token 与 telegram.chatId 必填");
    }
    return {
      id: "telegram",
      title: "Telegram",
      async start(ctx) {
        // 建立连接；ctx.game 用于 QQ/Telegram → 游戏，ctx.inbound 交给内核
        log.info(`[telegram] 已启动`);
      },
      async deliver(message: NormalizedMessage) {
        const text =
          message.category === "chat" && message.from !== null
            ? `[${message.from}]:${message.text}`
            : message.text;
        log.debug(`[telegram] ${text}`);
      },
      async stop(reason) {
        log.debug(`[telegram] 断开：${reason}`);
      },
    } satisfies ChatPlatform;
  },
};
```

### 2. 注册

```ts
// src/platforms/index.ts
import { telegramPlatformFactory } from "./telegram.js";

export const BUILTIN_PLATFORMS: readonly PlatformFactory[] = [
  logPlatformFactory,
  nullPlatformFactory,
  qqPlatformFactory,
  telegramPlatformFactory,
];
```

### 3. 加配置字段

```ts
// src/config.ts，configSchema 内
telegram: s.optional(
  s.object(
    {
      token: secretInput(s.string({ label: "Bot Token", max: 256 })),
      chatId: s.string({ label: "默认会话", max: 64 }),
    },
    { label: "Telegram" },
  ),
),
```

之后配置 `"platforms": ["telegram"]` 就会实例化；`config.telegram` 这个片段会原样传给工厂的 `settings`。

### 适配器约定

- `deliver` 由内核串行调用，不会并发；慢只影响自己的队列。
- 队列满时内核丢最旧消息并计入 `dropped`，适配器不需要处理背压。
- `deliver` 抛错只计入 `failed` 并记日志，不会打断消费者，也不影响其他平台。
- 连接、重连、限流、鉴权都由适配器自己负责；内核只提供 `AbortSignal` 与 `stop(reason)`。
- **入站**：适配器收到外部消息后调用 `ctx.inbound({ platform, channel, author, text, messageId? })`；
  内核统一做去重、长度限制、排队、回声抑制，并通过 `ctx.game` 注入游戏。
  适配器不需要知道服务器选择、注入命令或队列细节。
- **降级**：`ctx.game` 在未授予 `console:write` 时为 `undefined`；适配器只负责上报消息，
  内核会记录失败计数，不要求适配器自己判断权限。
- 平台 id 必须匹配 `^[a-z][a-z0-9-]{0,31}$`，且与 `create()` 返回实例的 `id` 一致。

## 运行保证与边界

- **不持久化消息**：只保留最近 `storeSize` 条；进程重启即丢失。**插件配置与密钥由宿主持久化并按插件隔离**，聊天桥不落盘。
- **内存有界**：分发队列是固定大小环形缓冲（丢最旧 O(1)，慢消费者不会让数组增长）；入站队列同样有界；入库文本/原始行分别截断到 1000/4000 字符，超长控制台行不会撑爆缓存或结果帧。
- **事件是触发语义**：宿主不补发，断线期间的消息不会回填。
- **单平台保序**：同一平台内严格按入库顺序投递；入站注入也串行，保证游戏内顺序稳定。
- **平台间隔离**：一个平台慢或抛错不影响采集与其他平台。
- **停止**：先排空队列，再 abort 信号并调用 `stop`；排空与 `stop` 各有默认 3 秒上限，超时记 warn。
- **去重**：同内容摘要只入库一次；入站按平台消息 id 去重并保留 10 分钟；注入文本回流会被回声抑制。
- **配置回滚**：平台配置变更失败时保留旧平台，不会出现“两边都没有”的空窗。
- **能力降级**：未授予 `console:write` 时出站正常、入站计数为失败，不伪造成功。

## 测试

```powershell
npm run typecheck   # 源码 + 测试的类型检查
npm test            # 单测 + MockHost 全链路（无 socket）
npm run build       # 生成 build/manifest.json、descriptor.json、启动器
npm run test:real   # 真实进程 + 真实 TCP 端点
```

单测覆盖：

- 分类规则（聊天、颜色码、控制台级别、异常栈、命令、死亡、进度、系统行、空行）
- 环形缓存、去重、游标分页、容量淘汰、过滤、超长文本截断、持续大量写入
- 固定环队列、单平台保序、平台隔离、持续溢出丢最旧、平台启动失败回滚、停止排空
- 桥的启动/停止/配置热更新/启动前配置/平台切换/过滤配置不重建/未知平台回滚
- 配置默认值、去重、平台配置切片、QQ 配置片段与入站默认值、注册表重复与非法 id
- 事件负载校验、非法时间回退、缺失服务器名兜底
- **入站**：格式化注入、`inboundServer`、去重、截断、全局关闭、无 `console:write` 降级、回声抑制
- **QQ**：配置校验与默认值、`[玩家名]:消息` 格式、官方入站事件归一（@ 映射/附件/引用）、
  假 Gateway 上的 Identify、被动回复 `msg_id+msg_seq`、白名单、去重、Markdown、401 刷新 token、分片与关闭码处理
- MockHost：握手声明、事件 → 分类 → 入库 → 查询、配置热更新、非法配置回滚、未知平台退出码

`test:real` 不是纯单元测试：它会启动构建产物 `build/bin/run.cmd`（Windows）或 `run.sh`，作为真实子进程连接本机 TCP 假宿主，走完整线上协议；同时启动一个真实的 QQ 官方协议假服务端（HTTP OpenAPI + WebSocket Gateway）：

1. 插件发 `hello`，断言 `plugin_id`、四项能力（含 `console:write` / `server:read`）与订阅
2. 宿主回 `welcome`，下发三平台配置（`log` + `null` + `qq`）与限额；QQ 指向假 OpenAPI
3. QQ 适配器用 AppID/ClientSecret 换 token，完成 Identify（`QQBot <token>` + `group_and_c2c`）
4. 投递 14 条事件（聊天、命令、加入/离开、控制台警告/错误/系统行、死亡、进度、服务器启动/就绪/崩溃）
5. 调用 `messages` 验证游标分页、类别过滤、source / server 过滤、8 种类别与去重/去色
6. 调用 `status` 验证采集、跳过、分类与三个平台的投递计数
7. 断言 OpenAPI 收到 `POST /v2/groups/123456/messages`，`msg_type=0`、文本为 `[Steve]:有人吗`
8. 推送 `GROUP_AT_MESSAGE_CREATE`，断言宿主收到 `console:write/send_line`
   `tellraw @a {"text":"[QQ] 小A: 来自QQ"}`；非白名单群与重复消息 id 不注入
9. 下发 `config` 验证热更新只影响转发，三平台计数一致
10. `ping` / `pong`，检查日志平台的真实 stderr 输出
11. `shutdown`，断言退出码 0

说明：本机没有可启动的 Minecraft 服务器与真实 MCSUP 宿主，也没有真实 QQ 凭证，所以对端是“假宿主 + 假 QQ 开放平台”，但它们跑的是真实帧协议、真实进程、真实 socket、真实 HTTP 与真实 WebSocket 握手；插件侧的分类、分发、QQ 协议与入站注入逻辑没有被 mock。

Windows 启动器经 `cmd.exe /d /s /c` 调用，并使用 `windowsVerbatimArguments`：Node 默认会给含空格的参数加引号并把内部引号转义成 `\"`，而 `cmd.exe` 不认反斜杠转义，会直接报“不是内部或外部命令”。测试脚本里对“等待连接”设了 10 秒超时，启动失败时会打印插件 stderr 而不是无限挂起。

## 调研

`docs/chat-platform-research.md` 对比了 OpenClaw 与 Hermes Agent 接入聊天平台的核心实现（契约、生命周期、监管/重连、入站归一化、出站与限流），并映射到本项目的 `ChatPlatform`：

- 两套实现都把「连接」当作长驻任务（`startAccount` / `connect`），监管与重连放在框架层。
- 我们当前把监管下放给适配器，只保留 `start / deliver / stop`；接真实平台前建议先补「送达结果 + 平台健康状态」。
- 文档同时记录了代码获取状态：OpenClaw 为本地部分检出，Hermes 为 GitHub API 核心文件快照。

## 已知限制 / 下一步

- 已内置 QQ 官方机器人（API v2）；Telegram、Discord 等平台可按同一契约继续添加。
- 入站只处理文本与常见消息段（图片/语音/文件转为占位文本）；不支持图片内容落盘、回复链与话题线程。
- QQ 官方机器人在群聊默认只能收到 @ 消息；全量群消息需在开放平台开通权限，并受官方主动消息频控约束。
- 与真实 QQ 端联调需要用户提供 AppID/ClientSecret 与机器人环境；仓库内用真实 HTTP + WebSocket 假服务端验证协议链路。
- 插件静态订阅 `console:line`，无法运行期退订；高噪音环境靠 `consoleForward` / `forwardCategories` 控制转发。
- 内存环形缓存，不落盘；需要历史时应由宿主查询或后续接持久化。
- 尚未与真实 MCSUP 宿主 + Minecraft 服务器联调；真实宿主联调放在下一阶段。