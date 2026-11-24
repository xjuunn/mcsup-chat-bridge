/**
 * 入站消息 id 的去重窗口（各平台共用）
 *
 * 平台的重连 / 重投会重复推送同一条消息；内核还会按 `platform:messageId`
 * 再兜一层，但适配器这一层成本更低——重复消息不会进入格式化与注入流程。
 *
 * 淘汰口径是「最旧先丢」：`Map` 保持插入顺序，超过上限删第一个键。
 * 只记忆 id、不记忆内容，1000 条的规模只有几十 KB。
 */

/** 默认窗口：最近 1000 条消息 id */
export const DEFAULT_SEEN_LIMIT = 1_000;

export class MessageSeen {
  private readonly seen = new Map<string, number>();

  public constructor(private readonly limit: number = DEFAULT_SEEN_LIMIT) {}

  /** 是否已经见过（用于「收到即返回」的入口判断） */
  public has(id: string): boolean {
    return this.seen.has(id);
  }

  /** 记住一条消息 id；超过窗口时丢最旧 */
  public remember(id: string): void {
    this.seen.set(id, Date.now());
    if (this.seen.size > this.limit) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) {
        this.seen.delete(oldest.value);
      }
    }
  }

  /** 窗口内条数 */
  public get size(): number {
    return this.seen.size;
  }
}