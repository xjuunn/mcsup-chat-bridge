/**
 * 消息环形缓存
 *
 * 采集与查询共用同一份内存事实，不持久化：事件语义是「触发」，需要历史时
 * 由插件进程自己保留最近的窗口。容量小、写入频繁，用「数组 + 头指针」做
 * 淘汰，避免每次超限都 `shift()` 搬整个数组。
 *
 * 文本字段在入库时截断：控制台行最长可达帧上限（1 MB），若原样保留，
 * `storeSize=5000` 时内存会失控；截断也让 `messages` 的结果帧保持在宿主
 * 限额内。
 */

import { messageId } from "./ids.js";
import {
  CATEGORIES,
  type MessageCategory,
  type MessageDraft,
  type MessageFilter,
  type MessagePage,
  type NormalizedMessage,
} from "./types.js";

/** 单页上限（与 op 的 maxLimit 一致） */
export const MAX_PAGE_SIZE = 200;

/** 入库文本上限。按 UTF-8 最坏情况（CJK 3 字节/字符）估算：
 * 200 条 × 1000 字符 ≈ 600 KB，加上其余字段仍低于宿主 1 MB 帧上限。 */
export const MAX_TEXT = 1_000;

/** 原始行上限；仅内部与平台可见，比 `text` 宽松 */
export const MAX_RAW = 4_000;

/** 服务器名 / 发送者 / 规则 id 上限 */
const MAX_NAME = 64;
const MAX_RULE = 64;

/** 截断并标记，便于消费方看出内容不完整 */
function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

export class MessageStore {
  private readonly buffer: NormalizedMessage[] = [];
  private readonly ids = new Set<string>();
  private readonly counters = new Map<MessageCategory, number>();
  /** 逻辑起点；物理数组只在累积到一定量时压缩 */
  private head = 0;
  private capacity: number;
  private nextSeq = 1;

  public constructor(capacity: number) {
    this.capacity = Math.max(1, Math.trunc(capacity));
  }

  /** 调整容量，超出部分从最旧开始淘汰 */
  public resize(capacity: number): void {
    this.capacity = Math.max(1, Math.trunc(capacity));
    this.trim();
  }

  /**
   * 写入一条消息；重复（同内容摘要）返回 null。
   *
   * 只有真正入库才分配 `seq`，查询游标因此稳定。去重使用截断前的原文，
   * 避免两条长文本因尾部被截掉而误判为同一条。
   */
  public add(draft: MessageDraft): NormalizedMessage | null {
    const id = messageId(draft);
    if (this.ids.has(id)) {
      return null;
    }
    const message: NormalizedMessage = {
      ...draft,
      id,
      seq: this.nextSeq,
      server: clip(draft.server, MAX_NAME),
      from: draft.from === null ? null : clip(draft.from, MAX_NAME),
      text: clip(draft.text, MAX_TEXT),
      raw: draft.raw === null ? null : clip(draft.raw, MAX_RAW),
      rule: clip(draft.rule, MAX_RULE),
    };
    this.nextSeq += 1;
    this.ids.add(id);
    this.buffer.push(message);
    this.counters.set(draft.category, (this.counters.get(draft.category) ?? 0) + 1);
    this.trim();
    return message;
  }

  /** 最近消息，最新在前；`cursor` 是上一页最后一条的 `seq` */
  public recent(filter: MessageFilter = {}): MessagePage {
    const limit = normalizeLimit(filter.limit);
    const cursor = filter.cursor === undefined ? Number.NaN : Number.parseInt(filter.cursor, 10);
    const upper = Number.isInteger(cursor) && cursor > 0 ? cursor : Number.POSITIVE_INFINITY;
    const items: NormalizedMessage[] = [];
    let next: string | undefined;
    let lastSeq: number | undefined;

    for (let i = this.buffer.length - 1; i >= this.head; i -= 1) {
      const message = this.buffer[i];
      if (message === undefined) {
        continue;
      }
      if (message.seq >= upper) {
        continue;
      }
      if (filter.category !== undefined && message.category !== filter.category) {
        continue;
      }
      if (filter.source !== undefined && message.source !== filter.source) {
        continue;
      }
      if (filter.server !== undefined && message.server !== filter.server) {
        continue;
      }
      if (items.length >= limit) {
        next = String(lastSeq ?? 0);
        break;
      }
      items.push(message);
      lastSeq = message.seq;
    }

    return next === undefined ? { items } : { items, next };
  }

  /** 生命周期累计计数（不受环形淘汰影响） */
  public counts(): Record<MessageCategory, number> {
    const out = {} as Record<MessageCategory, number>;
    for (const category of CATEGORIES) {
      out[category] = this.counters.get(category) ?? 0;
    }
    return out;
  }

  public get size(): number {
    return this.buffer.length - this.head;
  }

  public clear(): void {
    this.buffer.length = 0;
    this.head = 0;
    this.ids.clear();
    this.counters.clear();
  }

  private trim(): void {
    const excess = this.buffer.length - this.head - this.capacity;
    if (excess > 0) {
      const end = this.head + excess;
      for (let i = this.head; i < end; i += 1) {
        const evicted = this.buffer[i];
        if (evicted !== undefined) {
          this.ids.delete(evicted.id);
        }
      }
      this.head = end;
    }
    // 头指针长期增长后一次性压缩，摊还成本 O(1)；阈值取 1024 与容量的较大者，
    // 小缓存也能及时回收，大缓存避免频繁搬运。
    if (this.head >= 1_024 || (this.head > 0 && this.head * 2 >= this.buffer.length)) {
      this.buffer.splice(0, this.head);
      this.head = 0;
    }
  }
}

/** 非数字 / 负数 / NaN 一律按默认值；上限仍受 `MAX_PAGE_SIZE` 约束 */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return 50;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}