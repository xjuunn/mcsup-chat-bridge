/**
 * 配置 schema 与解析
 *
 * 平台专属配置放在与适配器 id 同名的字段里（如 `log`），桥只负责把该片段
 * 传给工厂。新增平台时在这里加一个字段即可，不需要改分发内核。
 */

import { s } from "mcsup-plugin";
import type { InferSchema } from "mcsup-plugin";

import type { BridgeConfig } from "./core/bridge.js";
import { CATEGORIES } from "./core/types.js";

export const configSchema = s.object({
  platforms: s.optional(
    s.array(s.string({ max: 32 }), {
      maxItems: 16,
      describe: "启用的聊天平台适配器 id；省略时使用 log，空数组表示只采集",
    }),
  ),
  forwardCategories: s.optional(
    s.array(s.enum(CATEGORIES), {
      describe: "转发到平台的类别；省略时转发全部",
    }),
  ),
  consoleForward: s.boolean({
    default: true,
    label: "转发控制台消息",
    describe: "为 false 时仍采集并入库，但不投递到平台",
  }),
  storeSize: s.integer({
    default: 200,
    min: 10,
    max: 5_000,
    label: "缓存条数",
    describe: "内存中保留的最近消息数",
  }),
  queueCapacity: s.integer({
    default: 256,
    min: 8,
    max: 4_096,
    label: "平台队列容量",
    describe: "单个平台积压上限，超出后丢弃最旧消息",
  }),
  log: s.optional(
    s.object(
      {
        prefix: s.string({ default: "chat-bridge", max: 32, label: "日志前缀" }),
        level: s.enum(["info", "debug"], { default: "info", label: "日志级别" }),
      },
      { label: "本地日志平台" },
    ),
  ),
});

/** 宿主下发的配置（已按 schema 解析） */
export type RawConfig = InferSchema<typeof configSchema>;

/** 把宿主配置解析为桥内核使用的配置 */
export function resolveConfig(raw: RawConfig): BridgeConfig {
  const platforms = unique(
    (raw.platforms ?? ["log"]).map((id) => id.trim()).filter((id) => id !== ""),
  );
  const source = raw as unknown as Record<string, unknown>;
  const platformSettings: Record<string, unknown> = {};
  for (const id of platforms) {
    platformSettings[id] = source[id];
  }
  return {
    platforms,
    forwardCategories:
      raw.forwardCategories === undefined
        ? [...CATEGORIES]
        : [...new Set(raw.forwardCategories)],
    consoleForward: raw.consoleForward ?? true,
    storeSize: raw.storeSize ?? 200,
    queueCapacity: raw.queueCapacity ?? 256,
    platformSettings,
  };
}

/** 去重并保持首次出现的顺序 */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}