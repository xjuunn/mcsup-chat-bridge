/**
 * Discord 平台适配器：Bot Gateway（WebSocket）+ REST API v10
 *
 * 协议依据（Discord 开发者文档）：
 * - 建连：`GET /gateway/bot` 取得 Gateway 地址，连上后等待 op 10 Hello，
 *   再发 op 2 Identify（`GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT`）；
 *   断线优先 op 6 Resume，会话失效才重新 Identify。
 * - 出站：`POST /channels/{channel_id}/messages`；私聊先经
 *   `POST /users/@me/channels` 把 user id 换成 DM channel id 并缓存。
 * - 入站：Gateway 的 `MESSAGE_CREATE` 事件；频道消息（带 `guild_id`）视为群聊，
 *   DM 消息视为私聊，`message_id` 全局唯一，直接作入站去重键。
 *
 * 设计取舍：
 * - 插件运行在宿主沙箱里，没有公网入口，因此只做出站 WebSocket 连接，
 *   不配置 Interactions Endpoint。
 * - Discord 的 bot 必须在 Developer Portal 打开 **Message Content Intent**，
 *   否则 Gateway 会以 4014 关闭；适配器把开启路径写进日志，避免用户猜。
 * - 私聊配置里填的是 **user id**（不是 DM channel id）；发送前换成 DM
 *   channel id 并缓存。学习到的私聊目标则是 DM channel id，重启后可直接复用。
 * - Discord 的附件 URL 是带签名的临期地址，群/私聊镜像只把图片 URL 作为
 *   embed 立即发送，不下载、不转存；跨平台 relay 不携带媒体。
 * - 出站禁用 `@everyone` / `@here` 解析（`allowed_mentions.parse = []`），
 *   玩家聊天里的 @ 不会变成全员通知。
 */

import WebSocket from "ws";
import { PluginError } from "mcsup-plugin";
import type { LogClient } from "mcsup-plugin";

import { LearnedTargets } from "../core/targets.js";
import type { MessageCategory, NormalizedMessage } from "../core/types.js";
import { formatOutbound, formatRelay, splitText } from "../platform-kit/format.js";
import { OutboundQueue, TargetBook, type OutboundTarget } from "../platform-kit/shared/outbound.js";
import { MessageSeen } from "../platform-kit/shared/seen.js";
import { abortableSleep, errorText, isAbortError, jitter, sleep } from "../platform-kit/shared/runtime.js";
import {
  boolOf,
  categoriesOf,
  httpUrlOf,
  idOf,
  intOf,
  objectOf,
  stringOf,
  stringsOf,
  targetKey,
} from "../platform-kit/shared/values.js";
import { PLUGIN_VERSION } from "../version.js";
import type {
  ChatPlatform,
  PlatformContext,
  PlatformCreateOptions,
  PlatformFactory,
  PlatformInboundMessage,
  PlatformRelayMessage,
} from "../platform-kit/types.js";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 解析后的 Discord 配置；数值都有默认值，工厂不做额外 IO */
export interface DiscordSettings {
  /** Developer Portal → Bot → Reset Token 得到的 bot token */
  readonly botToken: string;
  /** REST 基址；默认 `https://discord.com/api/v10`，自建代理时再改 */
  readonly apiBase: string;
  /** 只接收这些服务器（guild）的消息；留空表示不限 */
  readonly guilds: readonly string[];
  /** 出站频道 id；同时作为群聊入站白名单。留空 = 全部（发给收到过消息的频道） */
  readonly groups: readonly string[];
  /** 出站私聊 user id。留空 = 全部（发给给机器人发过私聊的用户） */
  readonly privateUsers: readonly string[];
  /** 入站发言人白名单；留空表示不限 */
  readonly allowedUsers: readonly string[];
  /** 出站类别过滤；省略时沿用全局 forwardCategories */
  readonly categories?: readonly MessageCategory[];
  readonly inbound: boolean;
  readonly allowPrivate: boolean;
  /** 群聊与私聊互相同步；只影响 Discord 内部会话 */
  readonly syncChannels: boolean;
  /** 群/私聊互转时是否把图片 URL 作为 embed 再发一次 */
  readonly forwardMedia: boolean;
  readonly label: string;
  readonly server?: string;
  readonly maxLength: number;
  readonly sendIntervalMs: number;
  readonly apiTimeoutMs: number;
  readonly reconnectMinMs: number;
  readonly reconnectMaxMs: number;
  /** 0 表示无限重试 */
  readonly reconnectMaxAttempts: number;
}

const DEFAULT_API_BASE = "https://discord.com/api/v10";
const USER_AGENT = `mcsup-chat-bridge/${PLUGIN_VERSION} (DiscordBotAdapter)`;

/** Discord 单条消息正文上限 */
const TEXT_LIMIT = 2_000;
/**
 * 默认事件订阅：`GUILD_MESSAGES (1<<9)` + `DIRECT_MESSAGES (1<<12)` +
 * `MESSAGE_CONTENT (1<<15)`。没有 `MESSAGE_CONTENT` 时 Gateway 会返回 4014。
 */
export const DEFAULT_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

