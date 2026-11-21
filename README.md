# mcsup-chat-bridge

MCSUP 聊天桥插件：订阅 Minecraft 服务器的聊天、控制台与生命周期事件，归一化为统一消息模型，分类后分发到可插拔的聊天平台。

当前阶段只实现「采集 → 归一化 → 分类 → 入库 → 可插拔分发」的基础架构，**没有对接任何真实聊天平台**。内置的 `log` / `null` 平台只用于验证链路。

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

依赖 `mcsup-plugin@0.1.0`，通过 `file:../mcsup/sdks/typescript` 引用同级的 SDK 仓库。`scripts/ensure-sdk.mjs` 会比较 SDK 源码与 `dist/index.js` 的 mtime：缺失或过期时用 SDK 自带的 tsc 重新构建，已是最新时零开销。

## 目录结构

```
src/
  core/                     平台无关内核
    types.ts                消息模型、类别、来源、查询类型
    ids.ts                  内容摘要 id（sha256 base64url，16 字符）
    classify.ts             聊天 / 控制台行 / 生命周期 / 玩家的分类规则
    store.ts                环形缓存（头指针淘汰 + 文本截断）、去重、seq 游标分页
    dispatcher.ts           每平台固定大小环形队列 + 串行消费者 + 故障隔离
    bridge.ts               内核编排：启动、配置热更新、采集、停止
  platforms/                可插拔平台层
    types.ts                ChatPlatform / PlatformFactory 契约
    registry.ts             注册表（id 校验、实例化）
    log.ts                  占位平台：写到插件日志
    null.ts                 空平台：只采集、不投递
    index.ts                内置平台注册入口
  events/normalize.ts       宿主事件校验（zod）与归一化
  config.ts                 配置 schema、resolveConfig、平台配置切片
  ops/index.ts              messages（table + 分页）与 status（detail）
  index.ts                  definePlugin 接线、订阅声明、会话级桥实例
scripts/
  ensure-sdk.mjs            SDK 缺失或过期（mtime）时自动构建
  real-host-check.mjs       真实子进程 + 真实 TCP 假宿主全链路测试
test/                       分类、存储、分发、桥、配置、事件、MockHost 全链路
```

构建产物在 `build/`：`manifest.json`、`descriptor.json`、`bin/run.cmd|run.sh`、`bin/entry.mjs`、`dist/`。

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

分类顺序：先跳过与结构化事件重复的控制台投影（聊天 `<name> text`、`joined the game`、`left the game`），再按日志级别、异常栈、命令、进度、死亡、系统行、INFO 兜底、`other` 判定。

**为什么跳过控制台重复行**：宿主会把同一条聊天同时投影成 `chat:message` 与 `console:line`。控制台层丢弃这些行，避免同一条消息入库两次；跳过会计入 `status.skipped`，但不会入库。

`console:line` 噪音很大（繁忙服务器每秒数百行）。插件必须静态订阅，运行期无法退订；需要压低噪音时用 `consoleForward=false`（仍采集入库，不转发）或 `forwardCategories` 只保留需要的类别。

## 配置

配置由 `src/config.ts` 的 zod schema 校验，宿主下发的非法值会在握手阶段以配置错误退出（退出码 3）。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `platforms` | `["log"]` | 启用的适配器 id；空数组表示只采集 |
| `forwardCategories` | 全部类别 | 转发到平台的类别；仍会采集入库 |
| `consoleForward` | `true` | 为 `false` 时控制台消息不转发 |
| `storeSize` | `200` | 环形缓存条数（10–5000） |
| `queueCapacity` | `256` | 单平台积压上限（8–4096），超出丢最旧 |
| `log.prefix` | `"chat-bridge"` | 日志平台前缀 |
| `log.level` | `"info"` | `info` / `debug` |

平台专属配置放在与适配器 id 同名的字段下。示例：

```json
{
  "platforms": ["log"],
  "forwardCategories": ["chat", "command", "join", "leave", "death", "advancement"],
  "consoleForward": true,
  "storeSize": 200,
  "queueCapacity": 256,
  "log": { "prefix": "bridge", "level": "info" }
}
```

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
| `stored` | 当前缓存条数 |
| `categories` | 各类别累计计数（不受环形淘汰影响） |
| `platforms` | 每个平台的 `queued` / `delivered` / `failed` / `dropped` |

## 扩展一个新的聊天平台

只需要三步，内核与 op 层都不用改。

### 1. 实现 `PlatformFactory`

```ts
// src/platforms/qq.ts
import type { NormalizedMessage } from "../core/types.js";
import type { ChatPlatform, PlatformFactory } from "./types.js";

export const qqPlatformFactory: PlatformFactory = {
  id: "qq",
  title: "QQ 群",
  description: "把消息发到 QQ 群（占位示例）",
  create({ log, settings }) {
    const config = (settings ?? {}) as { endpoint?: string; groupId?: string };
    if (config.endpoint === undefined || config.groupId === undefined) {
      // 抛错会让启动失败，宿主按配置错误处理
      throw new Error("qq.endpoint 与 qq.groupId 必填");
    }
    return {
      id: "qq",
      title: "QQ 群",
      async start(ctx) {
        // 建立连接；ctx.signal 在桥停止时 abort
        log.info(`[qq] 已连接 ${config.endpoint}`);
      },
      async deliver(message: NormalizedMessage) {
        // 内核保证同一平台串行调用，这里不用自己排队
        log.debug(`[qq] ${message.server} ${message.text}`);
      },
      async stop(reason) {
        log.debug(`[qq] 断开：${reason}`);
      },
    } satisfies ChatPlatform;
  },
};
```

