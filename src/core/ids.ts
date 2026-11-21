/**
 * 消息 id：内容摘要
 *
 * 宿主会把同一行控制台输出投影成 `chat:message` 与 `console:line` 两种事件。
 * 结构化事件由分类层直接丢弃重复投影，但跨服务器重启、日志回放等场景仍可能
 * 产生同内容事件；用内容摘要做去重键比自增序号更稳，也不依赖时钟。
 */

import { createHash } from "node:crypto";

import type { MessageDraft } from "./types.js";

/** 16 字符的稳定 id（base64url，足以在环形缓存内避免碰撞） */
export function messageId(draft: MessageDraft): string {
  const digest = createHash("sha256");
  for (const part of [
    draft.source,
    draft.server,
    draft.at,
    draft.from ?? "",
    draft.text,
    draft.raw ?? "",
  ]) {
    digest.update(part);
    digest.update("\u0000");
  }
  return digest.digest("base64url").slice(0, 16);
}