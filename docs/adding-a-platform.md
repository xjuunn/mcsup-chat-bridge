# 新增聊天平台适配器

聊天桥的平台是可插拔点：新增平台只动「配置 + 一个新文件 + 注册一行 + 测试」，
桥内核（`core/`）、op 层（`ops/`）与入口（`src/index.ts`）都不需要改。

本文是实施清单，末尾附最小骨架。

## 1. 三条链路与生命周期

适配器只实现 `ChatPlatform`（`src/platform-kit/types.ts`）。目录职责固定：
`src/platform-kit/` 放契约与公共件，`src/platforms/` 只放适配器，每个文件一个平台。

| 方法 | 方向 | 谁调用 | 必须做什么 |
| --- | --- | --- | --- |
| `start(ctx)` | 建连 | 内核 | 建立连接、恢复持久化状态、订阅 `ctx.signal`；`signal` 已 abort 时直接返回 |
| `deliver(message)` | 游戏 → 平台 | 内核串行 | 格式化成平台文本并入自己的出站队列 |
| `relay(message)` | 其它平台 → 本平台 | 内核串行 | 可选；不实现就收不到跨平台转发 |
| `stop(reason)` | 停止 | 内核 | 幂等；清空队列，结束循环 |

`ctx.inbound(...)` 是入站入口（平台 → 游戏）。适配器只把原生事件翻译成
`PlatformInboundMessage`，**不要**在适配器里判断权限、服务器、队列或注入方式——
这些都属于内核。

## 2. 文件清单

```
src/config.ts                # 配置 schema + 安装向导字段
src/platforms/<id>.ts        # 适配器（工厂 + parse<Id>Settings），只放平台实现
src/builtin-platforms.ts     # BUILTIN_PLATFORMS 注册一行
test/<id>.test.ts            # 协议收发用例
test/helpers/platform-contract.ts  # 契约断言（复用）
scripts/real-host-check.mjs  # 真实宿主装配检查（含 setup 字段）
scripts/<id>-login.mjs       # 可选：平台只能扫码/设备码登录时，取得 token 的脚本
docs/configuration.md         # 配置表
docs/platforms/<id>.md        # 平台协议与限制
```

## 3. 实现步骤

### 3.1 配置 schema

在 `src/config.ts` 的对象 schema 里加同名片段，默认值写安全值；安装向导
只问「不填就收不到消息」的字段，群/私聊目标一律允许留空（首条消息后自动学习）。

```ts
matrix: s.optional(
  s.object(
    {
      token: secretInput(s.string({ label: "Access Token", max: 512 })),
      apiBase: s.string({ label: "API 基址", max: 512 }),
      groups: s.array(s.string({ max: 128 }), { label: "出站群" }),
      privateUsers: s.array(s.string({ max: 128 }), { label: "出站私聊" }),
      allowPrivate: s.boolean({ label: "接收私聊", default: false }),
      syncChannels: s.boolean({ label: "群聊/私聊互相同步", default: true }),
      sendIntervalMs: s.integer({ label: "发送间隔", default: 1_000, min: 0, max: 10_000 }),
      reconnectMinMs: s.integer({ label: "最小重连间隔", default: 1_000, min: 200, max: 60_000 }),
      reconnectMaxMs: s.integer({ label: "最大重连间隔", default: 60_000, min: 1_000, max: 600_000 }),
      reconnectMaxAttempts: s.integer({ label: "最大重连次数", default: 0, min: 0, max: 10_000 }),
    },
    { label: "Matrix" },
  ),
),
```

同时把 `platforms` 的 `choices` 与 `setInvalidateOption` 的键补上；插件
`src/index.ts` 的 `bind.servers` 只需要在适配器有 `server` 覆盖项时才加。

单聊形态的平台（参考 `src/platforms/weixin.ts`）不要照抄 `groups` /
`syncChannels` / `forwardMedia`：它们只制造「配置了却永远用不上」的字段。
官方客户端只有一对一会话时，`allowPrivate` 可以默认 `true`（否则装完没有
任何反应），同时仍受 `allowedUsers` / `privateUsers` 与全局 `privateSync` 约束。

