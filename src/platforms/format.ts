/**
 * 出站文本格式（各平台共用）
 *
 * 平台适配器只决定「怎么发」，不决定「长什么样」：玩家聊天统一是
 * `[玩家名]:消息`，其他类别用中文标签，保证 QQ / Telegram 两边看到的内容
 * 一致。分片也放在这里，避免每个适配器各写一份切分逻辑。
 */

import type { MessageCategory, NormalizedMessage } from "../core/types.js";

const CATEGORY_LABELS: Record<MessageCategory, string> = {
  chat: "聊天",
  command: "命令",
  join: "加入",
  leave: "离开",
  system: "系统",
  warning: "警告",
  error: "错误",
  death: "死亡",
  advancement: "进度",
  other: "其他",
};

/**
 * 出站格式。
 *
 * 玩家聊天严格使用 `[玩家名]:消息`；其他类别用中文类别标签，避免把
 * 「加入了游戏」渲染成 `[Alex]:加入了游戏` 这种歧义句式。
 */
export function formatOutbound(message: NormalizedMessage): string {
  const text = message.text.replace(/\r?\n/g, " ").trim();
  if (text === "") {
    return "";
  }
  if (message.category === "chat" && message.from !== null) {
    return `[${message.from}]:${text}`;
  }
  const label = CATEGORY_LABELS[message.category];
  return message.from === null ? `[${label}] ${text}` : `[${label}] ${message.from}: ${text}`;
}

/** 按码点切分，避免把 emoji / 代理对从中间截断 */
export function splitText(text: string, max: number): string[] {
  const points = Array.from(text);
  if (points.length <= max) {
    return [text];
  }
  const chunks: string[] = [];
  for (let index = 0; index < points.length; index += max) {
    chunks.push(points.slice(index, index + max).join(""));
  }
  return chunks;
}