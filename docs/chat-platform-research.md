# 聊天平台接入调研：OpenClaw 与 Hermes Agent

> 目的：读懂两个成熟项目「如何把外部聊天平台接进来」，抽取可复用的契约与生命周期设计，映射到本项目的 `ChatPlatform` 可插拔层。
>
> 调研时间：2026-11-21
>
> - OpenClaw：`openclaw/openclaw`，本地稀疏检出（HEAD `1ad4985a4d165c6224deeb71a3f99fe53ed8e4e8`，2026-11-21）。
> - Hermes Agent：`NousResearch/hermes-agent`，`main` @ `aeb5a071069dbd85d85f2c8d44337f16df29d475`；因网络限制，使用 GitHub API 抓取核心文件快照，未形成完整 git clone。

---

## 0. 结论先行

两套实现虽然语言与产品形态不同，但在关键问题上收敛到同一组答案：

1. **平台 = 长驻连接任务 + 显式生命周期钩子**。OpenClaw 是 `gateway.startAccount(ctx)` / `stopAccount(ctx)`；Hermes 是 `BasePlatformAdapter.connect(is_reconnect)` / `disconnect()`。两者都把「连接」而不是「发一条消息」当作平台的一等公民。
2. **契约是宽接口 + 可选能力位**。OpenClaw 的 `ChannelPlugin` 有 30+ 可选适配器（config / outbound / status / security / threading / streaming …）；Hermes 的 `PlatformEntry` 把配置校验、依赖探测、目标解析、standalone 发送拆成可选钩子，适配器本体只继承 `BasePlatformAdapter`。
3. **监管与重连在框架层，不在适配器里重复造轮子**。OpenClaw 的 `createChannelManager` 负责启动、停止、自动重启与状态机；Hermes 的 `GatewayAdapterLifecycleMixin` 负责有界连接、fatal 入队、重连 watcher。适配器只回答「怎么连、怎么收发、什么错误可重试」。
4. **入站必须先归一化，再谈路由**。两者都有独立的消息事件模型（OpenClaw 的 inbound pipeline + session/thread 解析；Hermes 的 `MessageEvent` + `SessionSource`），鉴权、去重、会话键、媒体、debounce 都在归一化之后、交给 agent 之前完成。
5. **出站是「目标 + 载荷 + 送达结果」**，而不是一个裸 `send(text)`。两者都支持分片、媒体、线程/主题、送达结果与平台限流（Telegram FloodWait / RetryAfter）。
6. **本项目当前刻意更窄**：`ChatPlatform` 只有 `start / deliver / stop`，平台监管、重连与限流下放给适配器；入站通过 `PlatformContext.inbound` + `GamePort` 完成。对照两套实现，下一阶段最该补的是**送达结果/重试语义**与**平台级健康状态**，而不是把监管搬回内核。

---

## 1. 仓库与代码获取状态

### 1.1 OpenClaw

- 本地路径：`C:\Space\Projects\openclaw`
- 远程：`https://github.com/openclaw/openclaw.git`
- 状态：`git ls-files` 有 66,357 个文件，但工作树只检出根级文件（`src/`、`extensions/` 未落盘）。这是网络中断导致的部分检出，**不是**完整的 sparse checkout。
- 影响：本地无法全文检索；核心文件通过 GitHub API 逐文件抓取到
  `C:\Users\xjuun\AppData\Local\Temp\opencode\oc\`，文件名把 `/` 替换为 `__`。

### 1.2 Hermes Agent

网络曾一度不可用（`Recv failure: Connection was reset`），最早使用 GitHub API 逐文件抓取核心快照到 `C:\Users\xjuun\AppData\Local\Temp\opencode\hm\`：

```powershell
gh api "repos/NousResearch/hermes-agent/contents/<path>" -H "Accept: application/vnd.github.raw"
```

随后网络短暂恢复，已补成**本地稀疏克隆**：

```powershell
git clone --depth 1 --filter=blob:none --sparse --single-branch `
  https://github.com/NousResearch/hermes-agent.git C:\Space\Projects\hermes-agent
git -C C:\Space\Projects\hermes-agent sparse-checkout set gateway plugins/platforms hermes_platform
```

- 本地路径：`C:\Space\Projects\hermes-agent`，HEAD `aeb5a07`。
- 检出范围：`gateway`（415 文件）、`plugins/platforms`（248 文件）、`hermes_platform`（16 文件）。
- 工作树干净；`gateway/platforms/base.py` 4648 行、`plugins/platforms/telegram/adapter.py` 6637 行，与 API 快照行号一致，可交叉复核。
- 仍未检出的目录不影响本文结论：核心平台契约、注册、生命周期、入站/出站都在上述范围内。
- 历史半成品 tarball 仍在 `C:\Users\xjuun\AppData\Local\Temp\opencode\hermes-main.tar.gz`（21.9 MB，不完整，服务器不支持 Range 续传），已无用。

### 1.3 代码索引（仓库路径；OpenClaw 另有本地快照）

