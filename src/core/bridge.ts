/**
 * 桥内核：采集 → 归一化 → 分类 → 入库 → 分发；以及 平台 → 游戏 的入站注入
 *
 * 不依赖 SDK 的 op / 事件 API，只接收 `EventMeta` 与原始负载；这样单测可以
 * 直接驱动内核，插件入口（`src/index.ts`）只做「接线」。
 *
 * 入站与跨平台同步是两条不同的边：
 * - 入站：适配器把平台原生事件翻译为 `PlatformInboundMessage` 后交给内核，
 *   内核统一做白名单之外的去重、长度限制、排队、回声抑制与注入游戏。
 * - 跨平台：同一条入站消息在注入游戏的同时，由内核投给**除来源之外的每个
 *   实现了 `relay` 的平台**。适配器只需要把格式化好的文本发给自己的会话
 *   目标，不必知道还有谁在线，也不需要平台之间两两直接对接。
 *
 * 这样「谁负责判定」仍然只有一处：能不能转发、转给谁、是否与来源平台相同，
 * 全在 {@link ChatBridge.handleInbound} 里决定；适配器只负责发送。
 * 平台适配器不需要知道游戏端如何选服务器、如何转义。
 */

import { PluginError } from "mcsup-plugin";
import type { EventMeta, LogClient } from "mcsup-plugin";

import { normalizeEvent } from "../events/normalize.js";
import type { PlatformRegistry } from "../platforms/registry.js";
import type {
  ChatPlatform,
  GamePort,
  InjectMode,
  PlatformInboundMessage,
  PlatformRelayMessage,
} from "../platforms/types.js";
import { PlatformDispatcher, type PlatformStats } from "./dispatcher.js";
import { MessageStore } from "./store.js";
import type { KvLike } from "./targets.js";
import type { MessageCategory, MessageDraft, MessageFilter, MessagePage } from "./types.js";

/** 运行期配置（由 `config.ts` 从宿主配置解析而来） */
export interface BridgeConfig {
  readonly platforms: readonly string[];
  readonly forwardCategories: readonly MessageCategory[];
  readonly consoleForward: boolean;
  readonly storeSize: number;
  readonly queueCapacity: number;
  /** 是否允许平台消息注入游戏 */
  readonly inbound: boolean;
  /**
   * 是否把从一个平台收到的消息转发给其它平台（默认 true）。
   *
   * 与 `inbound` 是两条独立的边：关掉入站只影响「平台 → 游戏」，
   * 平台之间仍然互通；关掉它则只有游戏与各平台之间双向，平台之间不串。
   */
  readonly crossPlatform: boolean;
  /**
   * 是否接收私聊（默认 false）。
   *
   * 与 `crossPlatform` 独立：打开后所有适配器都接受私聊，私聊会参与注入
   * 游戏、群/私聊镜像与跨平台同步。适配器自己的 `allowPrivate` 仍然有效，
   * 两者取并集，避免全局开关把平台的显式配置覆盖掉。
   */
  readonly privateSync: boolean;
  /** 入站默认服务器；省略时由 GamePort 自动选择 */
  readonly inboundServer?: string;
  /** 单条入站文本上限 */
  readonly inboundMaxLength: number;
  /**
   * 平台消息注入游戏的方式：
   * - `tellraw`（默认）：游戏内只有插件标签，不写服务器日志；
   * - `say`：写进服务器 `logs/latest.log`，但游戏内会多出 `[Server]` 前缀。
   */
  readonly injectMode: InjectMode;
  /** 与平台 id 同名的配置片段 */
  readonly platformSettings: Readonly<Record<string, unknown>>;
}

export interface BridgeOptions {
  readonly log: LogClient;
  readonly registry: PlatformRegistry;
  readonly config: BridgeConfig;
  /** 游戏侧端口；未授予 `console:write` 时省略，入站会降级并计数 */
  readonly game?: GamePort;
  /**
   * 宿主 `storage:kv`；未授予时省略。
   *
   * 适配器用它把「见过的会话」等小状态存下来，让留空配置的出站目标跨重启
   * 有效。缺省时适配器退化为进程内记忆。
   */
  readonly kv?: KvLike;
}

