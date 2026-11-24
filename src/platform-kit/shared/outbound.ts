/**
 * 出站目标与出站队列（各平台共用）
 *
 * 适配器之间真正相同的不是协议，而是「发给谁、按什么顺序发、失败怎么办」：
 * - 目标留空 = 全部：显式配置优先，否则发给收到过消息的会话；
 * - 串行发送，同一平台内保序；
 * - 单目标失败只计数，全部失败才算一条消息失败；
 * - 积压有上限，超限丢最旧，避免断线期间无限堆积。
 *
 * 新增平台时只需要提供 `send(target, pending)`（以及可选的 `prepare`，
 * 用于发送前一次性准备，如 QQ 把图片转存平台素材库），其余行为由这里统一，
 * 不同平台不会各自演化出不同的失败语义。
 */

import type { LogClient } from "mcsup-plugin";

import type { LearnedTargets } from "../../core/targets.js";
import { errorText } from "./runtime.js";
import { targetKey } from "./values.js";

/** 出站会话：群聊或私聊 */
export interface OutboundTarget {
  readonly kind: "group" | "private";
  readonly id: string;
}

/** 队列元素的最小形状；平台可以在此基础上追加媒体等字段 */
export interface QueueItem {
  /** 用于日志的标识（游戏消息用消息 id，镜像消息用 `mirror:...`） */
  readonly id: string;
  /** 已经格式化好的出站文本 */
  readonly text: string;
  /** 需要跳过的目标（`kind:id`），用于群/私聊镜像时不回发来源会话 */
  readonly exclude?: string;
}

export interface TargetBookOptions {
  /** 日志前缀里的平台名（`qq` / `telegram`） */
  readonly label: string;
  readonly log: LogClient;
  /** 未显式配置时使用的「见过的会话」 */
  readonly learned: LearnedTargets;
  /** `settings.groups`：非空时优先于 learned */
  readonly groups: readonly string[];
  /** `settings.privateUsers`：非空时优先于 learned */
  readonly users: readonly string[];
  /** 是否启用群/私聊镜像；关闭时不需要「缺群目标」的告警 */
  readonly syncChannels: boolean;
  /** 「还没有任何会话目标」时括号里的补充说明 */
  readonly noTargetHint: string;
  /** 「私聊镜像发不到群」时括号里的补充说明 */
  readonly noMirrorHint: string;
}

/**
 * 出站目标册：负责「发给谁」与两类一次性告警。
 *
 * 告警只在这里维护，平台适配器不需要各自记 `warnedXxx` 布尔值。
 */
export class TargetBook {
  private warnedNoTarget = false;
  private warnedNoMirror = false;

  public constructor(private readonly options: TargetBookOptions) {}

  /** 出站目标：显式配置优先，否则取收到过消息的会话（按首次出现顺序） */
  public targets(): readonly OutboundTarget[] {
    const groups =
      this.options.groups.length > 0 ? this.options.groups : this.options.learned.groups();
    const users =
      this.options.users.length > 0 ? this.options.users : this.options.learned.users();
    const targets: OutboundTarget[] = [];
    for (const group of groups) {
      targets.push({ kind: "group", id: group });
    }
    for (const user of users) {
      targets.push({ kind: "private", id: user });
    }
    return targets;
  }

  /** 存在任何已知会话（配置或学到的）；用来区分「真没目标」与「被 exclude 过滤光」 */
  public get known(): boolean {
    return (
      this.options.groups.length + this.options.users.length + this.options.learned.size > 0
    );
  }

  /** 队列选不出目标时调用；只有真的没有任何会话才告警一次 */
  public warnNoTarget(): void {
    if (this.warnedNoTarget || this.known) {
      return;
    }
    this.warnedNoTarget = true;
    this.options.log.warn(
      `[${this.options.label}] 还没有可用的会话目标（${this.options.noTargetHint}）`,
    );
  }