| 本地快照（`...\Temp\opencode\`） | 仓库路径 |
| --- | --- |
| `oc\src__channels__plugins__types.plugin.ts` | `src/channels/plugins/types.plugin.ts` |
| `oc\src__channels__plugins__types.adapters.ts` | `src/channels/plugins/types.adapters.ts` |
| `oc\src__channels__plugins__outbound.types.ts` | `src/channels/plugins/outbound.types.ts` |
| `oc\src__channels__inbound-event__envelope.ts` | `src/channels/inbound-event/envelope.ts` |
| `oc\src__gateway__server-channels.ts` | `src/gateway/server-channels.ts` |
| `oc\src__gateway__channel-health-monitor.ts` | `src/gateway/channel-health-monitor.ts` |
| `oc\src__gateway__channel-health-policy.ts` | `src/gateway/channel-health-policy.ts` |
| `oc\extensions__telegram__src__channel.ts` | `extensions/telegram/src/channel.ts` |
| `oc\extensions__telegram__src__monitor.ts` | `extensions/telegram/src/monitor.ts` |
| `oc\extensions__telegram__src__bot-handlers.inbound-pipeline.ts` | `extensions/telegram/src/bot-handlers.inbound-pipeline.ts` |
| `oc\extensions__telegram__src__outbound-adapter.ts` | `extensions/telegram/src/outbound-adapter.ts` |
| `hm\gateway__platform_registry.py` | `gateway/platform_registry.py` |
| `hm\gateway__platform_activation.py` | `gateway/platform_activation.py` |
| `hm\gateway__platforms__base.py` | `gateway/platforms/base.py` |
| `hm\gateway__platforms__event.py` | `gateway/platforms/event.py` |
| `hm\gateway__platforms__send_targets.py` | `gateway/platforms/send_targets.py` |
| `hm\gateway__platforms__shared_ingress.py` | `gateway/platforms/shared_ingress.py` |
| `hm\gateway__platforms__ADDING_A_PLATFORM.md` | `gateway/platforms/ADDING_A_PLATFORM.md` |
| `hm\gateway__run_adapters.py` | `gateway/run_adapters.py` |
| `hm\gateway__run.py` | `gateway/run.py`（仅取退避常量） |
| `hm\gateway__outbound__send.py` | `gateway/outbound/send.py` |
| `hm\plugins__platforms__telegram__adapter.py` | `plugins/platforms/telegram/adapter.py` |
| `hm\plugins__platforms__telegram__plugin.yaml` | `plugins/platforms/telegram/plugin.yaml` |

说明：Hermes 的 `hm\...` 列是早期 API 快照；这些文件现在也都在 `C:\Space\Projects\hermes-agent` 的稀疏克隆中。正文引用的 `gateway/delivery.py`、`gateway/delivery_ledger.py`、`gateway/run_inbound_consumer.py`、`gateway/run_inbound.py` 直接读克隆即可，无需快照。

---

## 2. OpenClaw

### 2.1 平台契约：一个插件对象，按能力位拆分

`src/channels/plugins/types.plugin.ts` 的 `ChannelPlugin`（第 69 行起）不是「一个聊天 SDK 的包装」，而是一组可独立实现的适配器：

```ts
export type ChannelPlugin<...> = {
  id: string;
  meta: { ... };
  capabilities: { ... };
  config: ChannelConfigAdapter<ResolvedAccount>;   // 账户解析/校验
  security?: ChannelSecurityAdapter<...>;          // 鉴权/白名单
  outbound?: ChannelOutboundAdapter;               // 出站
  status?: ChannelStatusAdapter<...>;              // 健康与探测
  gateway?: ChannelGatewayAdapter<...>;            // 长驻连接
  lifecycle?: ChannelLifecycleAdapter;
  messaging?: ChannelMessagingAdapter;
  threading?: ChannelThreadingAdapter;
  streaming?: ChannelStreamingAdapter;
  // ... 还有 pairing/groups/mentions/commands/doctor 等 20+ 可选位
};
```

设计要点：

- **能力可选**：只做出站就只实现 `outbound`；需要长驻收消息才实现 `gateway`。宿主通过 `capabilities` 与可选字段判断能做什么，而不是靠 `instanceof`。
- **账户模型内建**：`config` 适配器提供 `listAccountIds` / `resolveAccount` / `inspectAccount` / `resolveAccountSnapshot`，天然支持「一个渠道多账号」。
- **配置、安全、状态是同级一等公民**，不是塞进 `gateway` 的私有逻辑。

### 2.2 生命周期：`startAccount` 是长驻任务，监管在 ChannelManager

`src/channels/plugins/types.adapters.ts`：

```ts
// 204
export type ChannelGatewayContext<ResolvedAccount = unknown> = {
  ...
  abortSignal: AbortSignal;              // 209
  setStatus: (next: ChannelAccountSnapshot) => void;  // 214
};