/** 出站队列上限：分发层之外再兜一层，避免断线期间无限堆积 */
const OUTBOUND_LIMIT = 512;
/** 留空配置时自动记住的会话上限（群 / 私聊各自） */
const LEARNED_LIMIT = 64;
/** 单次出站失败后的重试次数（首次 + 2 次重试） */
const SEND_ATTEMPTS = 3;
/** user id → DM channel id 的缓存上限；超过丢最早解析的 */
const DM_CACHE_LIMIT = 128;
/** 一条消息最多带几个 embed 镜像；Discord 上限 10，这里保守一些 */
const MAX_EMBEDS = 4;
/** Gateway 关闭码 4008：发送 payload 过快，官方建议等待后重连 */
const RATE_LIMIT_CODE = 4008;
const RATE_LIMIT_WAIT_MS = 60_000;
/** 会话不可恢复，需要清掉 session 重新 Identify */
const SESSION_RESET_CODES = new Set([4006, 4007, 4009]);
/**
 * 不可恢复的关闭码。4014 是最常见的「没开 Message Content Intent」，
 * 日志必须直接给出开启路径，否则用户只会看到「连上又断开」。
 */
const FATAL_CLOSE_CODES: ReadonlyMap<number, string> = new Map([
  [4004, "bot token 无效（4004），请检查 discord.botToken"],
  [4010, "分片配置无效（4010），当前适配器只支持单分片"],
  [4011, "需要分片连接（4011），机器人已超出单分片规模"],
  [4012, "Gateway API 版本无效（4012）"],
  [4013, "Intents 无效（4013），请检查 Discord Developer Portal 的事件订阅"],
  [
    4014,
    "Message Content Intent 未开启（4014）：到 Discord Developer Portal → 你的应用 → Bot → " +
      "Privileged Gateway Intents 打开 Message Content Intent，保存后重启插件",
  ],
]);

/**
 * 校验并补全配置。
 *
 * 缺 botToken 时抛 `invalid_input`，让宿主在启动阶段回滚配置，而不是等到
 * 第一条消息才静默失败。
 */
export function parseDiscordSettings(raw: unknown): DiscordSettings {
  if (typeof raw !== "object" || raw === null) {
    throw new PluginError(
      "invalid_input",
      "平台 discord 缺少配置：请填写 Discord Developer Portal → Bot → Reset Token 得到的 botToken；" +
        "不用 Discord 时请从 platforms 移除 discord",
    );
  }
  const record = raw as Record<string, unknown>;
  const botToken = stringOf(record["botToken"]);
  if (botToken === undefined) {
    throw new PluginError(
      "invalid_input",
      "平台 discord 缺少 botToken：在 Discord Developer Portal → 你的应用 → Bot → Reset Token 获取；" +
        "不用 Discord 时请从 platforms 移除 discord",
    );
  }

  const categories = categoriesOf(record["categories"]);
  const server = stringOf(record["server"]);

  return {
    botToken,
    apiBase: httpUrlOf(record["apiBase"], "discord") ?? DEFAULT_API_BASE,
    guilds: stringsOf(record["guilds"]),
    groups: stringsOf(record["groups"]),
    privateUsers: stringsOf(record["privateUsers"]),
    allowedUsers: stringsOf(record["allowedUsers"]),
    ...(categories === undefined ? {} : { categories }),
    inbound: boolOf(record["inbound"], true),
    allowPrivate: boolOf(record["allowPrivate"], false),
    syncChannels: boolOf(record["syncChannels"], true),
    forwardMedia: boolOf(record["forwardMedia"], true),
    label: stringOf(record["label"]) ?? "Discord",
    ...(server === undefined ? {} : { server }),
    maxLength: intOf(record["maxLength"], 1_900, 64, TEXT_LIMIT),
    sendIntervalMs: intOf(record["sendIntervalMs"], 1_000, 0, 10_000),
    apiTimeoutMs: intOf(record["apiTimeoutMs"], 15_000, 1_000, 60_000),
    reconnectMinMs: intOf(record["reconnectMinMs"], 1_000, 200, 60_000),
    reconnectMaxMs: intOf(record["reconnectMaxMs"], 60_000, 1_000, 600_000),
    reconnectMaxAttempts: intOf(record["reconnectMaxAttempts"], 0, 0, 10_000),
  };
}

// ---------------------------------------------------------------------------
// 入站归一化
// ---------------------------------------------------------------------------

/**
 * 把 Discord 原生消息归一为纯文本。
 *
 * 正文取 `content`；附件按 `content_type` 转成占位：图片、视频、音频、
 * 其它文件；贴纸合并成一个 `[表情]`。Discord 一条消息最多 10 个附件。
 */
export function discordInboundText(message: Record<string, unknown>): string {
  const base = stringOf(message["content"]) ?? "";
  const markers: string[] = [];

  const attachments = Array.isArray(message["attachments"]) ? message["attachments"] : [];
  for (const item of attachments) {
    const attachment = objectOf(item);
    if (attachment !== undefined) {
      markers.push(attachmentMarker(attachment));
    }
  }
  const stickers = Array.isArray(message["sticker_items"]) ? message["sticker_items"] : [];
  if (stickers.length > 0) {
    markers.push("[表情]");
  }

  return `${base} ${markers.join(" ")}`.replace(/\s+/g, " ").trim();
}