某些平台（如微信 iLink）的 token 只能在用户终端扫码取得，宿主无法代劳：
在 `scripts/` 下加一个只用 Node 标准库的登录脚本，打印 token 并可选
`--apply` 写入 `mcsup plugin config set`；插件自身仍然不落盘密钥。

### 3.2 解析配置

`parse<Id>Settings(raw: unknown)` 在工厂阶段一次性把 JSON 转成强类型，
缺凭据抛 `PluginError("invalid_input", ...)`（宿主据此回滚配置，不会半启动）。
取值统一用 `src/platform-kit/shared/values.ts`，不要自己写 `objectOf` 之类的解析：

| 需求 | 函数 |
| --- | --- |
| 对象 / 非空字符串 / 数字 id | `objectOf` / `stringOf` / `idOf` |
| 有限数值 / 整数夹取 / 布尔 | `numberOf` / `intOf` / `boolOf` |
| 字符串数组 / 消息类别 | `stringsOf` / `categoriesOf` |
| API 基址（http(s)、去尾斜杠） | `httpUrlOf(value, "<id>")` |
| 入站消息去重窗口 | `MessageSeen`（`shared/seen.ts`，默认 1000 条、丢最旧） |

### 3.3 出站：直接用共享队列

发到多个会话的行为各平台完全一致，全部收敛在
`src/platform-kit/shared/outbound.ts`：目标解析（配置留空 = 学到的会话）、
排除来源会话、串行发送、积压上限、单目标失败计数、一次性告警。

```ts
this.targets = new TargetBook({
  label: this.id,
  log: this.log,
  learned: this.learned,          // new LearnedTargets({ key: "<id>:targets", ... })
  groups: this.settings.groups,
  users: this.settings.privateUsers,
  syncChannels: this.settings.syncChannels,
  noTargetHint: "收到消息后自动补齐",
  noMirrorHint: "在群里发一条消息，或把 <id>.groups 填成群 id",
});

this.outbound = new OutboundQueue<Pending, Prepared>({
  label: this.id,
  title: "Matrix",                // 错误文案里的显示名
  limit: OUTBOUND_LIMIT,
  log: this.log,
  targets: this.targets,
  isStopping: () => this.stopping,
  prepare: async (pending) => this.prepareMedia(pending),  // 可选：发送前一次性准备
  send: async (target, pending, prepared) => this.sendToTarget(target, pending, prepared),
});
```

适配器只提供 `send(target, pending)` 与可选的 `prepare(pending)`。
`deliver` 与 `relay` 都只做「格式化 + `outbound.push`」，禁止自己维护
`outQueue` / `sending` / `warnedNoTarget` —— 这些已经统一。

### 3.4 入站

```ts
this.ctx?.inbound({
  platform: this.id,
  channel: { kind, id, name },
  author: { id, name },
  text,
  messageId,
  // inject: false,   // 平台自己的 inbound 开关关掉时，只参与跨平台同步
});
```

会话目标用 `learned.remember(kind, id)` 记住；写盘由 `LearnedTargets` 负责。
`allowPrivate()` 必须是「平台配置 || 全局 privateSync」，即取并集：

```ts
private allowPrivate(): boolean {
  return this.settings.allowPrivate || this.privateSync;
}
```

### 3.5 重连与等待

`src/platform-kit/shared/runtime.ts` 提供 `jitter` / `sleep` / `abortableSleep` /
`errorText`。退避等待必须用 `abortableSleep(ms, ...signals)`，否则插件停止时
会多等一个完整退避周期；日志错误用 `errorText`，它会展开 `fetch` 的 `cause`
（`ECONNRESET` / 证书错误），否则只剩一句 `fetch failed`。

### 3.6 注册

```ts
// src/builtin-platforms.ts（组合根，只做装配）
import { matrixPlatformFactory } from "./platforms/matrix.js";

export const BUILTIN_PLATFORMS: readonly PlatformFactory[] = [
  discordPlatformFactory, logPlatformFactory, nullPlatformFactory,
  qqPlatformFactory, telegramPlatformFactory, matrixPlatformFactory,
];
```

`src/platform-kit/registry.ts` 会校验 id 形状与实例 id 一致性，重复登记直接抛错。
新增平台只动自己的适配器文件、注册行与配置，不要改动其它平台的适配器，也不要把公共件塞回该目录。

## 4. 硬性约束