// 231
startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
// 232
stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
```

`startAccount` 返回的 Promise 代表**这个账户的连接任务**，通常会一直挂到 abort。以 Telegram 为例（`extensions/telegram/src/channel.ts`）：

- 第 682 行 `gateway:`；第 683 行 `startAccount`。
- 先做 token 归属检查（重复 token 直接抛错）、启动探测、凭证缓存。
- 第 783 行 `await monitorModule.monitorTelegramProvider({ token, accountId, abortSignal, ... })` —— 把长轮询/Webhook 循环交给 monitor。
- 第 801 行 `stopAccount` 只做资源释放（释放 polling 租约等），不负责「重连」。

`src/gateway/server-channels.ts` 的 `createChannelManager`（第 155 行）是监管者：

- `RESTART_POLICY`（第 96 行）：`initialMs: 5000`、`maxMs: 300000`、`factor: 2`、`jitter: 0.1`；`MAX_RESTARTS = 10`（第 102 行）；`CHANNEL_STABLE_RUN_MS = RESTART_POLICY.maxMs`（第 103 行）——稳定运行 5 分钟后重置重启计数。
- 自动重启循环（第 871 行起）：超过上限后不再重启；`manuallyStopped` 集合（第 180 行附近）保证手动停止不会被自动拉起。
- 每个账户一个 `AbortController`，状态机区分 `starting / running / recovering / stopped` 等；重启中 `setStatus` 会把 `restartPending` 暴露给上层。
- `channel-health-monitor.ts`（第 15 行 `DEFAULT_MONITOR_STARTUP_GRACE_MS = 60_000`）负责周期性健康检查与「接管/交接」，与启动重启策略分离。

**关键取舍**：适配器只描述「怎么连、连上后做什么」；重试次数、退避、手动停止抑制、稳定窗口都由中心监管器统一实现。平台之间互不影响。

### 2.3 入站：鉴权 → 去重 → 会话/线程 → 媒体 → debounce

Telegram 的入站管线在 `extensions/telegram/src/bot-handlers.inbound-pipeline.ts`：

- 第 60 行 `createTelegramInboundPipeline({ params, message, authorization })`。
- 收到更新后先做 `kind: "message" | "channel_post"` 判别与一组 `ignored` 早退。
- 第 201 行 `claimMessageDispatchDedupe(normalizedMsg, botUserId)`：**投递级去重**，返回 claim 句柄，处理完再释放；重复投递直接 `ignored`。
- 之后解析 `threadSpec`（forum / direct-messages / 普通会话）、`conversationKey`、发送者，决定 session key。
- 第 370 行起计算 `debounceKey` 与 `debounceLane`；控制类文本（`/stop` 等）走 bypass，不进入 debounce，避免阻塞控制通道。
- 媒体组（album）单独聚合；媒体大小有上限（`mediaMaxBytes`）。

入站归一化的终点不是「一段文本」，而是带通道、账户、发送者、会话、线程、回复链、媒体引用的结构化对象；再由 envelope 构造器（`src/channels/inbound-event/envelope.ts`）拼成 agent 可读的上下文。

连接层还有两个值得借鉴的点（`extensions/telegram/src/monitor.ts`）：

- **polling lease**（第 55 行 `acquireTelegramPollingLease`）：同一 bot token 只允许一个长轮询者，避免两个进程同时 getUpdates 互相抢更新。
- **update offset 持久化**（第 85 行起）：重启后从上次 offset 继续，减少重复/丢失；冷启动与重连对服务端队列的处理不同。

### 2.4 出站：声明式适配器 + 统一投递管线

`src/channels/plugins/outbound.types.ts` 的 `ChannelOutboundAdapter` 不是单一 `send`，而是声明一组能力与约束：

- 目标形状：`channel` / `to` / `accountId?` / `threadId?`（第 103–106 行）。
- 载荷：`payload: ReplyPayload`（文本、媒体、交互、投票……）。
- 传输控制：`abortSignal?`（第 110 行）、`onDeliveryResult?`（第 26 行）。
- 管线参数：`deliveryMode: "direct" | "gateway" | "hybrid"`、`chunker` / `chunkedTextFormatting`、`textChunkLimit`、`sanitizeText`、`normalizePayload` 等（第 129 行起）。
- 能力声明：`supported`、`buttons`、`selects`、`context`、`divider`、`charts`、`tables`、`limits`（第 35 行起）。

Telegram 侧用 `createTelegramOutboundAdapter`（`extensions/telegram/src/outbound-adapter.ts`）实现 `sendText` / `sendMedia` / 投票等，并通过 `createChannelMessageAdapterFromOutbound` 把出站能力包装成统一 message adapter（`channel.ts` 第 180 行）。

**要点**：分片、格式化、媒体、线程、送达回调是框架级横切能力；具体平台只提供「这一种 payload 怎么发」。

---

## 3. Hermes Agent

### 3.1 平台注册：`plugin.yaml` + `PlatformEntry`，延迟物化

Hermes 的插件目录约定是 `plugins/platforms/<name>/{plugin.yaml, adapter.py}`（内置），第三方可放 `~/.hermes/plugins/`。`gateway/platforms/ADDING_A_PLATFORM.md` 明确推荐插件路径：**零核心改动**。

`gateway/platform_registry.py`：

```python
# 47
class PlatformEntry:
    name: str                     # config.yaml 标识，如 "irc"
    label: str                    # 展示名
    adapter_factory: Callable[[Any], Any]   # PlatformConfig -> adapter
    check_fn: Callable[[], bool]            # 被动依赖探测（无副作用）
    validate_config: Optional[Callable[[Any], bool]] = None
    ensure_deps_fn: Optional[Callable[[], bool]] = None   # 主动安装依赖
    install_hint: Optional[str] = None
    # 还有 source、home_channel、send target 解析、standalone sender 等
