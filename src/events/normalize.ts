/**
 * 事件负载校验与归一化
 *
 * 宿主事件是外部输入：字段缺失、类型漂移都可能发生。这里用 zod 校验，
 * 校验失败记一条 warn 并丢弃，不让单条坏事件打断整条事件队列。
 *
 * 线格式（`docs/plugins.md` 附录 A）：`server` 与 `at` 在**信封顶层**，
 * 由 SDK 转成 `EventMeta`；`data` 里只有 `chat:message` / `console:line`
 * 自带 `at`，其它事件不带。因此 `data.server` 不是契约的一部分——真实宿主
 * 从不发送它，把它当必填会让所有事件被判为 invalid。
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

/** 聊天：`{from, text, at}`，`server` 可能在 `data` 里（旧形状）也可能只在 meta */
const chatPayload = z.object({
  server: z.string().optional(),
  from: z.string(),
  text: z.string(),
  at: z.string().optional(),
});

/** 控制台行：`{line, at}` */
const consolePayload = z.object({
  server: z.string().optional(),
  line: z.string(),
  at: z.string().optional(),
});

/** 玩家进出：`{player}`，不带 `at`、不带 `server` */
const playerPayload = z.object({
  server: z.string().optional(),
  player: z.string(),
  at: z.string().optional(),
});

/** 生命周期事件只有 `name`；服务器名在信封顶层 */
const lifecyclePayload = z.object({
  name: z.string().optional(),
  server: z.string().optional(),
});

export type NormalizeResult =
  | { readonly kind: "message"; readonly draft: MessageDraft; readonly projection?: boolean }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

/** 统一成 RFC3339 UTC；依次尝试事件自带值、`meta.at`，都失败才用当前时间 */
function isoAt(value: unknown, fallback: unknown): string {
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

/** 服务器名：`data.server`（旧形状）→ 信封 `meta.server` → `"unknown"` */
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
      if (result.kind === "skip") {
        return { kind: "skip", reason: result.reason };
      }
      return result.projection === true
        ? { kind: "message", draft: result.draft, projection: true }
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
        draft: classifyPlayer(
          kind,
          parsed.data.player,
          serverOf(parsed.data.server, meta),
          isoAt(parsed.data.at, meta.at),
        ),
      };
    }

    case "server:starting":
    case "server:started":
    case "server:stopped":
    case "server:crashed": {
      const parsed = lifecyclePayload.safeParse(data);
      // 信封顶层 server 与 data.name 在真实宿主里是同一次事件的两种投影
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