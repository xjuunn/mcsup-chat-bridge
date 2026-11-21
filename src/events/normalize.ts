/**
 * 事件负载校验与归一化
 *
 * 宿主事件是外部输入：字段缺失、类型漂移都可能发生。这里用 zod 校验，
 * 校验失败记一条 warn 并丢弃，不让单条坏事件打断整条事件队列。
 */

import { z } from "mcsup-plugin";

import {
  classifyChat,
  classifyConsoleLine,
  classifyLifecycle,
  classifyPlayer,
} from "../core/classify.js";
import type { MessageDraft } from "../core/types.js";
import type { EventMeta } from "mcsup-plugin";

const chatPayload = z.object({
  server: z.string(),
  from: z.string(),
  text: z.string(),
  at: z.string(),
});

const consolePayload = z.object({
  server: z.string(),
  line: z.string(),
  at: z.string(),
});

const playerPayload = z.object({
  player: z.string(),
});

/** 生命周期事件只关心服务器名，允许 `name` / `server` 两种历史字段 */
const lifecyclePayload = z.object({
  name: z.string().optional(),
  server: z.string().optional(),
});

export type NormalizeResult =
  | { readonly kind: "message"; readonly draft: MessageDraft }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

/** 统一成 RFC3339 UTC；依次尝试事件自带值、`meta.at`，都失败才用当前时间 */
function isoAt(value: unknown, fallback: string): string {
  for (const candidate of [value, fallback]) {
    if (typeof candidate === "string" && candidate !== "") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return new Date(parsed).toISOString();
      }
    }
  }
  return new Date().toISOString();
}

function serverOf(candidate: unknown, meta: EventMeta): string {
  if (typeof candidate === "string" && candidate !== "") {
    return candidate;
  }
  const fromMeta = meta.server;
  return typeof fromMeta === "string" && fromMeta !== "" ? fromMeta : "unknown";
}

/** 把一个宿主事件转成消息草稿 */
export function normalizeEvent(kind: string, data: unknown, meta: EventMeta): NormalizeResult {
  switch (kind) {
    case "chat:message": {
      const parsed = chatPayload.safeParse(data);
      if (!parsed.success) {
        return { kind: "invalid", reason: "chat:message 负载不符合契约" };
      }
      const server = serverOf(parsed.data.server, meta);
      const at = isoAt(parsed.data.at, meta.at);
      return {
        kind: "message",
        draft: classifyChat({ server, from: parsed.data.from, text: parsed.data.text, at }),
      };
    }

    case "console:line": {
      const parsed = consolePayload.safeParse(data);
      if (!parsed.success) {
        return { kind: "invalid", reason: "console:line 负载不符合契约" };
      }
      const server = serverOf(parsed.data.server, meta);
      const at = isoAt(parsed.data.at, meta.at);
      const result = classifyConsoleLine({ server, line: parsed.data.line, at });
      return result.kind === "skip"
        ? { kind: "skip", reason: result.reason }
        : { kind: "message", draft: result.draft };
    }

    case "player:joined":
    case "player:left": {
      const parsed = playerPayload.safeParse(data);
      if (!parsed.success) {
        return { kind: "invalid", reason: `${kind} 负载不符合契约` };
      }
      return {
        kind: "message",
        draft: classifyPlayer(kind, parsed.data.player, serverOf(undefined, meta), isoAt(undefined, meta.at)),
      };
    }

    case "server:starting":
    case "server:started":
    case "server:stopped":
    case "server:crashed": {
      const parsed = lifecyclePayload.safeParse(data);
      const server = serverOf(
        parsed.success ? (parsed.data.server ?? parsed.data.name) : undefined,
        meta,
      );
      const draft = classifyLifecycle(kind, server, isoAt(undefined, meta.at));
      return draft === null
        ? { kind: "skip", reason: `unhandled lifecycle event: ${kind}` }
        : { kind: "message", draft };
    }

    case "backup:completed":
    case "backup:failed":
      return { kind: "skip", reason: "备份事件不属于聊天桥" };

    default:
      return { kind: "skip", reason: `unhandled event: ${kind}` };
  }
}