```

注册与实例化：

- `PlatformRegistry.register(entry)`（第 431 行）：同名后写覆盖；插件作用域自动推断。
- `register_deferred(name, loader)`（第 263 行）：只登记 loader，不 import。`gateway/platform_activation.py` 解释得很清楚：冷启动时按「配置块 / 环境变量 / manifest `requires_env`」判断哪些平台**可能被启用**，只物化这些，避免一次 import 20 个 SDK 拖慢启动。
- `create_adapter(name, config)`（第 563 行）：先跑 `check_fn`；失败且配置有效时，才调用 `ensure_deps_fn` 做一次安装（`_probe` 第 546 行）。依赖缺失不再是「导入即崩」，而是可诊断的状态。

`plugins/platforms/telegram/plugin.yaml` 用 `requires_env` / `optional_env` 声明配置项，供 CLI 提示与环境激活使用。

### 3.2 生命周期：有界连接 + fatal 队列 + 重连 watcher

`gateway/platforms/base.py` 的 `BasePlatformAdapter`（第 1778 行）定义三个抽象方法：

```python
# 2591
async def connect(self, *, is_reconnect: bool = False) -> bool: ...
# 2597
async def disconnect(self) -> None: ...
# 2601
async def send(self, chat_id, content, reply_to=None, metadata=None) -> SendResult: ...
```

`is_reconnect` 是刻意设计的语义：冷启动可以丢弃服务端积压的旧更新，watcher 重连则要保留离线队列（见 `run_adapters.py` 第 162–183 行注释）。

`gateway/run_adapters.py` 的 `GatewayAdapterLifecycleMixin`（第 66 行）是监管层：

- **有界连接**（第 177 行 `_connect_adapter_bounded`）：`adapter.connect()` 用 `asyncio.wait_for` 包住，单个平台不能阻塞其他平台；冷启动预算更短，超时后交给 watcher 用完整预算重试。
- **失败清理**（第 96 行附近）：connect 失败后防御性调用 `disconnect()`，避免 `ClientSession`、轮询任务、子进程泄漏。
- **fatal 入队**（第 286 行起）：把平台、配置、尝试次数、下次重试时间放进 `_failed_platforms`，并启动 watcher。
- **重连 watcher**（第 723 行）：初始延迟 10 秒；空队列每 30 秒轮询；有失败项时每 10 秒检查。退避 30s → 60s → 120s → …，上限 300 秒（`gateway/run.py` 第 3183 行 `_RECONNECT_BACKOFF_CAP = 300`）。
- **可重试失败无限重试**（自愈），不可重试的失败（缺凭证、缺依赖且无法安装、adapter 创建返回 None 且不会自愈）移出队列并标记 `NEEDS_ATTENTION`（第 759 行 `_flag_reconnect_needs_attention`）。这只是一个告警信号，不是熔断。
- **watcher 自身被监管**（第 693 行 `_spawn_reconnect_watcher` / `_spawn_supervised`）：后台任务崩溃会按 1s、2s、4s…上限 60s 重生，避免「watcher 死了就永远不重连」。

Telegram 适配器（`plugins/platforms/telegram/adapter.py`）承担平台细节：

- `connect(is_reconnect)`（第 2915 行）：根据 `TELEGRAM_WEBHOOK_URL` 选择长轮询或 Webhook；冷启动是否 drop pending 由配置决定。
- `disconnect()`（第 3111 行）：停轮询/Webhook、释放资源。
- `send()`（第 3356 行）：分片、富文本、媒体、回复、话题；`SendResult` 带 `retry_after`（FloodWait）。
- `_handle_polling_network_error`（第 1890 行）、`_polling_heartbeat_loop`（第 1962 行）、`_handle_polling_conflict`（第 2193 行）：网络错误退避、心跳、409 冲突处理。
- 限流与 flood 窗口拆分到 `telegram_flood_*` / `telegram_batch*` 等模块，避免 adapter 本体继续膨胀。

### 3.3 入站：`MessageEvent` + 会话忙闲

`gateway/platforms/event.py` 的 `MessageEvent`（第 67 行）是跨平台归一化事件：

- 文本与类型（`text` / `message_type`）。
- 发送者（`user_id` / `user_name`）。
- 会话源（`source: SessionSource`）、原始消息、平台消息 id、`platform_update_id`。
- 媒体（`media_urls` / `media_types` / `media_filenames`）。
- 回复链（`reply_to_message_id` / `reply_to_text` / `reply_to_author_*` / `reply_to_is_own_message`）。
- 控制与提示（`allow_gateway_control`、`channel_prompt`、`channel_context`、`timestamp`）。
- 内部标记（`_gateway_accepted`、`_admitted_before_drain`）。

`BasePlatformAdapter.handle_message`（第 3867 行）：

- 没有 handler 时记录**一次**错误后丢弃，避免静默黑洞。
- 身份/会话键先行，再做路由与 guard 查询；同一 `session_key` 正在跑 agent 时，消息进入 **busy 分支**（排队 / 打断，取决于 `busy_text_mode`），而不是并发跑两个 turn。
- 普通消息通过 `_message_handler` 交给 runner；后台任务化，保证适配器继续收消息、支持中断。
- 历史去重、媒体去重是 best-effort 且 fail-open（第 96 行注释、第 2519 行），不会因为去重失败阻断投递。

入站通过后还有一层**插件消费点**：`gateway/run_inbound_consumer.py` 的 `post_gateway_admission` 钩子，对每条通过鉴权、bot 准入、暂停/排空、pending 拦截、忙闲车道与空闲 slash 命令的消息触发一次。它运行在该消息**路由到的 profile 作用域**内，载荷是普通快照（不是 live runner/会话句柄）。

- 失败开放：回调抛错、超时或没有返回 `{"action": "handled"}` 时只记日志，消息继续交给 agent，单个坏插件不能吞掉整条通道。
- 返回 `handled` 时消息被插件消费，可用 `reply` 直接回复，不再进入 agent turn。

这是「平台消息 → 业务插件」的扩展点，与本项目「宿主事件 → 桥」的订阅模型思路一致：**先完成准入与归一化，再让业务方选择消费或放行**。

### 3.4 出站：目标解析 → live adapter → standalone fallback

`gateway/outbound/send.py`：

- `send_message_tool` / `_handle_send`（第 149 行）：解析 `target`，拆成 `platform_name / chat_id / thread_id`；先做 surrogate 清理（平台 SDK 的 UTF-8 编码会崩）；再拆媒体、做 cron 重复发送抑制。
- `_resolve_tool_target`（第 49 行）：平台可用 `PlatformEntry` 注入的 `target_ref_syntax_fn`（`gateway/platforms/send_targets.py`）覆盖通用规则（E.164、数字、Matrix `!`/`@`）；返回 `NOT_EXPLICIT` 时跳过通用规则直接查目录。
- `_send_via_adapter`（第 500 行）：**优先用进程内 live adapter**（保留线程/话题与限流状态）；cron 等无 live adapter 场景才用插件的 `standalone_sender_fn`；两者都没有就报错，而不是静默丢弃。
- 分片按 `max_message_length_for_chat(chat_id)`（`base.py` 第 1903 行），支持每会话不同上限（relay 场景）。
- `SendResult`（`base.py` 第 1568 行）带 `retry_after`（服务端限流优先于本地退避），并区分部分投递。

### 3.5 投递可靠性与错误分类

`gateway/delivery.py` 把「发给哪个目标」和「怎么发」拆开：

- `DeliveryTarget.parse`（第 152 行）：`origin` / `local` / `<platform>` / `<platform>:<chat_id>[:<thread_id>]`；**未知平台不静默落本地**，而是保留原名，`deliver()` 返回 `unknown_platform` 错误（第 219 行）。
- `DeliveryRouter.deliver`（第 214 行）逐个目标返回结果，而不是一抛了之：`{success, result | error}`。已知永久不可达的目标（群被删、bot 被拉黑、用户注销）记入 `DeadTargetRegistry` 直接跳过，节省限流预算；后续一次成功发送会自动清除标记（自愈）。
- `_deliver_to_platform`（第 300 行）：统一兜底——超长输出裁剪、拒绝「沉默叙述」类无意义输出（防止 bot 之间回环；cron 产物例外）、线程路由（调用方 `metadata` 优先于 target）、Telegram 私聊话题不存在时重建**一次**再重试。
- 失败分类：
  - `PartialDeliveryError`（第 39 行）：头部已发出、后续分片失败——**不能整体重放**，否则重复投递。
  - `DeliverySendError(..., retryable=...)`（第 123 行）：显式区分可重试与永久失败。
  - `classify_send_error`（`base.py` 第 1636 行）把异常归一到 `too_long / bad_format / forbidden / not_found / rate_limited / transient / unknown`，**未识别的错误归为 `unknown`，绝不当成良性**。
- `gateway/delivery_ledger.py` 把「本应发出的回复」记成义务（obligation）：`record_obligation` / `mark_attempting` / `mark_delivered` / `mark_failed` / `sweep_recoverable` / `pending_retries`，并按 PID + 启动时间判断属主存活，进程崩溃后可恢复未完成的投递。它还把 FloodWait 与普通退避分开计算（`flood_not_before` / `retry_not_before`）。

### 3.6 多 profile 与共享监听

`gateway/platforms/shared_ingress.py` 解决「一个进程多个 profile」时端口冲突：默认 profile 持有唯一 HTTP listener；次要 profile 的 webhook 适配器以 shared-listener 模式构造，`bind_listener` 只发布 `web.Application` 不监听端口；请求按 `/p/<profile>/<path>` 转发，并在**命名 profile 的运行时作用域**内、用该 profile 的密钥校验。核心不变量是：未加前缀的路径仍归默认 profile，没有对应 adapter 的 profile 得到 404。

---

## 4. 横向对比

| 维度 | OpenClaw | Hermes Agent | 对本项目的含义 |
| --- | --- | --- | --- |
| 形态 | TS/Node 插件对象（`ChannelPlugin`） | Python 插件目录（`plugin.yaml` + `adapter.py`）+ `PlatformEntry` | 我们的 `PlatformFactory` 是「注册描述 + 工厂」，更接近 Hermes |
| 契约宽度 | 很宽：30+ 可选能力位 | 窄：3 个抽象方法 + 可选注册钩子 | 我们的 3 方法契约接近 Hermes，扩展空间足够 |
| 连接语义 | `startAccount` 返回长驻 Promise | `connect(is_reconnect) -> bool` | 我们的 `start(ctx)` 是长驻语义，但没有「重连」入口 |
| 监管位置 | `createChannelManager` + health monitor | `GatewayAdapterLifecycleMixin` + watcher | 我们把监管下放给适配器（有意简化） |
| 重启策略 | 5s 起、2x、300s 上限、10 次；稳定 5 分钟重置 | 30s 起、2x、300s 上限；可重试失败无限重试 | 真实适配器可直接借鉴退避参数 |
| 手动停止 | `manuallyStopped` 抑制自动拉起 | `/platform pause` | 我们的 `stop(reason)` 已能表达意图，但没有「暂停 vs 移除」区分 |
| 依赖/配置校验 | `config` 适配器 + 配置 schema | `check_fn` / `validate_config` / `ensure_deps_fn` / `install_hint` | 我们靠工厂里抛错 + 宿主回滚；可补 `validate` 钩子 |
| 延迟加载 | bundled/registry loader | `register_deferred` + activation evidence | 我们平台少，暂不需要；平台多了再考虑 |
| 入站归一化 | inbound pipeline + envelope + session route | `MessageEvent` + `SessionSource` | 已落地简化版 `PlatformInboundMessage` + `PlatformContext.inbound`，由内核去重/排队后经 `GamePort` 注入游戏；回复链、媒体、线程仍在下一阶段 |
| 去重 | dispatch dedupe claim（可释放） | 历史/媒体 best-effort 去重 | 我们在存储层按内容摘要去重，语义不同（我们丢重复事实） |
| 出站结果 | `OutboundDeliveryResult` + `onDeliveryResult` | `SendResult` + `retry_after` + 部分投递 | 我们的 `deliver` 返回 void；缺送达结果与限流反馈 |
| 多账号/多实例 | `listAccountIds` 原生支持 | `platforms` + `multiplex_profiles` + shared ingress | 我们一个 id 一个实例；多实例可后续加 |
| 故障隔离 | 每账户任务 + 状态机 | 每适配器任务 + fatal 队列 | 我们每平台串行消费者，已做到平台间隔离 |
| 投递可靠性 | 分片/媒体管线 + `onDeliveryResult` | `DeliveryTarget` + dead-target 注册表 + obligation ledger + 部分投递错误 | 我们只保证入队与串行；送达与重试语义尚未建模 |
| 媒体 | 框架级 media pipeline | 框架级 media cache/上限/重试 | 我们消息模型无媒体字段，阶段内合理 |

---

## 5. 映射到本项目的 `ChatPlatform`

### 5.1 当前契约

```ts
// src/platform-kit/types.ts（节选）
export interface ChatPlatform {
  readonly id: string;
  readonly title: string;
  start(ctx: PlatformContext): void | Promise<void>;
  deliver(message: NormalizedMessage): void | Promise<void>;
  /** 可选：接收其它平台转发来的消息，投给本平台的会话目标 */
  relay?(message: PlatformRelayMessage): void | Promise<void>;
  stop(reason: string): void | Promise<void>;
}

