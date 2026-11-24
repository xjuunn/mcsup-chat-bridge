/**
 * 分发层：每个平台一条有界环形队列 + 一个串行消费者
 *
 * 设计取舍：
 * - 平台之间互不阻塞：慢平台只堆自己的队列，不影响采集与其他平台。
 * - 队列有界：满了丢最旧（聊天桥宁可丢旧消息，也不能让内存无界增长）。
 *   用固定大小的环形缓冲实现，丢最旧与写入都是 O(1)，慢消费者不会让
 *   数组无限增长。
 * - 单平台内保序：`deliver` / `relay` 串行调用，适配器不必自己排队。
 * - 故障隔离：`deliver` / `relay` 抛错只记日志与计数，不中断消费者。
 *
 * 两条队列用同一套环形缓冲：`out` 是游戏 → 平台（`NormalizedMessage`），
 * `relay` 是平台 → 平台（`PlatformRelayMessage`）。跨平台转发的队列只
 * 存在于实现了 `relay` 的平台槽位上：日志 / 空平台不实现就压根没有这条
 * 队列，内核不需要按平台 id 特判「谁能接收转发」。
 */

import type { LogClient } from "mcsup-plugin";

import type { NormalizedMessage } from "../core/types.js";
import type {
  ChatPlatform,
  GamePort,
  PlatformInboundMessage,
  PlatformRelayMessage,
} from "../platforms/types.js";

export interface DispatcherOptions {
  /** 每个平台的最大排队数（不含正在投递的那条） */
  readonly capacity: number;
  readonly log: LogClient;
  /** 游戏侧端口；平台启动时注入上下文 */
  readonly game?: GamePort;
  /** 平台收到外部消息后的回调；由桥内核接手 */
  readonly onInbound: (message: PlatformInboundMessage) => void;
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
  /** 跨平台转发：已成功交给适配器 */
  readonly relayed: number;
  /** 跨平台转发：适配器抛错 */
  readonly relayFailed: number;
  /** 跨平台转发：因队列溢出丢弃 */
  readonly relayDropped: number;
}

/** 固定长度的环形缓冲；`(read + count) % capacity` 是下一个写入位置 */
interface Channel<T> {
  readonly buffer: Array<T | undefined>;
  read: number;
  count: number;
  delivered: number;
  failed: number;
  dropped: number;
}

interface Slot {
  readonly platform: ChatPlatform;
  readonly out: Channel<NormalizedMessage>;
  /** 只有实现了 `relay` 的平台才有这条队列 */
  readonly relay: Channel<PlatformRelayMessage> | undefined;
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
      out: createChannel<NormalizedMessage>(this.capacity),
      // 判断依据是「有没有这个方法」，不是平台 id：新增平台只要实现
      // `relay` 就自动接入跨平台同步。
      relay:
        typeof platform.relay === "function"
          ? createChannel<PlatformRelayMessage>(this.capacity)
          : undefined,
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
        await slot.platform.start({
          log: this.options.log,
          signal: this.abort.signal,
          game: this.options.game,
          inbound: this.options.onInbound,
        });
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

  /** 投递一条游戏消息；平台未运行或队列满时按策略丢弃并计数 */
  public deliver(message: NormalizedMessage): void {
    if (!this.running) {
      return;
    }
    for (const slot of this.slots) {
      push(slot.out, message);
      this.wake(slot);
    }
  }

  /**
   * 跨平台转发一条入站消息：投给「除来源平台之外」所有实现了 `relay` 的平台。
   *
   * 返回实际入队的平台数（0 表示没有别的平台能接收）。
   *
   * 不在这里递归：适配器收到的转发只走自己的出站队列，不会再回流到
   * `onInbound`，因此 qq → telegram → qq 的环不存在。
   */
  public relay(message: PlatformRelayMessage): number {
    if (!this.running) {
      return 0;
    }
    let queued = 0;
    for (const slot of this.slots) {
      if (slot.relay === undefined) {
        continue;
      }
      if (slot.platform.id === message.platform) {
        continue;
      }
      push(slot.relay, message);
      this.wake(slot);
      queued += 1;
    }
    return queued;
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
      queued: slot.out.count,
      delivered: slot.out.delivered,
      failed: slot.out.failed,
      dropped: slot.out.dropped,
      relayed: slot.relay?.delivered ?? 0,
      relayFailed: slot.relay?.failed ?? 0,
      relayDropped: slot.relay?.dropped ?? 0,
    }));
  }

  public pending(): number {
    return this.slots.reduce((sum, slot) => sum + slot.out.count + (slot.relay?.count ?? 0), 0);
  }

  private async consume(slot: Slot): Promise<void> {
    for (;;) {
      for (;;) {
        const message = take(slot.out);
        if (message !== undefined) {
          try {
            await slot.platform.deliver(message);
            slot.out.delivered += 1;
          } catch (error) {
            slot.out.failed += 1;
            this.options.log.warn(
              `[${slot.platform.id}] 投递失败（${message.id}）：${errorText(error)}`,
            );
          }
          continue;
        }

        const relayed = take(slot.relay);
        if (relayed !== undefined && slot.relay !== undefined) {
          try {
            await slot.platform.relay?.(relayed);
            slot.relay.delivered += 1;
          } catch (error) {
            slot.relay.failed += 1;
            this.options.log.warn(
              `[${slot.platform.id}] 跨平台转发失败（${relayed.platform}）：${errorText(error)}`,
            );
          }
          continue;
        }
        break;
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

function createChannel<T>(capacity: number): Channel<T> {
  return {
    buffer: new Array<T | undefined>(capacity).fill(undefined),
    read: 0,
    count: 0,
    delivered: 0,
    failed: 0,
    dropped: 0,
  };
}

/** 写入一条；队列满时丢最旧，读指针前移一格让写指针正好落在被丢的槽位 */
function push<T>(channel: Channel<T>, value: T): void {
  const capacity = channel.buffer.length;
  if (channel.count >= capacity) {
    channel.buffer[channel.read] = undefined;
    channel.read = (channel.read + 1) % capacity;
    channel.count -= 1;
    channel.dropped += 1;
  }
  const write = (channel.read + channel.count) % capacity;
  channel.buffer[write] = value;
  channel.count += 1;
}

function take<T>(channel: Channel<T> | undefined): T | undefined {
  if (channel === undefined || channel.count === 0) {
    return undefined;
  }
  const capacity = channel.buffer.length;
  const value = channel.buffer[channel.read];
  channel.buffer[channel.read] = undefined;
  channel.read = (channel.read + 1) % capacity;
  channel.count -= 1;
  return value;
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