- **禁止在适配器里做判定**：白名单、去重、注入模式、服务器选择、类别过滤的
  全局开关都在内核；适配器只使用自己的平台配置。
- **`relay` 禁止回流 `ctx.inbound`**，否则形成 qq → telegram → qq 的环。
- **媒体不跨平台搬运**：`[图片]` 等占位保留即可；平台私有句柄（`file_id`、
  `qqbot-media://`）在别的平台无效。
- **单平台故障隔离**：适配器自身的异常必须收口在自己的循环里，不能让
  `deliver` / `relay` 抛到内核；出站队列已兜住，别绕过它。
- **不新增运行时依赖**：优先用 Node 标准库；HTTP 用 `fetch`，WebSocket 已经有
  `ws`。引入新依赖需要单独说明理由。
- **日志**：中文、`[<id>]` 前缀、不打印 token / 完整 URL。
- **配置留空 = 全部**：不要要求用户手抄会话 id。

## 5. 测试清单

1. `test/<id>.test.ts`
   - 配置解析：默认值、缺凭据抛 `invalid_input`、越界夹取。
   - 出站：格式化、目标（配置 / 学习）、媒体或分片、失败重试。
   - 入站：群 / 私聊、白名单、`inbound=false` 只同步不注入、去重。
   - `relay`：只发到本平台会话，不回流入站。
   - 参考：`test/weixin.test.ts` 展示了「假 HTTP 长轮询 + uint64 保精度 +
     context token 重试 + `-14` 暂停」的写法。
2. `test/platform-contract.test.ts`：给内置平台跑契约；新平台加一行
   `await expectPlatformContract(matrixPlatformFactory, { settings })`。
3. `scripts/real-host-check.mjs`：装配层校验（能力、setup 字段、schema 默认值）。
4. `npm run verify`：类型检查 + 单测 + 构建 + 真实宿主检查，四项全过才算完成。

## 6. 上线前自查

- [ ] 配置留空时能靠首条消息补齐目标，重启后仍记得（`storage:kv` 未授予时降级有日志）。
- [ ] `stop` 幂等，`ctx.signal` abort 后不再发新消息。
- [ ] 断线重连退避可被停止打断，日志能看出「连不上」与「凭据错」的区别。
- [ ] 群 / 私聊两个方向都实测过入站、出站与跨平台转发。
- [ ] RAM 使用有界：队列上限、入站去重窗口、缓存条数都有常量控制。
## 7. 最小骨架

下面用假想的 `matrix` 说明骨架。内置适配器可参照 `src/platforms/qq.ts`、
`src/platforms/telegram.ts`、`src/platforms/discord.ts` 与 `src/platforms/weixin.ts`。

### 7.1 实现 `PlatformFactory`

下面用一个假想的 `matrix` 说明骨架。出站目标解析、队列、积压上限与失败计数
全部复用 `platform-kit/shared/outbound.ts`，适配器只提供「怎么发」：

```ts
// src/platforms/matrix.ts
import { LearnedTargets } from "../core/targets.js";
import { formatOutbound, formatRelay } from "../platform-kit/format.js";
import { OutboundQueue, TargetBook } from "../platform-kit/shared/outbound.js";
import type { NormalizedMessage } from "../core/types.js";
import type { ChatPlatform, PlatformFactory } from "../platform-kit/types.js";

const OUTBOUND_LIMIT = 512;

export const matrixPlatformFactory: PlatformFactory = {
  id: "matrix",
  title: "Matrix",
  description: "Matrix 客户端 API",
  create({ log, settings, kv, private: privateSync = false }) {
    const config = parseMatrixSettings(settings); // 缺凭据抛 PluginError("invalid_input")
    const learned = new LearnedTargets({ key: "matrix:targets", log, kv, limit: 64 });
    const targets = new TargetBook({
      label: "matrix", log, learned,
      groups: config.groups, users: config.privateUsers,
      syncChannels: config.syncChannels,
      noTargetHint: "收到消息后自动补齐",
      noMirrorHint: "在群里发一条消息，或把 matrix.groups 填成群 id",
    });
    const outbound = new OutboundQueue<{ id: string; text: string }>({
      label: "matrix", title: "Matrix", limit: OUTBOUND_LIMIT, log, targets,
      isStopping: () => stopping,
      send: (target, pending) => sendText(target, pending.text),
    });
    let stopping = false;
    return {
      id: "matrix",
      title: "Matrix",
      start(ctx) {
        if (ctx.signal.aborted) return;
        ctx.signal.addEventListener("abort", () => {
          stopping = true;
          outbound.clear();
        });
        // 建立连接；收到外部消息时调用 ctx.inbound({ platform, channel, author, text })
      },
      deliver(message: NormalizedMessage) {
        outbound.push({ id: message.id, text: formatOutbound(message) });
      },
      // 可选：实现 relay 就参与跨平台同步；只入自己的队列，禁止回流 ctx.inbound
      relay(message) {
        outbound.push({ id: `relay:${message.platform}`, text: formatRelay(message) });
      },
      stop(reason) {
        stopping = true;
        outbound.clear();
        log.debug(`[matrix] 断开：${reason}`);
      },
    } satisfies ChatPlatform;
  },
};
```