export interface PlatformContext {
  readonly log: LogClient;
  readonly signal: AbortSignal;
  readonly game?: GamePort;          // 未授予 console:write 时 undefined
  inbound(message: PlatformInboundMessage): void;
}

export interface GamePort {
  sendChat(server: string, text: string): Promise<void>;
  resolveServer(preferred?: string): Promise<string | null>;
}
```

对应关系：

| 本项目 | OpenClaw | Hermes |
| --- | --- | --- |
| `PlatformFactory.id/title/description` | `ChannelPlugin.id/meta` | `PlatformEntry.name/label` |
| `PlatformFactory.create({ log, settings })` | `config.resolveAccount` + `gateway.startAccount` 的装配 | `PlatformEntry.adapter_factory(platform_config)` |
| `settings`（`config[<id>]` 切片） | `account.config` | `PlatformConfig.extra` / YAML 平台块 |
| `start(ctx.signal)` | `startAccount(ctx.abortSignal)` | `connect(is_reconnect=False)` |
| `deliver(message)` | `outbound.sendText/sendMedia...` | `BasePlatformAdapter.send(chat_id, content, metadata)` |
| `stop(reason)` | `stopAccount(ctx)` | `disconnect()` |
| 分发器串行消费者 | `ChannelManager` 的 per-account 任务 | `GatewayAdapterLifecycleMixin` 的 per-adapter 任务 |
| 内核环形队列 + 丢最旧 | 各平台内部队列 + 框架分片/限流 | 各适配器内部队列 + `SendResult.retry_after` |

### 5.2 本项目有意保留的差异

1. **监管下放**：我们的 `start` 失败 = 配置失败（`PlatformDispatcher.start` 会回收已启动平台并抛错，宿主回滚配置）；运行期断线由适配器自己重连。这与 OpenClaw/Hermes「框架统一监管」不同，但对接入单平台、单进程的插件足够，且更可测。
2. **双向已落地**：Minecraft → 平台走 `deliver`；平台 → 游戏走 `PlatformContext.inbound`，由内核统一去重、排队、回声抑制后经 `GamePort` 注入。适配器仍只做协议翻译，业务语义留在内核。
3. **去重语义**：我们在入库前按内容摘要去重，重复事实直接丢弃并计数；参考实现更多是「同一条平台更新不重复派发」，不丢弃业务事实。两者不冲突：平台重试导致的重复投递由适配器按 `message_id` 处理，内核再做一层 10 分钟去重。
4. **无媒体/线程/回复**：我们的消息模型只有文本与来源字段；参考实现的线程/话题、媒体、回复链是真实平台必需的能力，接入前需要扩展 `NormalizedMessage` 或增加投递上下文。QQ 当前把图片/表情/语音/文件转为占位文本。

### 5.3 落地实现：QQ 官方机器人（API v2）与本节的对应

一个真实适配器已经把下面的能力落到实处，可以作为后续平台的参照：

| 参考实现的能力 | QQ 适配器的做法 |
| --- | --- |
| Hermes `validate_config` 的前置校验 | `parseQqSettings` 在 `create()` 阶段校验 `appId` / `clientSecret` / URL 与 intents，缺失即 `invalid_input`，宿主回滚配置 |
| Hermes 的 `check_fn` / 依赖探测 | 未授予 `console:write` 时不阻塞启动，而是把入站降级为计数失败并记日志 |
| OpenClaw 的重连与稳定窗口 | 指数退避 + 抖动（`reconnectMinMs`–`reconnectMaxMs`），`stop` 立即可中断；连续短连接 3 次判定为配置/权限问题 |
| Hermes 的关闭码处理 | `4004` 刷新 token、`4006/4007/4900~4913` 清 session 重新 Identify、`4008` 等待限流、`4013/4014/4914/4915` 等致命码停止重连 |
| Hermes 的 `SendResult.retry_after` | 用 `sendIntervalMs` 限流、429/5xx 退避重试；被动回复失效时降级主动消息 |
| Hermes 入站的 `MessageEvent` | `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE` → `PlatformInboundMessage`（channel/author/text/messageId） |
| 历史去重 fail-open | 适配器按消息 id 记忆 1000 条；内核按 `platform:id` 记 10 分钟 |
| OpenClaw 的 health 状态 | Hello 心跳 + 最近错误日志；尚未暴露到 `status` |
| 平台原生消息 → 宿主 | `GamePort.sendChat` 按 `injectMode` 用 `say`（默认，写 `latest.log`、游戏内多 `[Server]` 前缀）或 `tellraw @a`（单标签、不写服务器日志）注入；内核做 60 秒回声抑制 |

**密钥与配置**：`qq.clientSecret` / `telegram.botToken` / `discord.botToken` 用 SDK `secretInput` 标记为 `x-mcsup-secret`。宿主负责按插件隔离、加密持久化、管理读打码、握手下发明文；插件内部不再落盘，`clientSecret` 只发给官方凭证地址，Telegram token 只用于 Bot API URL（日志不打印完整 URL），Discord token 只用于 `Authorization: Bot` 头，OpenAPI 的 `access_token` 不写日志。

### 5.4 若要接更多真实平台，建议的演进顺序

按收益/成本排序：

1. **`deliver` 返回送达结果**：`Promise<DeliveryResult>`，至少包含 `ok`、`retryable`、`retryAfterMs`、`partial`、平台消息 id。这样分发器才能区分「永久失败」「限流重试」与「头部已发出、不能整体重放」。参考：Hermes `SendResult.retry_after` + `PartialDeliveryError`、OpenClaw `onDeliveryResult`。
2. **平台健康状态**：`health?(): PlatformHealth` 或纳入 `status`（连接态、最近错误、重连次数、最后成功投递时间）。参考：OpenClaw `status` 适配器 + health monitor；Hermes `_update_platform_runtime_status`。
3. **启动期配置校验钩子**：`validate(settings): void`（或工厂内抛错即可），把「缺 token / 缺 endpoint」提前到配置阶段，而不是第一条消息才失败。参考：Hermes `validate_config` / `check_fn`。
4. **投递上下文**：线程/话题、回复、媒体、消息类型。可先加可选 `deliverContext`，避免破坏现有适配器。
5. **多实例/多账户**：把平台 id 从「唯一实例」扩展为「id + account」，或允许配置数组。参考：OpenClaw `listAccountIds`、Hermes multiplex profiles。
6. **入站方向已落地简化版**：适配器 → 内核 → `GamePort`。下一阶段是扩展 `PlatformInboundMessage`（回复链、媒体、线程）与把发送结果/健康态暴露到 `status`。

### 5.5 Telegram 适配器的落地取舍

`src/platforms/telegram.ts` 已按上面的契约实现 Telegram Bot API，并把本文提到的几个「平台细节」下沉到适配器：

| 本文结论 | Telegram 落地 |
| --- | --- |
| 连接是长驻任务，停止要能中断 | `start()` 里跑 `run()` 长轮询循环；`stop` / `ctx.signal` 组合成 `AbortSignal` 中断在途 `getUpdates` 与退避 `sleep` |
| 重连退避放框架层（此处先留在适配器） | 指数退避 + 抖动（`reconnectMinMs` / `reconnectMaxMs` / `reconnectMaxAttempts`）；401/404 直接停止并给出可操作日志 |
| 同一 bot 只允许一个长轮询者 | 对应 OpenClaw 的 polling lease：不引入本地租约，而是检测 409 后自动 `deleteWebhook` 一次，仍冲突则退避 10 秒（同一 token 双实例最终会互相抢） |
| 入站先归一化，鉴权/去重先于业务 | 文本 / caption + 媒体占位；`chat_id:message_id` 作为入站 id（Telegram 的 `message_id` 只在会话内唯一），白名单在归一化之后、`ctx.inbound` 之前 |
| 出站要表达分片、线程、媒体、限流 | `maxLength`（UTF-16 安全分片）+ `parse_mode=HTML` 转义；论坛群记住 `message_thread_id`（General id=1 省略）；媒体复用 `file_id`；`sendIntervalMs` 节流、429 读 `retry_after`、5xx 退避 |
| 平台故障不能拖垮其他平台 | 出站队列独立、单条失败只记 warn；分发层仍只调同步 `deliver` |
| 目标 + 载荷 + 送达结果 | 暂未改契约：适配器内部重试并记录，`status` 仍只有 `queued/delivered/failed/dropped`（§5.4 第 1、2 条仍是下一步） |

与 QQ 适配器的差异：Telegram 不需要「先上传素材」就能跨会话转发媒体（`file_id` 由同一 bot 持有），因此群/私聊镜像比 QQ 的 Markdown/富媒体转存链路短；反过来，Telegram 没有 QQ 的被动回复额度模型，限流主要靠本地 `sendIntervalMs` 与 429 响应。

### 5.6 跨平台同步：`relay` 作为可选能力

QQ、Telegram 与 Discord 各自内部的群↔私聊镜像（`syncChannels`）只解决「同一平台内两个会话」的互通，不能让三个平台互相看到消息。跨平台同步因此单独做一条边，判定收敛在内核：

- 内核（`ChatBridge.handleInbound`）在去重、截断之后，把同一条入站消息投给**除来源平台之外、实现了 `relay` 的平台**；来源平台由 `PlatformDispatcher.relay` 按 `platform.id` 排除。
- `relay` 是可选方法：`log` / `null` 不实现，就自然收不到转发；QQ / Telegram / Discord 实现后自动接入，内核不需要按平台 id 特判。这与 OpenClaw/Hermes 的「适配器之间两两对接」不同，新平台只要实现一个方法就能参与全互连。
- 转发只写适配器自己的出站队列，**不回流 `ctx.inbound`**：入站路径只走一次，qq → telegram → qq 的环不存在，也不需要依赖平台侧回声窗口。
- 跨平台不做媒体搬运：QQ 的图片要先转存 `qqbot-media://`，Telegram 的 `file_id` 只对同一个 bot 有效，Discord 的附件是临期签名 URL；三种句柄互不通用。正文里的 `[图片]` / `[视频]` 等占位原样保留，让接收方知道原消息带媒体。
- 文本格式由 `src/platform-kit/format.ts` 的 `formatRelay` 统一：`[QQ 群] 昵称: 消息` / `[Telegram 私聊] 昵称: 消息` / `[Discord 群] 昵称: 消息`，接收方一眼看出说话的平台与场所。
- 与 `inbound` 解耦：关掉入站只影响「平台 → 游戏」，平台之间仍同步；`crossPlatform=false` 则只保留游戏与各平台的双向，平台之间不串。
- 计费影响：双向全转发会让发送量翻倍，需对照 QQ 主动消息频控（1000 条/天/群）、Telegram 约 20 条/分钟/群的限制与 Discord 的 Gateway/REST 限流；高频服务器可只保留 `chat` 类别或关闭 `crossPlatform`。