/** 入站统计 */
export interface InboundStats {
  /** 适配器交来的条数（含被拒绝的） */
  readonly received: number;
  /** 成功注入游戏的条数 */
  readonly delivered: number;
  /** 因配置关闭、未启动或队列溢出丢弃的条数 */
  readonly dropped: number;
  /** 平台消息 id 重复而丢弃的条数 */
  readonly duplicates: number;
  /** 注入失败的条数（无服务器、无权限、宿主报错） */
  readonly failed: number;
  /** 成功转给其它平台（至少投给一个）的条数 */
  readonly relayed: number;
}

/** `status` op 的数据源 */
export interface BridgeStatus {
  readonly started: boolean;
  readonly uptimeSecs: number;
  readonly accepted: number;
  readonly duplicates: number;
  readonly skipped: number;
  readonly filtered: number;
  /** 被回声抑制（自己注入的文本又回流）的条数 */
  readonly suppressed: number;
  readonly stored: number;
  readonly categories: Record<MessageCategory, number>;
  readonly platforms: readonly PlatformStats[];
  readonly inbound: InboundStats;
}

/** 入站任务的内部形状：已通过长度与去重检查 */
interface InboundJob {
  readonly platform: string;
  readonly author: string;
  readonly text: string;
  readonly server?: string;
  readonly label: string;
}

/** 回声窗口时长：注入后这段时间内出现的同文本消息视为自身回显 */
const ECHO_TTL_MS = 60_000;
const ECHO_WINDOW = 64;
const SEEN_IDS = 1_024;
const SEEN_TTL_MS = 10 * 60_000;
/**
 * 同一条玩家聊天可能被宿主投递两次：结构化 `chat:message` 与控制台投影
 * `[Not Secure] <name> text`（离线模式只有后者）。跨源去重窗口取值只覆盖
 * 两者到达的时间差，避免把玩家自己连发同样的两句话误判成重复。
 */
const CHAT_MIRROR_TTL_MS = 3_000;

export class ChatBridge {
  private readonly log: LogClient;
  private readonly registry: PlatformRegistry;
  private readonly store: MessageStore;
  private readonly game: GamePort | undefined;
  private readonly kv: KvLike | undefined;
  private config: BridgeConfig;
  private dispatcher: PlatformDispatcher | undefined;
  private started = false;
  private startedAt: number | undefined;
  private accepted = 0;
  private duplicates = 0;
  private skipped = 0;
  private filtered = 0;
  private suppressed = 0;
  private inboundWarned = false;
  private lastServer: string | undefined;

  private readonly inboundQueue: InboundJob[] = [];
  private inboundBusy = false;
  private readonly inboundStats = {
    received: 0,
    delivered: 0,
    dropped: 0,
    duplicates: 0,
    failed: 0,
    relayed: 0,
  };
  private readonly inboundSeen = new Map<string, number>();
  private readonly echoWindow: Array<{ readonly text: string; readonly at: number }> = [];
  /** 结构化聊天与控制台投影的跨源去重表：`from\u0000text` → 时间戳 */
  private readonly structuredChat = new Map<string, number>();
  private readonly projectedChat = new Map<string, number>();
  /** 跨平台转发是否可用的告警只打一次 */
  private crossWarned = false;

  public constructor(options: BridgeOptions) {
    this.log = options.log;
    this.registry = options.registry;
    this.config = options.config;
    this.game = options.game;
    this.kv = options.kv;
    this.store = new MessageStore(options.config.storeSize);
  }

  public get running(): boolean {
    return this.started;
  }