### 2. 注册

```ts
// src/platforms/index.ts
import { qqPlatformFactory } from "./qq.js";

export const BUILTIN_PLATFORMS: readonly PlatformFactory[] = [
  logPlatformFactory,
  nullPlatformFactory,
  qqPlatformFactory,
];
```

### 3. 加配置字段

```ts
// src/config.ts，configSchema 内
qq: s.optional(
  s.object(
    {
      endpoint: s.string({ label: "WebSocket 地址" }),
      groupId: s.string({ label: "群号" }),
    },
    { label: "QQ 群" },
  ),
),
```

之后配置 `"platforms": ["qq"]` 就会实例化；`config.qq` 这个片段会原样传给工厂的 `settings`。

### 适配器约定

- `deliver` 由内核串行调用，不会并发；慢只影响自己的队列。
- 队列满时内核丢最旧消息并计入 `dropped`，适配器不需要处理背压。
- `deliver` 抛错只计入 `failed` 并记日志，不会打断消费者，也不影响其他平台。
- 连接、重连、限流、鉴权都由适配器自己负责；内核只提供 `AbortSignal` 与 `stop(reason)`。
- 平台 id 必须匹配 `^[a-z][a-z0-9-]{0,31}$`，且与 `create()` 返回实例的 `id` 一致。

## 运行保证与边界

- **不持久化**：只保留最近 `storeSize` 条；进程重启即丢失。
- **内存有界**：分发队列是固定大小环形缓冲（丢最旧 O(1)，慢消费者不会让数组增长）；入库文本/原始行分别截断到 1000/4000 字符，超长控制台行不会撑爆缓存或结果帧。
- **事件是触发语义**：宿主不补发，断线期间的消息不会回填。
- **单平台保序**：同一平台内严格按入库顺序投递。
- **平台间隔离**：一个平台慢或抛错不影响采集与其他平台。
- **停止**：先排空队列，再 abort 信号并调用 `stop`；排空与 `stop` 各有默认 3 秒上限，超时记 warn。
- **去重**：同内容摘要只入库一次；跨服务器重启的同内容事件也会被视为重复。
- **配置回滚**：平台配置变更失败时保留旧平台，不会出现“两边都没有”的空窗。

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
- 配置默认值、去重、平台配置切片、注册表重复与非法 id
- 事件负载校验、非法时间回退、缺失服务器名兜底
- MockHost：握手声明、事件 → 分类 → 入库 → 查询、配置热更新、非法配置回滚、未知平台退出码

`test:real` 不是纯单元测试：它会启动构建产物 `build/bin/run.cmd`（Windows）或 `run.sh`，作为真实子进程连接本机 TCP 假宿主，走完整线上协议：

1. 插件发 `hello`，断言 `plugin_id`、能力、订阅
2. 宿主回 `welcome`，下发双平台配置（`log` + `null`）与限额
3. 投递 14 条事件（聊天、命令、加入/离开、控制台警告/错误/系统行、死亡、进度、服务器启动/就绪/崩溃）
4. 调用 `messages` 验证游标分页、类别过滤、source / server 过滤、8 种类别与去重/去色
5. 调用 `status` 验证采集、跳过、分类与两个平台的投递计数
6. 下发 `config` 验证热更新只影响转发，双平台计数一致
7. `ping` / `pong`，检查日志平台的真实 stderr 输出
8. `shutdown`，断言退出码 0

说明：本机没有可启动的 Minecraft 服务器与真实 MCSUP 宿主，所以对端是“假宿主”，但它跑的是真实帧协议、真实进程、真实 socket；插件侧的分类与分发逻辑没有被 mock。

Windows 启动器经 `cmd.exe /d /s /c` 调用，并使用 `windowsVerbatimArguments`：Node 默认会给含空格的参数加引号并把内部引号转义成 `\"`，而 `cmd.exe` 不认反斜杠转义，会直接报“不是内部或外部命令”。测试脚本里对“等待连接”设了 10 秒超时，启动失败时会打印插件 stderr 而不是无限挂起。

## 调研

`docs/chat-platform-research.md` 对比了 OpenClaw 与 Hermes Agent 接入聊天平台的核心实现（契约、生命周期、监管/重连、入站归一化、出站与限流），并映射到本项目的 `ChatPlatform`：

- 两套实现都把「连接」当作长驻任务（`startAccount` / `connect`），监管与重连放在框架层。
- 我们当前把监管下放给适配器，只保留 `start / deliver / stop`；接真实平台前建议先补「送达结果 + 平台健康状态」。
- 文档同时记录了代码获取状态：OpenClaw 为本地部分检出，Hermes 为 GitHub API 核心文件快照。

## 已知限制 / 下一步

- 未实现 QQ Bot、Telegram、Discord 等真实适配器；本阶段只保留契约与占位实现。
- 未实现平台 → Minecraft 的反向消息（本阶段只做采集与分发）。
- 插件静态订阅 `console:line`，无法运行期退订；高噪音环境靠 `consoleForward` / `forwardCategories` 控制转发。
- 内存环形缓存，不落盘；需要历史时应由宿主查询或后续接持久化。
- 尚未与真实 MCSUP 宿主 + Minecraft 服务器联调；真实宿主联调放在下一阶段。