### 5.7 私聊同步：顶层开关 + 适配器并集

群↔私聊镜像与跨平台同步都建立在「这条私聊已经进得来」之上；此前私聊默认被各平台的 `allowPrivate=false` 挡在适配器门口，装完插件的人收不到私聊，还要自己去翻各平台自己的开关。

- 顶层 `privateSync`（默认 `false`）一次决定所有已选平台：安装向导里只问一次「同步私聊消息」，不再按平台分别问，也不按平台 id 特判。
- 下发路径是 `PlatformCreateOptions.private`，适配器用 `settings.allowPrivate || private`（取并集）判定。选并集而不是覆盖，是为了不把平台里显式打开的 `allowPrivate` 关掉；全局关掉时也仍是「按平台配置」的旧语义。
- 它是**创建选项**而非运行期字段：`dispatcherUnchanged` 比较 `privateSync`，变化即重建适配器，否则适配器会一直按旧值拒收私聊。
- 私聊进来后不区分对待：与新消息同一条链路，参与注入游戏、镜像与跨平台转发，因此不新增第二条判定路径。

### 5.8 Discord 适配器的落地取舍

`src/platforms/discord.ts` 用 **Bot Gateway（出站 WebSocket）+ REST API v10**，不复用 Webhook：插件跑在宿主沙箱里，没有公网入口。与本文结论的对应：