### 7.2 注册

```ts
// src/builtin-platforms.ts
import { matrixPlatformFactory } from "./platforms/matrix.js";

export const BUILTIN_PLATFORMS: readonly PlatformFactory[] = [
  discordPlatformFactory,
  logPlatformFactory,
  nullPlatformFactory,
  qqPlatformFactory,
  telegramPlatformFactory,
  matrixPlatformFactory,
];
```

### 7.3 加配置字段

```ts
// src/config.ts，configSchema 内
matrix: s.optional(
  s.object(
    {
      token: secretInput(s.string({ label: "Access Token", max: 512 })),
      roomId: s.string({ label: "默认房间", max: 128 }),
    },
    { label: "Matrix" },
  ),
),
```

之后配置 `"platforms": ["matrix"]` 就会实例化；`config.matrix` 这个片段会原样传给工厂的 `settings`（schema 内的默认值已由 zod 补齐）。

### 7.4 加测试

```ts
// test/matrix.test.ts
import { expectPlatformContract } from "./helpers/platform-contract.js";

it("满足平台最小契约", async () => {
  await expectPlatformContract(matrixPlatformFactory, { settings: { token: "t", roomId: "r" } });
});
```

协议收发行为按 QQ / Telegram / Discord / 微信 的用例写：配置解析、目标（配置与学习）、
入站白名单、`inbound=false` 只同步不注入、`relay` 不回流。

### 7.5 适配器约定

- `deliver` 由内核串行调用，不会并发；慢只影响自己的队列。
- 队列满时内核丢最旧消息并计入 `dropped`，适配器不需要处理背压。
- `deliver` 抛错只计入 `failed` 并记日志，不会打断消费者，也不影响其他平台。
- 连接、重连、限流、鉴权都由适配器自己负责；内核只提供 `AbortSignal` 与 `stop(reason)`。
- **入站**：适配器收到外部消息后调用 `ctx.inbound({ platform, channel, author, text, messageId?, inject? })`；
  内核统一做去重、长度限制、排队、回声抑制，并通过 `ctx.game` 注入游戏。
  平台自己的 `inbound=false` 设成 `inject: false`，只停注入，消息仍参与跨平台同步；
  适配器不需要知道服务器选择、注入命令或队列细节。
- **跨平台**：适配器可选地实现 `relay(message)`，内核会把「其它平台」收到的消息
  投给它；不实现就永远收不到转发（`log` / `null` 如此）。判断依据是「有没有这个
  方法」，不是平台 id，新平台无需改内核。`relay` 只把已格式化的文本发进自己的
  出站队列，禁止回流 `ctx.inbound`，否则会成环；来源平台由内核排除，媒体不跨平台
  搬运。
- **降级**：`ctx.game` 在未授予 `console:write` 时为 `undefined`；适配器只负责上报消息，
  内核会记录失败计数，不要求适配器自己判断权限。
- **私聊**：`PlatformCreateOptions.private` 是内核下发的全局 `privateSync`，适配器
  用「自己的 `allowPrivate` 或它」决定是否接收私聊（取并集，不要覆盖平台显式配置）。
  打开后私聊和群聊走同一条入站链路，无需额外分支。
- 平台 id 必须匹配 `^[a-z][a-z0-9-]{0,31}$`，且与 `create()` 返回实例的 `id` 一致。
