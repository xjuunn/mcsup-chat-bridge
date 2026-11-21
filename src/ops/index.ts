/**
 * 查询 op
 *
 * op 只依赖桥内核的读接口，不关心采集与平台细节。`messages` 输出 `items`
 * 数组，descriptor 会推断为 table；`status` 是单对象，推断为 detail。
 */

import { query, s } from "mcsup-plugin";

import type { ChatBridge } from "../core/bridge.js";
import { MAX_PAGE_SIZE } from "../core/store.js";
import { CATEGORIES, SOURCES } from "../core/types.js";

const messageItem = s.object({
  id: s.string({ max: 32 }),
  seq: s.integer({ min: 1 }),
  category: s.enum(CATEGORIES),
  source: s.enum(SOURCES),
  server: s.string(),
  at: s.datetime(),
  from: s.string(),
  text: s.string(),
  rule: s.string({ max: 64 }),
});

const categoryCounts = s.object({
  chat: s.integer({ min: 0 }),
  command: s.integer({ min: 0 }),
  join: s.integer({ min: 0 }),
  leave: s.integer({ min: 0 }),
  system: s.integer({ min: 0 }),
  warning: s.integer({ min: 0 }),
  error: s.integer({ min: 0 }),
  death: s.integer({ min: 0 }),
  advancement: s.integer({ min: 0 }),
  other: s.integer({ min: 0 }),
});

const platformStats = s.object({
  id: s.string(),
  title: s.string(),
  queued: s.integer({ min: 0 }),
  delivered: s.integer({ min: 0 }),
  failed: s.integer({ min: 0 }),
  dropped: s.integer({ min: 0 }),
});

/** 桥尚未就绪时由入口层抛出；这里只要求解析器给出实例 */
export type BridgeResolver = (ctx: object) => ChatBridge;

/** 构造 queries 记录（供 `definePlugin` 回填） */
export function createQueries(resolve: BridgeResolver) {
  return {
    messages: query("messages")
      .title("消息")
      .describe("最近的归一化消息，最新在前；可用类别、来源、服务器过滤")
      .input(
        s.object({
          category: s.optional(s.enum(CATEGORIES, { label: "类别" })),
          source: s.optional(s.enum(SOURCES, { label: "来源" })),
          server: s.optional(s.string({ max: 64, label: "服务器" })),
          cursor: s.optional(s.string({ max: 32, label: "游标" })),
          limit: s.optional(
            s.integer({ default: 50, min: 1, max: MAX_PAGE_SIZE, label: "每页条数" }),
          ),
        }),
      )
      .output(
        s.object({
          items: s.array(messageItem),
          next: s.optional(s.string()),
        }),
      )
      .pagination({
        cursorField: "cursor",
        limitField: "limit",
        defaultLimit: 50,
        maxLimit: MAX_PAGE_SIZE,
      })
      .display({ type: "table" })
      .run((input, ctx) => {
        const page = resolve(ctx).recent({
          category: input.category,
          source: input.source,
          server: input.server,
          cursor: input.cursor,
          limit: input.limit,
        });
        return {
          items: page.items.map((message) => ({
            id: message.id,
            seq: message.seq,
            category: message.category,
            source: message.source,
            server: message.server,
            at: message.at,
            from: message.from ?? "",
            text: message.text,
            rule: message.rule,
          })),
          ...(page.next === undefined ? {} : { next: page.next }),
        };
      }),

    status: query("status")
      .title("运行状态")
      .describe("采集、过滤、入库与各平台的投递统计")
      .output(
        s.object({
          started: s.boolean(),
          uptimeSecs: s.integer({ min: 0 }),
          accepted: s.integer({ min: 0 }),
          duplicates: s.integer({ min: 0 }),
          skipped: s.integer({ min: 0 }),
          filtered: s.integer({ min: 0 }),
          stored: s.integer({ min: 0 }),
          categories: categoryCounts,
          platforms: s.array(platformStats),
        }),
      )
      .display({ type: "detail" })
      .run((_input, ctx) => {
        const status = resolve(ctx).status();
        return {
          ...status,
          categories: { ...status.categories },
          platforms: status.platforms.map((platform) => ({ ...platform })),
        };
      }),
  };
}