/**
 * 聊天平台契约（可插拔点）
 *
 * 平台适配器只实现 `ChatPlatform` 就能接入：桥内核不关心它连的是 QQ、
 * Telegram 还是本地日志。适配器自己维护连接、重连与限流；内核只保证
 * 消息顺序、单平台故障隔离与有界队列。
 */

import type { LogClient } from "mcsup-plugin";

import type { NormalizedMessage } from "../core/types.js";

/** 创建适配器时的依赖：日志 + 配置里与适配器 id 同名的片段 */
export interface PlatformCreateOptions {
  readonly log: LogClient;
  /** `config[<id>]`；未配置时为 undefined */
  readonly settings: unknown;
}

/** 启动后的上下文；`signal` 在桥停止时 abort */
export interface PlatformContext {
  readonly log: LogClient;
  readonly signal: AbortSignal;
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