| 本文结论 | Discord 落地 |
| --- | --- |
| 连接是长驻任务，停止要能中断 | Hello → Identify → 心跳；`stop` / `ctx.signal` 组合成 `AbortSignal` 中断网关、心跳与退避等待 |
| 重连退避放框架层（此处先留在适配器） | 指数退避 + 抖动；优先 op 6 Resume（`session_id` + `seq`），`4007` / `4009` 清 session 重新 Identify，`4004` / `4010`–`4014` 致命停止 |
| 同一 bot 只允许一个连接 | 单分片单连接；Gateway 返回 `4010` / `4011` 时停止并说明「超出单分片」 |
| 入站先归一化，鉴权/去重先于业务 | `MESSAGE_CREATE` → `PlatformInboundMessage`；`message_id` 全局唯一直接作入站 id；`guilds` / `groups` / `allowedUsers` 白名单在归一化之后、`ctx.inbound` 之前 |
| 出站要表达分片、线程、媒体、限流 | `maxLength` 码点分片（默认 1900）、`allowed_mentions: {parse: []}`、`sendIntervalMs` 节流；429 读 `retry_after`，5xx/网络错误退避，401/403/404 不重试 |
| 目标 + 载荷 + 送达结果 | 与 QQ / Telegram 相同：契约仍是同步 `deliver`，适配器内部队列重试；`status` 计数口径不变 |
| 平台故障不能拖垮其他平台 | 出站队列与 Gateway 循环各自收口，单条失败只记 warn |