  public get currentConfig(): BridgeConfig {
    return this.config;
  }

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    const dispatcher = this.buildDispatcher(this.config);
    await dispatcher.start();
    this.dispatcher = dispatcher;
    this.started = true;
    this.startedAt = Date.now();
    this.log.info(
      `聊天桥已启动：平台 [${this.config.platforms.join(", ")}]，缓存 ${this.config.storeSize} 条` +
        `，入站${this.game === undefined ? "降级（未授予 console:write）" : "已启用"}`,
    );
  }

  /**
   * 热更新配置。
   *
   * 平台集合或平台配置变化时先起新平台，成功后再停旧平台；新平台启动失败
   * 会抛出，宿主据此回滚配置，旧平台继续服务。
   */
  public async applyConfig(config: BridgeConfig): Promise<void> {
    if (!this.started) {
      this.config = config;
      this.store.resize(config.storeSize);
      return;
    }
    if (dispatcherUnchanged(this.config, config)) {
      this.config = config;
      this.store.resize(config.storeSize);
      return;
    }

    const next = this.buildDispatcher(config);
    await next.start();
    const previous = this.dispatcher;
    this.dispatcher = next;
    this.config = config;
    this.store.resize(config.storeSize);

    if (previous !== undefined) {
      try {
        await previous.stop("配置变更");
      } catch (error) {
        this.log.warn(`旧平台停止失败：${errorText(error)}`);
      }
    }
  }

  public async stop(reason: string): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    this.inboundQueue.length = 0;
    const dispatcher = this.dispatcher;
    this.dispatcher = undefined;
    if (dispatcher !== undefined) {
      await dispatcher.stop(reason);
    }
  }

  /**
   * 接收一条宿主事件；必须快速返回（SDK 会串行 await 事件处理函数）。
   *
   * 分类与入库是纯计算，投递只是入队，所以这里没有 await。
   */
  public ingest(kind: string, data: unknown, meta: EventMeta): void {
    if (!this.started) {
      this.skipped += 1;
      return;
    }
    try {
      const result = normalizeEvent(kind, data, meta);
      if (result.kind !== "message") {
        this.skipped += 1;
        return;
      }
      if (this.isEcho(result.draft)) {
        this.suppressed += 1;
        return;
      }
      if (this.isChatMirror(result.draft, result.projection === true)) {
        this.duplicates += 1;
        return;
      }
      this.lastServer = result.draft.server;
      const message = this.store.add(result.draft);
      if (message === null) {
        this.duplicates += 1;
        return;
      }
      this.accepted += 1;
      if (!this.shouldForward(message.source, message.category)) {
        this.filtered += 1;
        return;
      }
      this.dispatcher?.deliver(message);
    } catch (error) {
      this.skipped += 1;
      this.log.warn(`事件 ${kind} 处理失败：${errorText(error)}`);
    }
  }

  /**
   * 平台 → 游戏，以及平台 → 其它平台。适配器在收到外部消息后调用；这里立即
   * 返回（只入队）。
   *
   * 去重与长度限制在入口做，注入在独立消费者里串行执行，避免慢游戏端拖住
   * 平台适配器的收包循环。
   *
   * 两条边共用同一份去重结果：同一条平台消息只会被处理一次，然后同时进
   * 「注入游戏」与「转给其它平台」两条路径。任何一边关闭都不影响另一边。
   */
  public handleInbound(message: PlatformInboundMessage): void {
    this.inboundStats.received += 1;
    if (!this.started) {
      this.inboundStats.dropped += 1;
      return;
    }
    // 平台自己的 inbound 开关只关掉「注入游戏」，跨平台同步仍然生效。
    const inject = this.config.inbound && message.inject !== false;
    // 两条边都关掉才算真的丢：只关一条时另一条仍要工作。
    if (!inject && !this.config.crossPlatform) {
      this.inboundStats.dropped += 1;
      return;
    }

    const text = clampText(message.text, this.config.inboundMaxLength);
    if (text === "") {
      this.inboundStats.dropped += 1;
      return;
    }
    if (message.messageId !== undefined && this.isDuplicate(message.platform, message.messageId)) {
      this.inboundStats.duplicates += 1;
      return;
    }

    if (this.config.crossPlatform) {
      this.relayInbound(message, text);
    }

    if (!inject) {
      return;
    }
    if (this.inboundQueue.length >= this.config.queueCapacity) {
      this.inboundQueue.shift();
      this.inboundStats.dropped += 1;
      if (!this.inboundWarned) {
        this.inboundWarned = true;
        this.log.warn(`入站队列已满（${this.config.queueCapacity}），丢弃最旧消息`);
      }
    }

    this.inboundQueue.push({
      platform: message.platform,
      author: message.author.name,
      text,
      label: message.label ?? message.platform.toUpperCase(),
      ...(message.server === undefined ? {} : { server: message.server }),
    });
    void this.pumpInbound();
  }

  public recent(filter: MessageFilter = {}): MessagePage {
    return this.store.recent(filter);
  }

  /**
   * 把一条入站消息转给其它平台。
   *
   * `source` 取平台标签（`QQ` / `Telegram`），适配器据此拼 `[QQ] 昵称: ...`；
   * 拿不到标签时退回大写的平台 id，任何平台都能被转发。
   */
  private relayInbound(message: PlatformInboundMessage, text: string): void {
    const relayMessage: PlatformRelayMessage = {
      platform: message.platform,
      source: message.label ?? message.platform.toUpperCase(),
      channel: message.channel,
      author: message.author,
      text,
      ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
      ...(message.at === undefined ? {} : { at: message.at }),
    };
    let queued = 0;
    try {
      queued = this.dispatcher?.relay(relayMessage) ?? 0;
    } catch (error) {
      this.log.warn(`跨平台转发失败：${errorText(error)}`);
      return;
    }
    if (queued > 0) {
      this.inboundStats.relayed += 1;
      return;
    }
    if (!this.crossWarned && this.config.platforms.length > 1) {
      this.crossWarned = true;
      this.log.warn(
        "没有可接收跨平台转发的其它平台（只有实现了 relay 的适配器会接收，" +
          "内置的 log / null 不接收）；平台之间不会同步",
      );
    }
  }

  public status(): BridgeStatus {
    return {
      started: this.started,
      uptimeSecs:
        this.startedAt === undefined ? 0 : Math.max(0, Math.floor((Date.now() - this.startedAt) / 1_000)),
      accepted: this.accepted,
      duplicates: this.duplicates,
      skipped: this.skipped,
      filtered: this.filtered,
      suppressed: this.suppressed,
      stored: this.store.size,
      categories: this.store.counts(),
      platforms: this.dispatcher?.stats() ?? [],
      inbound: { ...this.inboundStats },
    };
  }

  private buildDispatcher(config: BridgeConfig): PlatformDispatcher {
    const platforms: ChatPlatform[] = config.platforms.map((id) =>
      this.registry.create(id, {
        log: this.log,
        settings: config.platformSettings[id],
        ...(config.privateSync ? { private: true } : {}),
        ...(this.kv === undefined ? {} : { kv: this.kv }),
      }),
    );
    return new PlatformDispatcher(platforms, {
      capacity: config.queueCapacity,
      log: this.log,
      game: this.game,
      onInbound: (message) => {
        this.handleInbound(message);
      },
    });
  }

  private shouldForward(source: string, category: MessageCategory): boolean {
    if (source === "console" && !this.config.consoleForward) {
      return false;
    }
    return this.config.forwardCategories.includes(category);
  }

  /** 串行消费入站队列；慢注入不会并发，也不会阻塞平台收包 */
  private async pumpInbound(): Promise<void> {
    if (this.inboundBusy) {
      return;
    }
    this.inboundBusy = true;
    try {
      while (this.inboundQueue.length > 0) {
        if (!this.started || !this.config.inbound) {
          this.inboundQueue.length = 0;
          return;
        }
        const job = this.inboundQueue.shift();
        if (job === undefined) {
          return;
        }
        await this.deliverInbound(job);
      }
    } finally {
      this.inboundBusy = false;
    }
  }

  private async deliverInbound(job: InboundJob): Promise<void> {
    const port = this.game;
    if (port === undefined) {
      this.inboundStats.failed += 1;
      if (!this.inboundWarned) {
        this.inboundWarned = true;
        this.log.warn(
          "未授予 console:write：平台消息无法注入游戏，入站方向降级为仅计数",
        );
      }
      return;
    }

    const line = `[${job.label}] ${job.author}: ${job.text}`;
    try {
      const server = await port.resolveServer(job.server ?? this.config.inboundServer ?? this.lastServer);
      if (server === null) {
        throw new Error("没有可用的服务器（可在 inboundServer 中指定）");
      }
      await port.sendChat(server, line, this.config.injectMode);
      this.rememberEcho(line);
      this.inboundStats.delivered += 1;
      // 注入本身不产生可查询的记录（tellraw 只面向玩家），这里显式留一条日志，
      // 便于 `mcsup plugin logs chat-bridge` 核对「平台 → 游戏」是否真的发生。
      this.log.info(`[${job.platform}] 注入 ${server}：${line}`);
    } catch (error) {
      this.inboundStats.failed += 1;
      this.log.warn(`[${job.platform}] 入站注入失败：${errorText(error)}`);
    }
  }

  /** 平台消息 id 去重：只保留最近 10 分钟，避免重连后重复注入 */
  private isDuplicate(platform: string, messageId: string): boolean {
    const key = `${platform}:${messageId}`;
    const now = Date.now();
    const seenAt = this.inboundSeen.get(key);
    if (seenAt !== undefined && now - seenAt <= SEEN_TTL_MS) {
      return true;
    }
    if (this.inboundSeen.size >= SEEN_IDS) {
      this.prune(this.inboundSeen, now);
      if (this.inboundSeen.size >= SEEN_IDS) {
        const oldest = this.inboundSeen.keys().next();
        if (!oldest.done) {
          this.inboundSeen.delete(oldest.value);
        }
      }
    }
    this.inboundSeen.set(key, now);
    return false;
  }

  /**
   * 回声抑制：`tellraw` 注入后，若宿主把同一文本再作为聊天/控制台事件送回来，
   * 记录并丢弃，避免「游戏 → 平台 → 游戏」自激。
   */
  private isEcho(draft: MessageDraft): boolean {
    if (this.echoWindow.length === 0) {
      return false;
    }
    const now = Date.now();
    this.pruneEcho(now);
    const haystack = `${draft.text}\n${draft.raw ?? ""}`;
    return this.echoWindow.some((entry) => haystack.includes(entry.text));
  }

  private rememberEcho(text: string): void {
    const now = Date.now();
    this.pruneEcho(now);
    this.echoWindow.push({ text, at: now });
    if (this.echoWindow.length > ECHO_WINDOW) {
      this.echoWindow.shift();
    }
  }

  /**
   * 跨源去重：`chat:message` 与控制台聊天投影是同一条消息的两种投递。
   *
   * 只看相反来源在 `CHAT_MIRROR_TTL_MS` 内是否出现过同样的 (from, text)：
   * 同源重复（玩家真连发两句一样的话）不会被误判。
   */
  private isChatMirror(draft: MessageDraft, projection: boolean): boolean {
    if (draft.category !== "chat" && draft.category !== "command") {
      return false;
    }
    if (draft.from === null) {
      return false;
    }
    const key = `${draft.from}\u0000${draft.text}`;
    const now = Date.now();
    const thatSide = projection ? this.structuredChat : this.projectedChat;
    const thisSide = projection ? this.projectedChat : this.structuredChat;

    for (const [seenKey, seenAt] of thatSide) {
      if (now - seenAt > CHAT_MIRROR_TTL_MS) {
        thatSide.delete(seenKey);
      }
    }
    if ((thatSide.get(key) ?? 0) > 0) {
      return true;
    }
    thisSide.set(key, now);
    return false;
  }

  private pruneEcho(now: number): void {
    while (this.echoWindow.length > 0 && now - (this.echoWindow[0]?.at ?? now) > ECHO_TTL_MS) {
      this.echoWindow.shift();
    }
  }

  private prune(seen: Map<string, number>, now: number): void {
    for (const [key, seenAt] of seen) {
      if (now - seenAt > SEEN_TTL_MS) {
        seen.delete(key);
      }
    }
  }
}

/** 平台集合、平台配置、队列容量都没变时，只需要更新过滤与缓存设置 */
function dispatcherUnchanged(a: BridgeConfig, b: BridgeConfig): boolean {
  if (a.queueCapacity !== b.queueCapacity) {
    return false;
  }
  // 私聊开关作为创建选项下发给适配器，变化时必须重建
  if (a.privateSync !== b.privateSync) {
    return false;
  }
  if (a.platforms.length !== b.platforms.length) {
    return false;
  }
  for (let i = 0; i < a.platforms.length; i += 1) {
    const id = a.platforms[i];
    if (id === undefined || id !== b.platforms[i]) {
      return false;
    }
    if (jsonOf(a.platformSettings[id]) !== jsonOf(b.platformSettings[id])) {
      return false;
    }
  }
  return true;
}

/** 单条入站文本：折叠空白、去控制字符、按字符数截断 */
function clampText(text: string, max: number): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= max) {
    return clean;
  }
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function jsonOf(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

function errorText(error: unknown): string {
  if (error instanceof PluginError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}