/** 提取可镜像的图片 URL；签名 URL 只适合立即转发，不持久化 */
export function discordInboundImages(message: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const attachments = Array.isArray(message["attachments"]) ? message["attachments"] : [];
  for (const item of attachments) {
    const attachment = objectOf(item);
    if (attachment === undefined) {
      continue;
    }
    const type = stringOf(attachment["content_type"]) ?? "";
    if (!type.startsWith("image/")) {
      continue;
    }
    const url = stringOf(attachment["url"]);
    if (url !== undefined) {
      urls.push(url);
    }
  }
  return urls;
}

function attachmentMarker(attachment: Record<string, unknown>): string {
  const type = stringOf(attachment["content_type"]) ?? "";
  if (type.startsWith("image/")) {
    return "[图片]";
  }
  if (type.startsWith("video/")) {
    return "[视频]";
  }
  if (type.startsWith("audio/")) {
    return "[音频]";
  }
  const name = stringOf(attachment["filename"]);
  return name === undefined ? "[文件]" : `[文件: ${name}]`;
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

interface PendingSend {
  /** 用于日志的标识（游戏消息用消息 id，镜像消息用 `mirror:...`） */
  readonly id: string;
  /** 已经格式化好的出站文本 */
  readonly text: string;
  /** 需要跳过的目标（`kind:id`），用于群/私聊镜像时不回发来源会话 */
  readonly exclude?: string;
  /** 随消息一起作为 embed 镜像的图片 URL */
  readonly images?: readonly string[];
}

class DiscordApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class DiscordPlatform implements ChatPlatform {
  public readonly id = "discord";
  public readonly title = "Discord";

  private readonly settings: DiscordSettings;
  private readonly log: LogClient;
  private readonly kv: PlatformCreateOptions["kv"];
  private ctx: PlatformContext | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private readonly stopController = new AbortController();
  private fatal: string | undefined;

  private socket: WebSocket | undefined;
  private sessionId: string | undefined;
  private lastSeq: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatMs = 41_250;
  private heartbeatAcked = true;
  private pendingCloseCode: number | undefined;
  private resolveClosed: (() => void) | undefined;
  private identity: { readonly id: string; readonly username?: string } | undefined;

  private backoff: number;
  private attempts = 0;

  private lastSendAt = 0;
  private readonly seen = new MessageSeen();
  /** 配置里 privateUsers 是 user id；学习到的是 DM channel id，两类要区分 */
  private readonly privateUserIds: Set<string>;
  /** user id → DM channel id；发送私聊时避免每次都调 `/users/@me/channels` */
  private readonly dmChannels = new Map<string, string>();
  /** 被过滤丢弃的会话只告警一次，避免刷屏；键为 `kind:id` */
  private readonly warnedDrops = new Set<string>();

  /**
   * 未显式配置 `groups` / `privateUsers` 时，出站目标取「收到过消息的会话」。
   * 这样默认即全部：不填雪花 id 也能把游戏消息发回频道 / 私聊。
   */
  private readonly learned: LearnedTargets;
  /** 出站目标与两类一次性告警，行为与 QQ / Telegram 共用同一套实现 */
  private readonly targetBook: TargetBook;
  /** 串行出站队列（含积压上限、单目标失败计数） */
  private readonly outbound: OutboundQueue<PendingSend>;
  /** 全局 `privateSync`：打开后即使 `discord.allowPrivate=false` 也接收私聊 */
  private readonly privateSync: boolean;

  public constructor(options: PlatformCreateOptions) {
    this.log = options.log;
    this.kv = options.kv;
    this.settings = parseDiscordSettings(options.settings);
    this.privateSync = options.private === true;
    this.privateUserIds = new Set(this.settings.privateUsers);
    this.backoff = this.settings.reconnectMinMs;
    this.learned = new LearnedTargets({
      key: "discord:targets",
      tag: this.id,
      log: options.log,
      limit: LEARNED_LIMIT,
      ...(options.kv === undefined ? {} : { kv: options.kv }),
    });
    this.targetBook = new TargetBook({
      label: this.id,
      log: this.log,
      learned: this.learned,
      groups: this.settings.groups,
      users: this.settings.privateUsers,
      syncChannels: this.settings.syncChannels,
      noTargetHint:
        "收到频道/私聊消息后会自动补齐；也可把 discord.groups 填成频道 id（频道右键 → 复制链接，末段就是 id）",
      noMirrorHint:
        "在频道里发一条消息即可自动记录，或把 discord.groups 填成频道 id",
    });
    this.outbound = new OutboundQueue<PendingSend>({
      label: this.id,
      title: "Discord",
      limit: OUTBOUND_LIMIT,
      log: this.log,
      targets: this.targetBook,
      isStopping: () => this.stopping,
      send: async (target, pending) =>
        this.sendToTarget(target, pending.text, pending.images ?? []),
    });
  }

  public start(ctx: PlatformContext): void {
    this.ctx = ctx;
    if (ctx.signal.aborted) {
      return;
    }
    ctx.signal.addEventListener(
      "abort",
      () => {
        this.stopping = true;
        this.stopController.abort();
        this.teardown("桥停止");
      },
      { once: true },
    );
    this.loop = this.run().catch((error: unknown) => {
      this.log.error(`[discord] 适配器异常退出：${errorText(error)}`);
    });
  }

  public deliver(message: NormalizedMessage): void {
    if (this.settings.categories !== undefined && !this.settings.categories.includes(message.category)) {
      return;
    }
    const text = formatOutbound(message);
    if (text === "") {
      return;
    }
    this.outbound.push({ id: message.id, text });
  }

  /**
   * 接收其它平台转发来的消息并发送到本平台的会话目标。
   *
   * 与 `deliver` 共用出站队列与限流，但不回流 `ctx.inbound`，因此转发不会
   * 再触发一次入站处理，qq → discord → qq 的环不存在。跨平台不带媒体：
   * Discord 的附件是带签名的临期 URL，别的平台也没有能直接复用的句柄。
   */
  public relay(message: PlatformRelayMessage): void {
    if (this.stopping) {
      return;
    }
    const text = formatRelay(message);
    if (text === "") {
      return;
    }
    this.outbound.push({
      id: `relay:${message.platform}:${message.messageId ?? message.at ?? ""}`,
      text,
    });
  }

  public async stop(reason: string): Promise<void> {
    this.stopping = true;
    this.stopController.abort();
    this.teardown(reason);
    this.outbound.clear();
    this.log.debug?.(`[discord] 停止：${reason}`);
    const loop = this.loop;
    if (loop !== undefined) {
      await Promise.race([loop, sleep(1_000)]);
    }
  }

  // -------------------------------------------------------------------------
  // 连接生命周期
  // -------------------------------------------------------------------------

  private async run(): Promise<void> {
    // 先恢复记住的会话，再连网关：入站消息一到就要能正确算出发给谁。
    await this.learned.load();

    while (!this.stopping) {
      if (this.fatal !== undefined) {
        this.log.error(`[discord] 已停止重连：${this.fatal}`);
        return;
      }
      try {
        await this.ensureIdentity();
        await this.connect();
        this.attempts = 0;
        this.backoff = this.settings.reconnectMinMs;
      } catch (error) {
        if (this.stopping) {
          return;
        }
        if (this.markFatal(error)) {
          continue;
        }
        this.log.warn(`[discord] 连接失败：${errorText(error)}`);
      }

      this.cleanupSocket();
      if (this.stopping) {
        return;
      }
      if (this.fatal !== undefined) {
        continue;
      }

      const closeCode = this.pendingCloseCode;
      this.pendingCloseCode = undefined;
      if (closeCode === RATE_LIMIT_CODE) {
        this.log.warn(`[discord] 触发 Gateway 限流（4008），${RATE_LIMIT_WAIT_MS / 1_000} 秒后重连`);
        await abortableSleep(RATE_LIMIT_WAIT_MS, this.stopController.signal, this.ctx?.signal);
        continue;
      }
      if (closeCode !== undefined) {
        const fatal = FATAL_CLOSE_CODES.get(closeCode);
        if (fatal !== undefined) {
          this.fatal = fatal;
          continue;
        }
        if (SESSION_RESET_CODES.has(closeCode)) {
          this.sessionId = undefined;
          this.lastSeq = null;
          this.log.info(`[discord] 会话不可恢复（关闭码 ${closeCode}），将重新 Identify`);
        }
        // 其余关闭码（1000/1001/4000 等）优先 Resume
      }

      if (this.settings.reconnectMaxAttempts > 0 && this.attempts >= this.settings.reconnectMaxAttempts) {
        this.log.error(`[discord] 达到最大重连次数 ${this.settings.reconnectMaxAttempts}`);
        return;
      }
      this.attempts += 1;
      const wait = jitter(this.backoff);
      this.log.info(`[discord] ${Math.round(wait)} ms 后重连（第 ${this.attempts} 次）`);
      await abortableSleep(wait, this.stopController.signal, this.ctx?.signal);
      this.backoff = Math.min(
        this.settings.reconnectMaxMs,
        Math.max(this.settings.reconnectMinMs, this.backoff * 2),
      );
    }
  }

  /** 用 `/users/@me` 验证 token；成功后只在进程内记一次，不重复调用 */
  private async ensureIdentity(): Promise<void> {
    if (this.identity !== undefined) {
      return;
    }
    const me = await this.apiCall<Record<string, unknown>>("GET", "/users/@me");
    const id = idOf(me["id"]);
    if (id === undefined) {
      throw new DiscordApiError("Discord /users/@me 响应缺少 id", 0);
    }
    const username = stringOf(me["username"]);
    this.identity = { id, ...(username === undefined ? {} : { username }) };
    this.log.info(
      `[discord] 已连接：${username === undefined ? "机器人" : `@${username}`}（id=${id}）`,
    );
  }

  private async connect(): Promise<void> {
    const gatewayUrl = await this.resolveGatewayUrl();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(gatewayUrl, {
        handshakeTimeout: 10_000,
        headers: { "User-Agent": USER_AGENT },
      });
      this.socket = socket;

      // 监听必须在 open 之前挂好：Gateway 连上后立即推 op 10 Hello，
      // 若等 open 回调之后再挂 message，Hello 会在微任务间隙里丢掉。
      socket.on("message", (data: WebSocket.RawData) => {
        this.onFrame(data.toString());
      });
      socket.on("error", (error: Error) => {
        if (!this.stopping && this.fatal === undefined) {
          this.log.warn(`[discord] WebSocket 错误：${errorText(error)}`);
        }
      });
      socket.on("close", (code: number, reason: Buffer) => {
        this.pendingCloseCode = code;
        if (!this.stopping) {
          this.log.info(
            `[discord] WebSocket 关闭（${code}${reason.length > 0 ? ` ${reason.toString()}` : ""}）`,
          );
        }
        this.resolveClosed?.();
      });

      const onError = (error: Error): void => {
        this.socket = undefined;
        socket.terminate();
        reject(error);
      };
      socket.once("open", () => {
        socket.off("error", onError);
        this.log.info("[discord] Gateway 已连接");
        resolve();
      });
      socket.once("error", onError);
    });

    await new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
      if (this.socket === undefined || this.socket.readyState === WebSocket.CLOSED) {
        resolve();
      }
    });
    this.resolveClosed = undefined;
  }

  private async resolveGatewayUrl(): Promise<string> {
    const data = await this.apiCall<Record<string, unknown>>("GET", "/gateway/bot");
    const raw = stringOf(data["url"]);
    if (raw === undefined || !/^wss?:\/\//i.test(raw)) {
      throw new DiscordApiError("Discord /gateway/bot 响应缺少合法的 url", 0);
    }
    const url = new URL(raw);
    url.searchParams.set("v", "10");
    url.searchParams.set("encoding", "json");
    return url.toString();
  }

  private onFrame(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.log.debug?.("[discord] 收到非 JSON 帧，已忽略");
      return;
    }
    const record = objectOf(frame);
    if (record === undefined) {
      return;
    }
    const seq = record["s"];
    if (typeof seq === "number" && Number.isFinite(seq)) {
      this.lastSeq = this.lastSeq === null ? seq : Math.max(this.lastSeq, seq);
    }

    switch (record["op"]) {
      case 10: {
        const data = objectOf(record["d"]) ?? {};
        const interval = typeof data["heartbeat_interval"] === "number" ? data["heartbeat_interval"] : 41_250;
        this.heartbeatMs = Math.max(1_000, Math.floor(interval * 0.9));
        this.startHeartbeat();
        this.log.debug?.(`[discord] Hello，心跳间隔 ${this.heartbeatMs} ms`);
        if (this.sessionId !== undefined && this.lastSeq !== null) {
          this.resume();
        } else {
          this.identify();
        }
        return;
      }
      case 0: {
        this.onDispatch(String(record["t"] ?? ""), record["d"]);
        return;
      }
      case 1: {
        // 服务端要求立即心跳
        this.sendHeartbeat();
        return;
      }
      case 7: {
        this.log.info("[discord] 服务端要求重连（op 7）");
        this.closeSocket(4_000, "server reconnect");
        return;
      }
      case 9: {
        if (record["d"] !== true) {
          this.sessionId = undefined;
          this.lastSeq = null;
        }
        this.log.info("[discord] 会话失效（op 9），准备重连");
        this.closeSocket(4_000, "invalid session");
        return;
      }
      case 11: {
        this.heartbeatAcked = true;
        return;
      }
      default:
        this.log.debug?.(`[discord] 未处理的 op：${String(record["op"])}`);
    }
  }

  private onDispatch(type: string, data: unknown): void {
    const event = objectOf(data) ?? {};
    switch (type) {
      case "READY": {
        const sessionId = stringOf(event["session_id"]);
        if (sessionId !== undefined) {
          this.sessionId = sessionId;
        }
        const user = objectOf(event["user"]);
        const userId = user === undefined ? undefined : idOf(user["id"]);
        const username = user === undefined ? undefined : stringOf(user["username"]);
        if (userId !== undefined) {
          this.identity = { id: userId, ...(username === undefined ? {} : { username }) };
        }
        this.attempts = 0;
        this.backoff = this.settings.reconnectMinMs;
        this.log.info(
          `[discord] Gateway 已就绪（${username === undefined ? "机器人" : `@${username}`}，` +
            `session=${this.sessionId ?? "-"}）`,
        );
        return;
      }
      case "RESUMED": {
        this.attempts = 0;
        this.backoff = this.settings.reconnectMinMs;
        this.log.info("[discord] 会话已恢复");
        return;
      }
      case "MESSAGE_CREATE": {
        this.onMessage(event);
        return;
      }
      default:
        this.log.debug?.(`[discord] 忽略事件 ${type}`);
    }
  }

  private identify(): void {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(
        JSON.stringify({
          op: 2,
          d: {
            token: this.settings.botToken,
            intents: DEFAULT_INTENTS,
            properties: {
              os: process.platform,
              browser: "mcsup-chat-bridge",
              device: "mcsup-chat-bridge",
            },
          },
        }),
      );
      this.log.debug?.("[discord] Identify 已发送");
    } catch (error) {
      this.log.warn(`[discord] Identify 失败：${errorText(error)}`);
      this.closeSocket(4_000, "identify failed");
    }
  }

  private resume(): void {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(
        JSON.stringify({
          op: 6,
          d: {
            token: this.settings.botToken,
            session_id: this.sessionId,
            seq: this.lastSeq,
          },
        }),
      );
      this.log.debug?.(`[discord] Resume 已发送（seq=${this.lastSeq ?? 0}）`);
    } catch (error) {
      this.log.warn(`[discord] Resume 失败：${errorText(error)}`);
      this.sessionId = undefined;
      this.lastSeq = null;
      this.closeSocket(4_000, "resume failed");
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const socket = this.socket;
    if (socket === undefined) {
      return;
    }
    this.heartbeatAcked = true;
    this.heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (!this.heartbeatAcked) {
        this.log.warn("[discord] 心跳未确认，主动重连");
        this.closeSocket(4_000, "heartbeat timeout");
        return;
      }
      this.sendHeartbeat();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private sendHeartbeat(): void {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.heartbeatAcked = false;
    try {
      socket.send(JSON.stringify({ op: 1, d: this.lastSeq }));
    } catch {
      socket.terminate();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.socket;
    if (socket === undefined) {
      return;
    }
    try {
      socket.close(code, reason.slice(0, 100));
    } catch {
      socket.terminate();
    }
  }

  /** 停止时断开连接；幂等，重复调用不会重复关闭 */
  private teardown(reason: string): void {
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      try {
        socket.close(1_000, reason.slice(0, 100));
      } catch {
        socket.terminate();
      }
      const timer = setTimeout(() => {
        socket.terminate();
      }, 500);
      timer.unref?.();
    }
  }

  /** 一次连接结束后的清理：保留 session 供 Resume，不清空会话 id */
  private cleanupSocket(): void {
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    if (socket !== undefined) {
      socket.removeAllListeners();
      try {
        socket.terminate();
      } catch {
        // 已经关闭
      }
    }
  }

  private markFatal(error: unknown): boolean {
    if (!(error instanceof DiscordApiError)) {
      return false;
    }
    if (error.status === 401) {
      this.fatal = "bot token 无效（401），请检查 discord.botToken";
      return true;
    }
    if (error.status === 403) {
      this.fatal = "Discord 拒绝访问（403），请检查 bot token 与 Developer Portal 的权限";
      return true;
    }
    if (error.status === 404) {
      this.fatal = `Discord 返回 404（${error.message}），请检查 discord.apiBase 与 bot token`;
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // 入站
  // -------------------------------------------------------------------------

  private onMessage(message: Record<string, unknown>): void {
    const ctx = this.ctx;
    if (ctx === undefined) {
      return;
    }
    const channelId = idOf(message["channel_id"]);
    if (channelId === undefined) {
      return;
    }
    const guildId = idOf(message["guild_id"]);
    const isGroup = guildId !== undefined;

    const author = objectOf(message["author"]);
    // 机器人自己的消息（以及其它 bot / webhook）不回灌，避免自激。
    if (author === undefined || author["bot"] === true) {
      return;
    }
    const senderId = idOf(author["id"]);
    if (senderId === undefined) {
      return;
    }
    if (this.identity !== undefined && senderId === this.identity.id) {
      return;
    }

    const messageId = idOf(message["id"]);
    if (messageId !== undefined) {
      if (this.seen.has(messageId)) {
        return;
      }
      this.seen.remember(messageId);
    }

    const text = discordInboundText(message);
    if (text === "") {
      return;
    }

    const senderName = displayNameOf(author, senderId);
    if (this.settings.allowedUsers.length > 0 && !this.settings.allowedUsers.includes(senderId)) {
      this.warnDropped(isGroup, channelId, senderId, "发言人不在 discord.allowedUsers 白名单");
      return;
    }
    if (isGroup) {
      if (this.settings.guilds.length > 0 && (guildId === undefined || !this.settings.guilds.includes(guildId))) {
        this.warnDropped(isGroup, channelId, senderId, "服务器不在 discord.guilds 白名单");
        return;
      }
      if (this.settings.groups.length > 0 && !this.settings.groups.includes(channelId)) {
        this.warnDropped(isGroup, channelId, senderId, "频道不在 discord.groups 白名单");
        return;
      }
    } else {
      if (!this.allowPrivate()) {
        this.warnDropped(
          isGroup,
          channelId,
          senderId,
          "私聊未启用（discord.allowPrivate=false）；如需接收私聊，把 discord.allowPrivate 设为 true，" +
            "或在安装向导里打开「同步私聊消息」",
        );
        return;
      }
      if (this.settings.privateUsers.length > 0 && !this.settings.privateUsers.includes(senderId)) {
        this.warnDropped(isGroup, channelId, senderId, "私聊对象不在 discord.privateUsers 白名单");
        return;
      }
    }

    this.learnChannel(isGroup, channelId, senderId);
    const channelKey = targetKey(isGroup ? "group" : "private", channelId);
    if (!this.warnedDrops.has(`seen:${channelKey}`)) {
      this.warnedDrops.add(`seen:${channelKey}`);
      this.log.info(
        isGroup
          ? `[discord] 收到频道消息：channel_id=${channelId}，作者=${senderName}（user_id=${senderId}）`
          : `[discord] 收到私聊：channel_id=${channelId}，作者=${senderName}（user_id=${senderId}）`,
      );
    }

    const timestamp = stringOf(message["timestamp"]);
    const at =
      timestamp === undefined || Number.isNaN(Date.parse(timestamp))
        ? undefined
        : new Date(Date.parse(timestamp)).toISOString();
    const inbound: PlatformInboundMessage = {
      platform: this.id,
      channel: { kind: isGroup ? "group" : "private", id: channelId },
      author: { id: senderId, name: senderName },
      text,
      label: this.settings.label,
      ...(this.settings.inbound ? {} : { inject: false }),
      ...(messageId === undefined ? {} : { messageId }),
      ...(at === undefined ? {} : { at }),
      ...(this.settings.server === undefined ? {} : { server: this.settings.server }),
    };
    ctx.inbound(inbound);

    const images = this.settings.forwardMedia ? discordInboundImages(message) : [];
    this.mirrorToOtherChannels(isGroup, channelId, senderName, text, images);
  }

  /**
   * 群聊与私聊互相同步（`discord.syncChannels`，默认开启）。
   *
   * 收到 Discord 消息后，把它再发到「除来源会话之外」的其它会话：频道里发的
   * 进私聊，私聊发的进频道。跳过来源会话是为了避免把消息原样回发到发源地；
   * 机器人自己发的消息不会再触发入站，因此不会形成回环。
   */
  private mirrorToOtherChannels(
    isGroup: boolean,
    channelId: string,
    displayName: string,
    text: string,
    images: readonly string[],
  ): void {
    if (!this.settings.syncChannels || this.stopping || text === "") {
      return;
    }
    const exclude = targetKey(isGroup ? "group" : "private", channelId);
    const hasOtherTarget = this.targetBook
      .targets()
      .some((target) => targetKey(target.kind, target.id) !== exclude);
    if (!hasOtherTarget) {
      this.targetBook.warnNoMirrorTarget(isGroup);
      return;
    }
    // 图片会作为 embed 跟在文字后面重发，把对应占位去掉，避免同一条消息里重复。
    const shownText =
      images.length === 0 ? text : text.replace(/\[图片\]/g, "").trim();
    const head = `[${isGroup ? "群" : "私聊"}] ${displayName}`;
    const caption = shownText === "" ? head : `${head}: ${shownText}`;
    this.outbound.push({
      id: `mirror:${exclude}`,
      text: caption,
      exclude,
      ...(images.length === 0 ? {} : { images }),
    });
  }

  /** 记住会话，作为留空配置时的出站目标；超上限丢最早的 */
  private learnChannel(isGroup: boolean, channelId: string, userId: string): void {
    this.learned.remember(isGroup ? "group" : "private", channelId);
    if (!isGroup) {
      // 配置里的 privateUsers 是 user id；顺手把这次私聊的 DM channel id 缓存，
      // 之后给同一个用户发消息就不用再调 `/users/@me/channels`。
      this.cacheDmChannel(userId, channelId);
    }
  }

  /** 私聊是否可接收：平台自己的开关与全局 `privateSync` 取并集 */
  private allowPrivate(): boolean {
    return this.settings.allowPrivate || this.privateSync;
  }

  /**
   * 入站被过滤时告警一次（每个会话独立），并带上可填进配置的 id。
   *
   * Discord 的频道 id / user id 要经「开发者模式 → 复制 id」才能拿到，静默丢弃
   * 会让人以为适配器坏了，所以把可填进配置的值一起打出来。
   */
  private warnDropped(
    isGroup: boolean,
    channelId: string,
    senderId: string,
    reason: string,
  ): void {
    const key = targetKey(isGroup ? "group" : "private", channelId);
    if (this.warnedDrops.has(key)) {
      return;
    }
    this.warnedDrops.add(key);
    this.log.warn(
      isGroup
        ? `[discord] 丢弃频道消息（${reason}）：channel_id=${channelId}，作者 user_id=${senderId}`
        : `[discord] 丢弃私聊（${reason}）：channel_id=${channelId}，作者 user_id=${senderId}`,
    );
  }

  // -------------------------------------------------------------------------
  // 出站
  // -------------------------------------------------------------------------

  /** 先解析 DM channel，再按长度分片发文字；图片作为最后一篇的 embed */
  private async sendToTarget(
    target: OutboundTarget,
    text: string,
    images: readonly string[],
  ): Promise<void> {
    const channelId = await this.channelOf(target);
    const chunks = splitText(text, this.settings.maxLength);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        continue;
      }
      const last = index === chunks.length - 1;
      const embeds =
        last && images.length > 0
          ? images.slice(0, MAX_EMBEDS).map((url) => ({ image: { url } }))
          : [];
      await this.sendWithRetry(channelId, {
        content: chunk,
        allowed_mentions: { parse: [] },
        ...(embeds.length === 0 ? {} : { embeds }),
      });
    }
  }

  /**
   * 解析出站频道：
   * - 群聊目标直接就是 channel id；
   * - 配置里的私聊目标（`privateUsers`）是 user id，需要换成 DM channel id；
   * - 学习到的私聊目标已经是 DM channel id，直接使用。
   */
  private async channelOf(target: OutboundTarget): Promise<string> {
    if (target.kind === "group") {
      return target.id;
    }
    if (!this.privateUserIds.has(target.id)) {
      return target.id;
    }
    const cached = this.dmChannels.get(target.id);
    if (cached !== undefined) {
      return cached;
    }
    const channel = await this.apiCall<Record<string, unknown>>("POST", "/users/@me/channels", {
      recipient_id: target.id,
    });
    const channelId = idOf(channel["id"]);
    if (channelId === undefined) {
      throw new DiscordApiError("Discord /users/@me/channels 响应缺少 id", 0);
    }
    this.cacheDmChannel(target.id, channelId);
    return channelId;
  }

  private cacheDmChannel(userId: string, channelId: string): void {
    this.dmChannels.set(userId, channelId);
    if (this.dmChannels.size > DM_CACHE_LIMIT) {
      const oldest = this.dmChannels.keys().next();
      if (!oldest.done) {
        this.dmChannels.delete(oldest.value);
      }
    }
  }

  private async sendWithRetry(channelId: string, payload: Record<string, unknown>): Promise<void> {
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      await this.pace();
      try {
        await this.apiCall("POST", `/channels/${channelId}/messages`, payload);
        this.log.debug?.(`[discord] 已发送到频道 ${channelId}：${previewOf(payload)}`);
        return;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        if (!(error instanceof DiscordApiError)) {
          if (attempt < SEND_ATTEMPTS) {
            await abortableSleep(300 * attempt, this.stopController.signal, this.ctx?.signal);
            continue;
          }
          throw error;
        }
        const retryable = error.status === 0 || error.status === 429 || error.status >= 500;
        // 401/403/404 属凭证或权限问题，重试只会刷屏。
        if (!retryable || attempt === SEND_ATTEMPTS) {
          throw error;
        }
        const wait = error.retryAfterMs ?? Math.min(5_000, 500 * attempt);
        await abortableSleep(wait, this.stopController.signal, this.ctx?.signal);
      }
    }
  }

  /** 全局最小发送间隔：Discord 每个频道约 5 条/5 秒，统一慢一点更稳 */
  private async pace(): Promise<void> {
    if (this.settings.sendIntervalMs <= 0) {
      return;
    }
    const wait = this.settings.sendIntervalMs - (Date.now() - this.lastSendAt);
    if (wait > 0) {
      await abortableSleep(wait, this.stopController.signal, this.ctx?.signal);
    }
    this.lastSendAt = Date.now();
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private async apiCall<T = Record<string, unknown>>(
    method: "GET" | "POST",
    route: string,
    body?: Record<string, unknown>,
    timeoutMs = this.settings.apiTimeoutMs,
  ): Promise<T> {
    // 注意：Authorization 里含 token，任何日志都不要打印请求头。
    let response: Response;
    try {
      response = await fetch(`${this.settings.apiBase}${route}`, {
        method,
        headers: {
          Authorization: `Bot ${this.settings.botToken}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: this.requestSignal(timeoutMs),
      });
    } catch (error) {
      // abort 来自停止或本次请求超时：原样抛出，不能让重试逻辑把它当成网络故障
      if (isAbortError(error)) {
        throw error;
      }
      throw new DiscordApiError(`Discord ${method} ${route} 网络错误：${errorText(error)}`, 0);
    }

    const text = await response.text().catch(() => "");
    let parsed: Record<string, unknown> = {};
    if (text.trim() !== "") {
      try {
        const value = JSON.parse(text) as unknown;
        parsed = objectOf(value) ?? {};
      } catch {
        throw new DiscordApiError(`Discord ${method} ${route} 响应不是 JSON`, response.status);
      }
    }

    if (!response.ok) {
      const code = typeof parsed["code"] === "number" ? parsed["code"] : undefined;
      const message = stringOf(parsed["message"]) ?? text.slice(0, 200);
      const retryAfter = typeof parsed["retry_after"] === "number" ? parsed["retry_after"] : undefined;
      throw new DiscordApiError(
        `Discord ${method} ${route} 失败 [${response.status}]：${message}`,
        response.status,
        code,
        retryAfter === undefined ? undefined : Math.max(250, retryAfter * 1_000),
      );
    }

    return parsed as T;
  }

  /** 把 ctx 的停止信号、本适配器的停止信号与超时组合成一个 AbortSignal */
  private requestSignal(timeoutMs: number): AbortSignal {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    timer.unref?.();

    const sources: AbortSignal[] = [this.stopController.signal];
    const ctxSignal = this.ctx?.signal;
    if (ctxSignal !== undefined) {
      sources.push(ctxSignal);
    }
    const cleanups: Array<() => void> = [];
    controller.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        for (const cleanup of cleanups) {
          cleanup();
        }
      },
      { once: true },
    );
    for (const source of sources) {
      if (source.aborted) {
        controller.abort();
        break;
      }
      const onAbort = (): void => {
        controller.abort();
      };
      source.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => {
        source.removeEventListener("abort", onAbort);
      });
    }
    return controller.signal;
  }
}

export const discordPlatformFactory: PlatformFactory = {
  id: "discord",
  title: "Discord",
  description: "Discord Bot Gateway（WebSocket）+ REST API v10，频道/私聊双向互通",
  create(options) {
    return new DiscordPlatform(options);
  },
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** Discord 显示名优先全局昵称，其次用户名，最后回落到 id */
function displayNameOf(author: Record<string, unknown>, fallback: string): string {
  return (
    stringOf(author["global_name"]) ??
    stringOf(author["username"]) ??
    fallback
  );
}

function previewOf(payload: Record<string, unknown>): string {
  const text = stringOf(payload["content"]);
  return text === undefined ? "[消息]" : text.slice(0, 60);
}