  /**
   * 「私聊镜像发不到群」只告警一次，避免每条私聊都刷屏。
   *
   * 缺目标只会发生在「私聊 → 群」：私聊目标随第一条私聊就有，群目标要等群
   * 开口（或入群事件）。群里发不出来时就地说明怎么补，而不是静默丢弃。
   */
  public warnNoMirrorTarget(isGroup: boolean): void {
    if (this.warnedNoMirror || !this.options.syncChannels || isGroup) {
      return;
    }
    if (this.options.groups.length > 0 || this.options.learned.groups().length > 0) {
      return;
    }
    this.warnedNoMirror = true;
    this.options.log.warn(
      `[${this.options.label}] 私聊镜像暂时发不到群：还没有记录到任何群会话（${this.options.noMirrorHint}）`,
    );
  }
}

export interface OutboundQueueOptions<P extends QueueItem, R> {
  /** 日志前缀里的平台名 */
  readonly label: string;
  /** 错误文案里的平台显示名（`QQ` / `Telegram`） */
  readonly title: string;
  /** 积压上限；超过丢最旧 */
  readonly limit: number;
  readonly log: LogClient;
  readonly targets: TargetBook;
  /** 为 true 时停止出队，不再发新消息 */
  readonly isStopping: () => boolean;
  /**
   * 可选：每条消息发送前准备一次（如 QQ 把图片转存素材库）。
   * 抛错由 `prepare` 自己处理并降级，不应让整条消息失败。
   */
  readonly prepare?: (pending: P) => Promise<R>;
  /** 发到单个目标；失败抛错，由队列计数 */
  readonly send: (target: OutboundTarget, pending: P, prepared: R) => Promise<void>;
}

/**
 * 串行出站队列。
 *
 * `push` 是同步的，分发层可以放心调用；内部的 flush 自行兜住异步失败，
 * 不会产生未处理的 Promise rejection。
 */
export class OutboundQueue<P extends QueueItem, R = undefined> {
  private readonly queue: P[] = [];
  private sending = false;

  public constructor(private readonly options: OutboundQueueOptions<P, R>) {}

  /** 当前积压条数（运维查询用） */
  public get size(): number {
    return this.queue.length;
  }

  /** 停止时清空：重连后不补发过期消息，与旧行为一致 */
  public clear(): void {
    this.queue.length = 0;
  }

  public push(pending: P): void {
    if (pending.text === "" || this.options.isStopping()) {
      return;
    }
    if (this.queue.length >= this.options.limit) {
      this.queue.shift();
      this.options.log.warn(
        `[${this.options.label}] 出站积压超过 ${this.options.limit} 条，丢弃最旧消息`,
      );
    }
    this.queue.push(pending);
    void this.flush().catch((error: unknown) => {
      this.options.log.warn(`[${this.options.label}] 出站队列异常：${errorText(error)}`);
    });
  }

  private async flush(): Promise<void> {
    const { targets, prepare, send, isStopping, label, log } = this.options;
    if (this.sending || isStopping()) {
      return;
    }
    this.sending = true;
    try {
      while (!isStopping() && this.queue.length > 0) {
        const pending = this.queue.shift();
        if (pending === undefined) {
          continue;
        }
        const selected = targets
          .targets()
          .filter((target) => pending.exclude !== targetKey(target.kind, target.id));
        if (selected.length === 0) {
          // 仅因 `exclude` 过滤掉唯一目标是正常情况，不告警。
          targets.warnNoTarget();
          continue;
        }

        let prepared: R | undefined;
        if (prepare !== undefined) {
          try {
            prepared = await prepare(pending);
          } catch (error) {
            // 准备失败（如 QQ 图片转存）按整条消息跳过，但不阻塞队列后续消息
            log.warn(`[${label}] 发送前准备失败（${pending.id}）：${errorText(error)}`);
            continue;
          }
        }
        let failures = 0;
        for (const target of selected) {
          try {
            await send(target, pending, prepared as R);
          } catch (error) {
            failures += 1;
            log.warn(`[${label}] 发送到 ${target.kind}:${target.id} 失败：${errorText(error)}`);
          }
        }
        if (failures === selected.length) {
          // 一条消息全目标失败不能中断整个队列：后面的消息仍要发，
          // 否则一次平台故障会把积压永久卡在队首。
          log.warn(
            `[${label}] ${this.options.title} 所有目标均发送失败（${pending.id}），继续发送后续消息`,
          );
          continue;
        }
        if (failures > 0) {
          log.warn(`[${label}] 消息 ${pending.id} 有 ${failures}/${selected.length} 个目标失败`);
        }
      }
    } finally {
      this.sending = false;
    }
  }
}