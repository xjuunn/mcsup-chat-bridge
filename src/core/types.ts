/**
 * 归一化消息模型（架构最底层）
 *
 * 采集层把宿主事件变成这里的一种「事实」；存储层补 `id` / `seq`，分发层
 * 再决定投给哪些聊天平台。本文件不依赖 SDK 运行时，也不依赖插件定义，
 * 便于单测与以后抽出成独立包。
 */

/** 消息类别；配置、op schema 与平台适配器共用同一份枚举 */
export const CATEGORIES = [
  "chat",
  "command",
  "join",
  "leave",
  "system",
  "warning",
  "error",
  "death",
  "advancement",
  "other",
] as const;

export type MessageCategory = (typeof CATEGORIES)[number];

/**
 * 消息来源
 *
 * - `chat`：宿主已解析的结构化聊天（`chat:message`）
 * - `console`：原始控制台行（`console:line`），未命中结构化解析的部分
 * - `event`：玩家加入 / 离开与服务器生命周期事件
 */
export const SOURCES = ["chat", "console", "event"] as const;

export type MessageSource = (typeof SOURCES)[number];

/** 分类结果：存储层负责补 `id` / `seq` */
export interface MessageDraft {
  readonly category: MessageCategory;
  readonly source: MessageSource;
  readonly server: string;
  /** RFC3339 UTC */
  readonly at: string;
  readonly from: string | null;
  readonly text: string;
  /** 原始文本（聊天原文或控制台整行）；生命周期事件为 null */
  readonly raw: string | null;
  /** 命中规则 id，便于观测与后续扩展 */
  readonly rule: string;
}

/** 可直接投递给平台的消息 */
export interface NormalizedMessage extends MessageDraft {
  readonly id: string;
  readonly seq: number;
}

/** 查询条件（`messages` op 用） */
export interface MessageFilter {
  readonly category?: MessageCategory;
  readonly source?: MessageSource;
  readonly server?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** 一页消息，按 `seq` 倒序（最新在前） */
export interface MessagePage {
  readonly items: readonly NormalizedMessage[];
  readonly next?: string;
}