/**
 * 聊天平台契约（可插拔点）
 *
 * 平台适配器只实现 `ChatPlatform` 就能接入：桥内核不关心它连的是 QQ、
 * Telegram 还是本地日志。适配器自己维护连接、重连与限流；内核只保证
 * 消息顺序、单平台故障隔离与有界队列。
 *
 * 链路分三条边：
 * - 出站：`deliver(NormalizedMessage)`，由内核串行调用。
 * - 入站：适配器收到外部消息后调用 `PlatformContext.inbound(...)`，
 *   由内核做去重、排队并通过 `GamePort` 注入游戏。
 * - 跨平台：内核把入站消息转给「其它实现了 `relay` 的平台」，
 *   适配器只负责把已格式化的文本发给自己的会话目标，不知道有谁订阅。
 *
 * `relay` 是可选能力：本地日志 / 空平台不需要接收转发，就不实现它，
 * 内核按「有没有这个方法」决定投不投，不需要按平台 id 特判。
 *
 * 新增平台的完整步骤见 `docs/adding-a-platform.md`：解析配置复用
 * `shared/values.ts`，退避与等待复用 `shared/runtime.ts`，出站目标与队列
 * 复用 `shared/outbound.ts`（`TargetBook` / `OutboundQueue`），适配器只负责
 * 协议本身。契约断言是 `test/helpers/platform-contract.ts`。
 */

import type { LogClient } from "mcsup-plugin";

import type { KvLike } from "../core/targets.js";
import type { NormalizedMessage } from "../core/types.js";

/** 创建适配器时的依赖：日志 + 配置里与适配器 id 同名的片段 + 宿主 KV */
export interface PlatformCreateOptions {
  readonly log: LogClient;
  /** `config[<id>]`；未配置时为 undefined */
  readonly settings: unknown;
  /**
   * 宿主 `storage:kv`；未授予时为 undefined。
   *
   * 适配器用它记住「见过的会话」这类跨重启需要保留的小状态。缺省时退化为
   * 进程内记忆，不阻塞启动。
   */
  readonly kv?: KvLike;
  /**
   * 是否接收私聊（全局 `privateSync`，默认 false）。
   *
   * 内核下发给每个适配器，打开后等于对每个平台都设 `allowPrivate=true`：
   * 安装向导问一次就能同时打开 QQ 与 Telegram 的私聊。适配器自己的
   * `allowPrivate` 仍然有效，两者取并集。
   */
  readonly private?: boolean;
}

/** 入站消息的通道：群聊或私聊 */
export interface PlatformChannel {
  readonly kind: "group" | "private";
  readonly id: string;
  readonly name?: string;
}

/** 入站消息的发送者 */
export interface PlatformAuthor {
  readonly id: string;
  readonly name: string;
}

/**
 * 平台 → 游戏的消息。
 *
 * 平台适配器只负责把原生事件翻译成这个形状；是否允许进入游戏、如何排队、
 * 失败后如何计数，都由桥内核统一处理，避免每个平台各写一套。
 */
export interface PlatformInboundMessage {
  /** 平台 id，与 `ChatPlatform.id` 一致 */
  readonly platform: string;
  readonly channel: PlatformChannel;
  readonly author: PlatformAuthor;
  readonly text: string;
  /** 平台消息 id；用于跨重连去重，可省略 */
  readonly messageId?: string;
  /** RFC3339 UTC；省略时由内核补当前时间 */
  readonly at?: string;
  /** 平台侧配置的默认服务器；省略时由内核按配置/运行状态选择 */
  readonly server?: string;
  /** 游戏内展示前缀，默认取平台 id 的大写形式 */
  readonly label?: string;
  /**
   * 是否注入游戏；默认 true。
   *
   * 平台自己的 `inbound` 开关（如 `qq.inbound`）会把它设成 false，
   * 内核仍会按需把这条消息转给其它平台。全局 `inbound` 是另一层开关。
   */
  readonly inject?: boolean;
}

/**
 * 注入游戏的方式：
 * - `tellraw`：游戏内只显示插件自己的标签（如 `[QQ]`），不写服务器日志；
 * - `say`：会写进服务器 `logs/latest.log`，但游戏内会多一个 `[Server]` 前缀。
 */
export type InjectMode = "tellraw" | "say";

/**
 * 游戏侧端口。
 *
 * 内核不直接依赖 MCSUP 的能力客户端；入口层（`src/index.ts`）把
 * `console:write` / `server:read` 适配成这个接口，测试可以注入假实现。
 */
export interface GamePort {
  /** 向指定服务器注入一条聊天消息（实现负责安全转义与广播） */
  sendChat(server: string, text: string, mode?: InjectMode): Promise<void>;
  /** 选择服务器：优先用 `preferred`，否则按运行状态挑一个；无可用时返回 null */
  resolveServer(preferred?: string): Promise<string | null>;
}

/** 启动后的上下文；`signal` 在桥停止时 abort */
export interface PlatformContext {
  readonly log: LogClient;
  readonly signal: AbortSignal;
  /** 游戏侧端口；未授予 `console:write` 时为 undefined */
  readonly game?: GamePort;
  /** 平台收到外部消息后调用；内核负责后续处理 */
  inbound(message: PlatformInboundMessage): void;
}

/**
 * 供其它平台转发的入站消息（跨平台同步用）。
 *
 * 与 `NormalizedMessage`（游戏 → 平台）无关：来源是另一个聊天平台，
 * `source` 是来源平台的显示名（`QQ` / `Telegram`），`channel` 决定前缀
 * `[群]` / `[私聊]`。内核只保证「投给除来源平台之外的每个平台一次」，
 * 具体发给哪些会话、怎么分片、怎么限流由各适配器自己决定。
 */
export interface PlatformRelayMessage {
  /** 来源平台 id：内核据此排除来源，避免把消息发回发源地 */
  readonly platform: string;
  /** 来源平台显示名，用于拼 `[QQ]` / `[Telegram]` 前缀 */
  readonly source: string;
  readonly channel: PlatformChannel;
  readonly author: PlatformAuthor;
  /** 已归一化的正文（不含平台前缀，`[图片]` 这类占位保留） */
  readonly text: string;
  /** 平台消息 id，便于日志定位 */
  readonly messageId?: string;
  /** RFC3339 UTC */
  readonly at?: string;
}

/**
 * 一个已创建的聊天平台实例
 */
export interface ChatPlatform {
  /** 与适配器 id 相同 */
  readonly id: string;
  readonly title: string;
  start(ctx: PlatformContext): void | Promise<void>;
  /** 内核保证同一平台内按到达顺序串行调用 */
  deliver(message: NormalizedMessage): void | Promise<void>;
  /**
   * 可选：接收「别的平台」发来的消息并转发到自己的会话目标。
   *
   * 不实现这个方法就永远收不到跨平台转发（日志 / 空平台即如此）。
   * 实现方必须自己排除来源会话、自己处理限流与分片；内核只保证
   * 同一平台内顺序，以及不会把消息投回来源平台。
   */
  relay?(message: PlatformRelayMessage): void | Promise<void>;
  stop(reason: string): void | Promise<void>;
}

/** 工厂：注册表里的静态描述 + 实例化逻辑 */
export interface PlatformFactory {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  create(options: PlatformCreateOptions): ChatPlatform;
}

/** 供 `status` / 运维查询的静态信息 */
export interface PlatformInfo {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}