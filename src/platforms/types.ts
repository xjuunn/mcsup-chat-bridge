/**
 * 聊天平台契约（可插拔点）
 *
 * 平台适配器只实现 `ChatPlatform` 就能接入：桥内核不关心它连的是 QQ、
 * Telegram 还是本地日志。适配器自己维护连接、重连与限流；内核只保证
 * 消息顺序、单平台故障隔离与有界队列。
 *
 * 双向链路分两条边：
 * - 出站：`deliver(NormalizedMessage)`，由内核串行调用。
 * - 入站：适配器收到外部消息后调用 `PlatformContext.inbound(...)`，
 *   由内核做去重、排队并通过 `GamePort` 注入游戏。
 */

import type { LogClient } from "mcsup-plugin";

import type { NormalizedMessage } from "../core/types.js";

/** 创建适配器时的依赖：日志 + 配置里与适配器 id 同名的片段 */
export interface PlatformCreateOptions {
  readonly log: LogClient;
  /** `config[<id>]`；未配置时为 undefined */
  readonly settings: unknown;
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
}

/**
 * 游戏侧端口。
 *
 * 内核不直接依赖 MCSUP 的能力客户端；入口层（`src/index.ts`）把
 * `console:write` / `server:read` 适配成这个接口，测试可以注入假实现。
 */
export interface GamePort {
  /** 向指定服务器注入一条聊天消息（实现负责安全转义与广播） */
  sendChat(server: string, text: string): Promise<void>;
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

/** 一个已创建的聊天平台实例 */
export interface ChatPlatform {
  /** 与适配器 id 相同 */
  readonly id: string;
  readonly title: string;
  start(ctx: PlatformContext): void | Promise<void>;
  /** 内核保证同一平台内按到达顺序串行调用 */
  deliver(message: NormalizedMessage): void | Promise<void>;
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