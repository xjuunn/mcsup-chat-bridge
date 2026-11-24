/**
 * 占位平台：把每条消息写到插件日志
 *
 * 不接任何外部服务，用于本阶段验证「采集 → 分类 → 分发」整条链路；也是
 * 后续 QQ / Telegram 适配器的最小参照实现。
 */

import type { NormalizedMessage } from "../core/types.js";
import type { ChatPlatform, PlatformFactory } from "../platform-kit/types.js";

export interface LogPlatformSettings {
  readonly prefix?: string;
  readonly level?: "info" | "debug";
}

function readSettings(raw: unknown): LogPlatformSettings {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  const level = record["level"];
  return {
    prefix: typeof record["prefix"] === "string" ? record["prefix"] : undefined,
    level: level === "debug" ? "debug" : level === "info" ? "info" : undefined,
  };
}

/** 单行摘要：控制台原文可能很长，这里只保留分类后的文本 */
function format(prefix: string, message: NormalizedMessage): string {
  const from = message.from === null ? "" : `<${message.from}> `;
  const text = message.text.replace(/\s+/g, " ").trim();
  return `[${prefix}] ${message.server} ${message.category} ${from}${text}`;
}

export const logPlatformFactory: PlatformFactory = {
  id: "log",
  title: "本地日志",
  description: "把消息写到插件 stderr；用于调试与最小链路验证",
  create({ log, settings }) {
    const parsed = readSettings(settings);
    const prefix = parsed.prefix ?? "chat-bridge";
    const level: "info" | "debug" = parsed.level ?? "info";
    return {
      id: "log",
      title: "本地日志",
      start(ctx) {
        ctx.log.info(`[${prefix}] 日志平台已就绪`);
      },
      deliver(message) {
        log[level](format(prefix, message));
      },
      stop() {
        log.debug(`[${prefix}] 日志平台已停止`);
      },
    } satisfies ChatPlatform;
  },
};