会话映射与其他平台不同的一点：频道（`channel_id`）对应 `group`，DM 频道对应 `private`。`privateUsers` 配置的是 **user id**，发送前经 `POST /users/@me/channels`（`recipient_id`）换成 DM `channel_id` 并缓存；学习到的私聊目标已经是 DM `channel_id`。入站媒体在文本里保留 `[图片]` 等占位，`forwardMedia` 只把图片 URL 作为 embed 立即镜像，不下载/上传，因此跨平台转发仍只带文本。

---

## 6. 对两套实现的评价（用于选型参考）

- **OpenClaw 更适合「一个进程托管很多渠道、每个渠道多账号」**：能力位拆得细，账户/状态/安全/线程都是独立适配器，监管器成熟（重启预算、稳定窗口、手动停止抑制、健康监控交接）。代价是契约面积大，新平台要理解很多可选位。
- **Hermes 更适合「插件作者零改核心」**：`PlatformEntry` + `plugin.yaml` + 延迟物化 + 依赖探测/安装，扩展成本最低；重连 watcher 的「可重试失败无限自愈 + NEEDS_ATTENTION 只告警」是很实用的运维取舍。代价是 `BasePlatformAdapter` 本体很大（约 4600 行），平台细节容易继续堆进 adapter。
- **两者共同的可复用结论**：
  - 连接是长驻任务，停止要能中断；
  - 重连退避放框架层，参数可配；
  - 入站先归一化，鉴权/去重/会话键先于业务；
  - 出站要能表达分片、线程、媒体、限流与部分失败；
  - 平台故障不能拖垮其他平台。

---

## 7. 后续可做的验证

- **OpenClaw 仍待补全**：`git sparse-checkout set src/channels src/gateway extensions/telegram` 的 promisor fetch 多次被网络重置（`curl 55 Send failure` / `Failed to connect`）。待网络稳定后重试；若 `.git/index.lock` 或 `sparse-checkout.lock` 残留，先确认没有 git 进程再删除。当前结论已由 GitHub API 快照覆盖核心路径。
- **Hermes 已可本地复核**：`C:\Space\Projects\hermes-agent` 的 `gateway`、`plugins/platforms`、`hermes_platform` 已检出，可直接全文检索本文提到的符号与行号。
- 若要落地新的真实平台，先选一个协议简单的做「最小适配器」，验证 `deliver` 结果语义与重连策略，再决定是否把监管上收。Telegram、Discord 都已按该思路落地，可分别对照 `src/platforms/telegram.ts` / `src/platforms/discord.ts`。
- QQ 官方机器人（API v2）的实现位于 `src/platforms/qq.ts`，并在 `scripts/real-host-check.mjs` 用真实 HTTP OpenAPI + WebSocket Gateway 假服务端做过协议级验证；真实 QQ 端联调需要用户提供 AppID/ClientSecret 与机器人环境。
- Telegram 的实现位于 `src/platforms/telegram.ts`，用 `getUpdates` 长轮询（沙箱无公网入口，不用 webhook），offset 持久化到宿主 KV；`test/telegram.test.ts` 以真实 HTTP 假 Bot API（含长轮询挂起 / 唤醒）覆盖入站归一化、白名单、群私聊镜像、媒体 `file_id`、论坛话题、429 重试、offset 重启与 401/409 处理。真实联调需要用户提供 @BotFather 的 bot token 与机器人环境。
- Discord 的实现位于 `src/platforms/discord.ts`，用出站 Bot Gateway + REST v10（不用 Webhook / Interactions Endpoint）；`test/discord.test.ts` 以真实 HTTP 假 REST + WebSocket 假 Gateway 覆盖 Identify、频道/私聊入站、白名单、learned targets、DM 解析、分片、镜像与图片 embed、`relay`、429 重试、401 停止与关闭码分支。真实联调需要用户提供 Developer Portal 的 bot token，并打开 Message Content Intent。
- 官方协议参考：`bot.q.qq.com` 的 API 调用指南、消息收发概述、WebSocket 方式与 `GROUP_AT_MESSAGE_CREATE` / `GROUP_MESSAGE_CREATE` 事件；实现细节可对照 Hermes `plugins/platforms/qqbot/adapter.py` 与 OpenClaw 的 `qqbot` 通道。Discord 参考 `discord.com/developers/docs` 的 Gateway 生命周期、op 2/6/10/11 与 REST 限流说明。
- 补全 OpenClaw 后，重点核对 `ChannelManager` 的完整状态机（暂停/恢复、重启交接、关闭顺序）与 health monitor 的交接分支，这些在本文只覆盖了主路径。