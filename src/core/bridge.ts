/**
 * 桥内核：采集 → 归一化 → 分类 → 入库 → 分发
 *
 * 不依赖 SDK 的 op / 事件 API，只接收 `EventMeta` 与原始负载；这样单测可以
 * 直接驱动内核，插件入口（`src/index.ts`）只做「接线」。
 */

import { PluginError } from "mcsup-plugin";
import type { EventMeta, LogClient } from "mcsup-plugin";

import { normalizeEvent } from "../events/normalize.js";
import type { PlatformRegistry } from "../platforms/registry.js";
import type { ChatPlatform } from "../platforms/types.js";
import { PlatformDispatcher, type PlatformStats } from "./dispatcher.js";
import { MessageStore } from "./store.js";
import type { MessageCategory, MessageFilter, MessagePage } from "./types.js";

/** 运行期配置（由 `config.ts` 从宿主配置解析而来） */
export interface BridgeConfig {
  readonly platforms: readonly string[];
  readonly forwardCategories: readonly MessageCategory[];
  readonly consoleForward: boolean;
  readonly storeSize: number;
  readonly queueCapacity: number;
  /** 与平台 id 同名的配置片段 */
  readonly platformSettings: Readonly<Record<string, unknown>>;
}

export interface BridgeOptions {
  readonly log: LogClient;
  readonly registry: PlatformRegistry;
  readonly config: BridgeConfig;
}

/** `status` op 的数据源 */
export interface BridgeStatus {
  readonly started: boolean;
  readonly uptimeSecs: number;
  readonly accepted: number;
  readonly duplicates: number;
  readonly skipped: number;
  readonly filtered: number;
  readonly stored: number;
  readonly categories: Record<MessageCategory, number>;
  readonly platforms: readonly PlatformStats[];
}

export class ChatBridge {
  private readonly log: LogClient;
  private readonly registry: PlatformRegistry;
  private readonly store: MessageStore;
  private config: BridgeConfig;
  private dispatcher: PlatformDispatcher | undefined;
  private started = false;
  private startedAt: number | undefined;
  private accepted = 0;
  private duplicates = 0;
  private skipped = 0;
  private filtered = 0;

  public constructor(options: BridgeOptions) {
    this.log = options.log;
    this.registry = options.registry;
    this.config = options.config;
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
      `聊天桥已启动：平台 [${this.config.platforms.join(", ")}]，缓存 ${this.config.storeSize} 条`,
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

  public recent(filter: MessageFilter = {}): MessagePage {
    return this.store.recent(filter);
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
      stored: this.store.size,
      categories: this.store.counts(),
      platforms: this.dispatcher?.stats() ?? [],
    };
  }

  private buildDispatcher(config: BridgeConfig): PlatformDispatcher {
    const platforms: ChatPlatform[] = config.platforms.map((id) =>
      this.registry.create(id, { log: this.log, settings: config.platformSettings[id] }),
    );
    return new PlatformDispatcher(platforms, {
      capacity: config.queueCapacity,
      log: this.log,
    });
  }

  private shouldForward(source: string, category: MessageCategory): boolean {
    if (source === "console" && !this.config.consoleForward) {
      return false;
    }
    return this.config.forwardCategories.includes(category);
  }
}

/** 平台集合、平台配置、队列容量都没变时，只需要更新过滤与缓存设置 */
function dispatcherUnchanged(a: BridgeConfig, b: BridgeConfig): boolean {
  if (a.queueCapacity !== b.queueCapacity) {
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

function jsonOf(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

function errorText(error: unknown): string {
  if (error instanceof PluginError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}