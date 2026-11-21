/**
 * 分发层：每个平台一条有界环形队列 + 一个串行消费者
 *
 * 设计取舍：
 * - 平台之间互不阻塞：慢平台只堆自己的队列，不影响采集与其他平台。
 * - 队列有界：满了丢最旧（聊天桥宁可丢旧消息，也不能让内存无界增长）。
 *   用固定大小的环形缓冲实现，丢最旧与写入都是 O(1)，慢消费者不会让
 *   数组无限增长。
 * - 单平台内保序：`deliver` 串行调用，适配器不必自己排队。
 * - 故障隔离：`deliver` 抛错只记日志与计数，不中断消费者。
 */

import type { LogClient } from "mcsup-plugin";

import type { NormalizedMessage } from "../core/types.js";
import type { ChatPlatform } from "../platforms/types.js";

export interface DispatcherOptions {
  /** 每个平台的最大排队数（不含正在投递的那条） */
  readonly capacity: number;
  readonly log: LogClient;
  /** 停止时等待队列排空与 stop 钩子的上限 */
  readonly stopTimeoutMs?: number;
}

/** 单个平台的运行统计 */
export interface PlatformStats {
  readonly id: string;
  readonly title: string;
  readonly queued: number;
  readonly delivered: number;
  readonly failed: number;
  readonly dropped: number;
}

interface Slot {
  readonly platform: ChatPlatform;
  /** 固定长度；`(read + count) % capacity` 是下一个写入位置 */
  readonly buffer: Array<NormalizedMessage | undefined>;
  read: number;
  count: number;
  delivered: number;
  failed: number;
  dropped: number;
  /** 队列空时消费者挂在这里等下一次投递 */
  wake: (() => void) | undefined;
}

export class PlatformDispatcher {
  private readonly slots: Slot[];
  private readonly capacity: number;
  private readonly options: DispatcherOptions;
  private readonly abort = new AbortController();
  private readonly workers: Promise<void>[] = [];
  private running = false;
  private stopping = false;

  public constructor(platforms: readonly ChatPlatform[], options: DispatcherOptions) {
    this.options = options;
    this.capacity = Math.max(1, Math.trunc(options.capacity));
    this.slots = platforms.map((platform) => ({
      platform,
      buffer: new Array<NormalizedMessage | undefined>(this.capacity).fill(undefined),
      read: 0,
      count: 0,
      delivered: 0,
      failed: 0,
      dropped: 0,
      wake: undefined,
    }));
  }

  public async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    const started: ChatPlatform[] = [];
    try {
      for (const slot of this.slots) {
        await slot.platform.start({ log: this.options.log, signal: this.abort.signal });
        started.push(slot.platform);
      }
    } catch (error) {
      // 启动失败要回收已启动的平台，否则桥重试时会留下半开连接
      this.running = false;
      this.abort.abort("platform start failed");
      await Promise.allSettled(
        started.map((platform) => Promise.resolve().then(() => platform.stop("start failed"))),
      );
      throw error;
    }
    for (const slot of this.slots) {
      this.workers.push(this.consume(slot));
    }
  }

  /** 投递一条消息；平台未运行或队列满时按策略丢弃并计数 */
  public deliver(message: NormalizedMessage): void {
    if (!this.running) {
      return;
    }
    for (const slot of this.slots) {
      if (slot.count >= this.capacity) {
        // 丢最旧：把读指针向前推一格，写指针会正好落在被丢弃的槽位上
        slot.buffer[slot.read] = undefined;
        slot.read = (slot.read + 1) % this.capacity;
        slot.count -= 1;
        slot.dropped += 1;
      }
      const write = (slot.read + slot.count) % this.capacity;
      slot.buffer[write] = message;
      slot.count += 1;
      this.wake(slot);
    }
  }

  /** 停止：先排空队列，再 abort 信号并调用平台 stop；都有超时上限 */
  public async stop(reason: string, timeoutMs = this.options.stopTimeoutMs ?? 3_000): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.running = false;
    for (const slot of this.slots) {
      this.wake(slot);
    }

    const drained = await withDeadline(Promise.allSettled(this.workers), timeoutMs);
    if (!drained) {
      this.options.log.warn(`平台队列未在 ${timeoutMs} ms 内排空，剩余 ${this.pending()} 条`);
    }
    this.abort.abort(reason);

    const stopped = await withDeadline(
      Promise.allSettled(
        this.slots.map((slot) => Promise.resolve().then(() => slot.platform.stop(reason))),
      ),
      timeoutMs,
    );
    if (!stopped) {
      this.options.log.warn(`平台 stop 未在 ${timeoutMs} ms 内完成`);
    }
    this.workers.length = 0;
  }

  public stats(): readonly PlatformStats[] {
    return this.slots.map((slot) => ({
      id: slot.platform.id,
      title: slot.platform.title,
      queued: slot.count,
      delivered: slot.delivered,
      failed: slot.failed,
      dropped: slot.dropped,
    }));
  }

  public pending(): number {
    return this.slots.reduce((sum, slot) => sum + slot.count, 0);
  }

  private async consume(slot: Slot): Promise<void> {
    for (;;) {
      while (slot.count > 0) {
        const message = slot.buffer[slot.read];
        slot.buffer[slot.read] = undefined;
        slot.read = (slot.read + 1) % this.capacity;
        slot.count -= 1;
        if (message === undefined) {
          continue;
        }
        try {
          await slot.platform.deliver(message);
          slot.delivered += 1;
        } catch (error) {
          slot.failed += 1;
          this.options.log.warn(
            `[${slot.platform.id}] 投递失败（${message.id}）：${errorText(error)}`,
          );
        }
      }
      if (!this.running) {
        return;
      }
      await new Promise<void>((resolve) => {
        slot.wake = resolve;
      });
      slot.wake = undefined;
    }
  }

  private wake(slot: Slot): void {
    const wake = slot.wake;
    slot.wake = undefined;
    wake?.();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 等 promise 完成；返回是否在上限内完成 */
async function withDeadline(promise: Promise<unknown>, ms: number): Promise<boolean> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, ms);
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}