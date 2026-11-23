/**
 * Telegram 平台适配器：Bot API 长轮询（`getUpdates`）
 *
 * 协议依据（Telegram Bot API 文档）：
 * - 出站：`POST {apiBase}/bot{token}/sendMessage`（HTML 解析模式）、
 *   `sendPhoto` / `sendVideo` / `sendAnimation` / `sendDocument`；
 * - 入站：`POST /getUpdates` 长轮询，`offset = 最后一个 update_id + 1`，
 *   只订阅 `message`（编辑消息会与入站去重冲突，默认不收）；
 * - 冲突：同一 bot 只能有一个 `getUpdates` 消费者。检测到 webhook 占位
 *   （409）时自动 `deleteWebhook` 一次，之后仍冲突则退避重试。
 *
 * 设计取舍：
 * - 插件运行在宿主沙箱里，没有公网入口，因此不用 webhook，只做长轮询。
 *   offset 持久化到宿主 `storage:kv`，重启后不会重复收取旧消息。
 * - 出站用 HTML 解析模式并转义 `&` / `<` / `>`：玩家名或聊天里的符号不会
 *   破坏消息结构，视觉上仍是 `[玩家名]:消息`（与 QQ 适配器一致）。
 * - 群/私聊镜像复用 Telegram 的 `file_id`：同一个机器人可以把收到的
 *   photo/document 直接转发到别的会话，不需要重新下载或上传。
 * - 论坛群（supergroup + topics）记住收到的 `message_thread_id`，出站回到
 *   同一个话题；`General` 话题的 id 固定为 1，发送时省略。
 */

import { PluginError } from "mcsup-plugin";
import type { LogClient } from "mcsup-plugin";

import { LearnedTargets } from "../core/targets.js";
import { CATEGORIES } from "../core/types.js";
import type { MessageCategory, NormalizedMessage } from "../core/types.js";
import { formatOutbound } from "./format.js";
import type {
  ChatPlatform,
  PlatformContext,
  PlatformCreateOptions,
  PlatformFactory,
  PlatformInboundMessage,
} from "./types.js";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/** 解析后的 Telegram 配置；数值都有默认值，工厂不做额外 IO */
export interface TelegramSettings {
  /** @BotFather 发放的 bot token（形如 `123456:AAAA...`） */
  readonly botToken: string;
  /** Bot API 基址；默认 `https://api.telegram.org`，自建 Bot API 服务时改这里 */
  readonly apiBase: string;
  /** 出站目标 chat_id；同时作为入站白名单。留空 = 全部（发给收到过消息的会话） */
  readonly groups: readonly string[];
  /** 出站私聊 user id。留空 = 全部（发给给机器人发过消息的用户） */
  readonly privateUsers: readonly string[];
  /** 入站发言人白名单；留空表示不限 */
  readonly allowedUsers: readonly string[];
  /** 出站类别过滤；省略时沿用全局 forwardCategories */
  readonly categories?: readonly MessageCategory[];
  readonly inbound: boolean;
  readonly allowPrivate: boolean;
  /** 群聊与私聊互相同步；只影响 Telegram 内部会话 */
  readonly syncChannels: boolean;
  /** 群/私聊互转时是否转发图片/视频/文件（复用 `file_id`） */
  readonly forwardMedia: boolean;
  readonly label: string;
  readonly server?: string;
  readonly maxLength: number;
  /** 是否在消息里展开链接预览；默认关闭，避免刷屏 */
  readonly linkPreview: boolean;
  readonly sendIntervalMs: number;
  readonly apiTimeoutMs: number;
  /** getUpdates 长轮询等待秒数；Bot API 上限 50 */
  readonly pollTimeoutSecs: number;
  /** 单次 getUpdates 最多取多少条；Bot API 上限 100 */
  readonly pollLimit: number;
  readonly reconnectMinMs: number;
  readonly reconnectMaxMs: number;
  /** 0 表示无限重试 */
  readonly reconnectMaxAttempts: number;
}

const DEFAULT_API_BASE = "https://api.telegram.org";
const USER_AGENT = "mcsup-chat-bridge/0.1.21 (TelegramBotAdapter)";

/** Telegram 单条文本上限 */
const TEXT_LIMIT = 4_096;
/** 出站队列上限：分发层之外再兜一层，避免断线期间无限堆积 */
const OUTBOUND_LIMIT = 512;
/** 已处理消息 id 的记忆上限，用于抵御平台重发 */
const SEEN_LIMIT = 1_000;
/** 留空配置时自动记住的会话上限（群 / 私聊各自） */
const LEARNED_LIMIT = 64;
/** 单次出站失败后的重试次数（首次 + 2 次重试） */
const SEND_ATTEMPTS = 3;
/** offset 的 KV 键；按 SDK 习惯用 `<命名空间>:<键>` */
const OFFSET_KEY = "telegram:offset";
/** 论坛群的 General 话题 id；发送时省略，否则 Telegram 会拒绝 */
const GENERAL_TOPIC_ID = 1;
/** webhook 冲突（409）的默认等待；另一实例/未清理的 webhook 都不是瞬时问题 */
const CONFLICT_WAIT_MS = 10_000;

/**
 * 校验并补全配置。
 *
 * 缺 botToken 时抛 `invalid_input`，让宿主在启动阶段回滚配置，而不是等到
 * 第一条消息才静默失败。
 */
export function parseTelegramSettings(raw: unknown): TelegramSettings {
  if (typeof raw !== "object" || raw === null) {
    throw new PluginError(
      "invalid_input",
      "平台 telegram 缺少配置：请填写 @BotFather 发放的 botToken；只用 QQ 时请从 platforms 移除 telegram",
    );
  }
  const record = raw as Record<string, unknown>;
  const botToken = stringOf(record["botToken"]);
  if (botToken === undefined) {
    throw new PluginError(
      "invalid_input",
      "平台 telegram 缺少 botToken：在 Telegram 里找 @BotFather，用 /newbot 或 /token 获取；只用 QQ 时请从 platforms 移除 telegram",
    );
  }

  const categories = categoriesOf(record["categories"]);
  const server = stringOf(record["server"]);

  return {
    botToken,
    apiBase: urlOf(record["apiBase"]) ?? DEFAULT_API_BASE,
    groups: stringsOf(record["groups"]),
    privateUsers: stringsOf(record["privateUsers"]),
    allowedUsers: stringsOf(record["allowedUsers"]),
    ...(categories === undefined ? {} : { categories }),
    inbound: boolOf(record["inbound"], true),
    allowPrivate: boolOf(record["allowPrivate"], false),
    syncChannels: boolOf(record["syncChannels"], true),
    forwardMedia: boolOf(record["forwardMedia"], true),
    label: stringOf(record["label"]) ?? "Telegram",
    ...(server === undefined ? {} : { server }),
    maxLength: intOf(record["maxLength"], 3_500, 64, TEXT_LIMIT),
    linkPreview: boolOf(record["linkPreview"], false),
    sendIntervalMs: intOf(record["sendIntervalMs"], 1_000, 0, 10_000),
    apiTimeoutMs: intOf(record["apiTimeoutMs"], 15_000, 1_000, 60_000),
    pollTimeoutSecs: intOf(record["pollTimeoutSecs"], 30, 1, 50),
    pollLimit: intOf(record["pollLimit"], 100, 1, 100),
    reconnectMinMs: intOf(record["reconnectMinMs"], 1_000, 200, 60_000),
    reconnectMaxMs: intOf(record["reconnectMaxMs"], 60_000, 1_000, 600_000),
    reconnectMaxAttempts: intOf(record["reconnectMaxAttempts"], 0, 0, 10_000),
  };
}

// ---------------------------------------------------------------------------
// 入站归一化
// ---------------------------------------------------------------------------

/** 可跨会话转发的媒体；`file_id` 由接收消息的机器人持有，可直接复用 */
export interface TelegramInboundMedia {
  readonly kind: "photo" | "video" | "animation" | "document";
  readonly fileId: string;
}

/**
 * 把 Telegram 原生消息归一为纯文本。
 *
 * 正文取 `text` 或 `caption`，媒体按类型追加占位文本：图片、视频、动图、
 * 语音、音频、视频消息、表情、文件、位置、投票、联系人、骰子。一个消息
 * 只会有一种媒体（GIF 会同时带 `animation` 与 `document`，按 `animation`
 * 记一次）。
 */
export function telegramInboundText(message: Record<string, unknown>): string {
  const base = stringOf(message["text"]) ?? stringOf(message["caption"]) ?? "";
  const markers: string[] = [];

  const photo = largestPhotoFileId(message);
  if (photo !== undefined) {
    markers.push("[图片]");
  } else if (objectOf(message["video"]) !== undefined) {
    markers.push("[视频]");
  } else if (objectOf(message["animation"]) !== undefined) {
    markers.push("[动图]");
  } else if (objectOf(message["video_note"]) !== undefined) {
    markers.push("[视频消息]");
  } else if (objectOf(message["voice"]) !== undefined) {
    markers.push("[语音]");
  } else if (objectOf(message["audio"]) !== undefined) {
    markers.push("[音频]");
  } else if (objectOf(message["sticker"]) !== undefined) {
    const emoji = stringOf(objectOf(message["sticker"])?.["emoji"]);
    markers.push(emoji === undefined ? "[表情]" : `[表情 ${emoji}]`);
  } else if (objectOf(message["document"]) !== undefined) {
    const name = stringOf(objectOf(message["document"])?.["file_name"]);
    markers.push(name === undefined ? "[文件]" : `[文件: ${name}]`);
  } else if (objectOf(message["location"]) !== undefined || objectOf(message["venue"]) !== undefined) {
    markers.push("[位置]");
  } else if (objectOf(message["poll"]) !== undefined) {
    markers.push("[投票]");
  } else if (objectOf(message["contact"]) !== undefined) {
    markers.push("[联系人]");
  } else if (objectOf(message["dice"]) !== undefined) {
    markers.push("[骰子]");
  }

  return `${base} ${markers.join(" ")}`.replace(/\s+/g, " ").trim();
}

/** 提取可转发媒体；一条 Telegram 消息最多一个媒体段 */
export function telegramInboundMedia(
  message: Record<string, unknown>,
): TelegramInboundMedia[] {
  const photo = largestPhotoFileId(message);
  if (photo !== undefined) {
    return [{ kind: "photo", fileId: photo }];
  }
  const video = objectOf(message["video"]);
  const videoId = video === undefined ? undefined : stringOf(video["file_id"]);
  if (videoId !== undefined) {
    return [{ kind: "video", fileId: videoId }];
  }
  const animation = objectOf(message["animation"]);
  const animationId = animation === undefined ? undefined : stringOf(animation["file_id"]);
  if (animationId !== undefined) {
    return [{ kind: "animation", fileId: animationId }];
  }
  const document = objectOf(message["document"]);
  const documentId = document === undefined ? undefined : stringOf(document["file_id"]);
  if (documentId !== undefined) {
    return [{ kind: "document", fileId: documentId }];
  }
  return [];
}

/** Telegram 的 photo 是 `PhotoSize[]`，最后一个尺寸最大 */
function largestPhotoFileId(message: Record<string, unknown>): string | undefined {
  const photos = Array.isArray(message["photo"]) ? message["photo"] : [];
  for (let index = photos.length - 1; index >= 0; index -= 1) {
    const photo = objectOf(photos[index]);
    const id = photo === undefined ? undefined : stringOf(photo["file_id"]);
    if (id !== undefined) {
      return id;
    }
  }
  return undefined;
}

/**
 * 转义 Telegram HTML 解析模式里必须编码的三个字符
 */
export function escapeTelegramHtml(text: string): string {
  if (!/[&<>]/.test(text)) {
    return text;
  }
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 转义后按 UTF-16 码元分片（Telegram 按 `text.length` 计长）。
 *
 * 不能先分片再转义：`&` / `<` / `>` 转义后会变长（最多 5 倍），一条全是 `&`
 * 的消息会越过 4096 被 Telegram 拒绝。也不能对转义后的字符串直接切：切在
 * `&amp;` 中间会产生非法实体。这里先整体转义，再切在实体边界与代理对之外。
 */
export function splitTelegramHtml(text: string, max: number): string[] {
  const limit = Math.max(2, Math.min(max, TEXT_LIMIT));
  const escaped = escapeTelegramHtml(text);
  if (escaped.length <= limit) {
    return [escaped];
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < escaped.length) {
    let end = Math.min(start + limit, escaped.length);
    // 若 `&...;` 实体跨过边界，就切在 `&` 之前（多分一片，但不会产生半个实体）
    const amp = escaped.lastIndexOf("&", end - 1);
    if (amp > start && escaped.indexOf(";", amp) >= end) {
      end = amp;
    }
    // 不在代理对中间下刀，避免把 emoji 切成半个字符
    const last = escaped.charCodeAt(end - 1);
    if (end < escaped.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }
    if (end <= start) {
      end = Math.min(start + limit + 1, escaped.length);
    }
    chunks.push(escaped.slice(start, end));
    start = end;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

interface OutboundTarget {
  readonly kind: "group" | "private";
  readonly id: string;
}

interface PendingSend {
  /** 用于日志的标识（游戏消息用消息 id，镜像消息用 `mirror:...`） */
  readonly id: string;
  /** 已经格式化好的出站文本 */
  readonly text: string;
  /** 需要跳过的目标（`kind:id`），用于群/私聊镜像时不回发来源会话 */
  readonly exclude?: string;
  /** 随消息一起转发的媒体；先发文字，再逐条发媒体 */
  readonly media?: readonly TelegramInboundMedia[];
}

class TelegramApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
    public readonly retryAfterMs?: number,
    public readonly migrateToChatId?: string,
  ) {
    super(message);
  }
}

/** 媒体类型 → Bot API 方法与文件字段 */
const MEDIA_SPEC = {
  photo: { method: "sendPhoto", field: "photo" },
  video: { method: "sendVideo", field: "video" },
  animation: { method: "sendAnimation", field: "animation" },
  document: { method: "sendDocument", field: "document" },
} as const satisfies Record<
  TelegramInboundMedia["kind"],
  { readonly method: string; readonly field: string }
>;

export class TelegramPlatform implements ChatPlatform {
  public readonly id = "telegram";
  public readonly title = "Telegram";

  private readonly settings: TelegramSettings;
  private readonly log: LogClient;
  private readonly kv: PlatformCreateOptions["kv"];
  private ctx: PlatformContext | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private readonly stopController = new AbortController();
  private fatal: string | undefined;

  /** 最近一次 `getUpdates` 的游标；`last_update_id + 1` */
  private offset = 0;
  private offsetWarned = false;
  private webhookCleared = false;
  private identity: { readonly id: string } | undefined;

  private backoff: number;
  private attempts = 0;

  private lastSendAt = 0;
  private sending = false;
  private warnedNoTarget = false;
  /** 「私聊镜像发不到群」只告警一次，避免每条私聊都刷屏 */
  private warnedNoMirror = false;
  private readonly outQueue: PendingSend[] = [];
  private readonly seen = new Map<string, number>();
  /** 论坛群的话题 id：群 chat_id → message_thread_id */
  private readonly threads = new Map<string, number>();
  /** 被过滤丢弃的会话只告警一次，避免刷屏；键为 `kind:id` */
  private readonly warnedDrops = new Set<string>();
  private readonly warnedMigration = new Set<string>();

  /**
   * 未显式配置 `groups` / `privateUsers` 时，出站目标取「收到过消息的会话」。
   * 这样默认即全部：不填数字 id 也能把游戏消息发回群里 / 私聊。
   */
  private readonly learned: LearnedTargets;

  public constructor(options: PlatformCreateOptions) {
    this.log = options.log;
    this.kv = options.kv;
    this.settings = parseTelegramSettings(options.settings);
    this.backoff = this.settings.reconnectMinMs;
    this.learned = new LearnedTargets({
      key: "telegram:targets",
      tag: this.id,
      log: options.log,
      limit: LEARNED_LIMIT,
      ...(options.kv === undefined ? {} : { kv: options.kv }),
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
      },
      { once: true },
    );
    this.loop = this.run().catch((error: unknown) => {
      this.log.error(`[telegram] 适配器异常退出：${errorText(error)}`);
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
    this.enqueue({ id: message.id, text });
  }

  /** 入队一条已格式化的出站消息；超限时丢最旧，避免断线期间无限堆积 */
  private enqueue(pending: PendingSend): void {
    if (this.outQueue.length >= OUTBOUND_LIMIT) {
      this.outQueue.shift();
      this.log.warn(`[telegram] 出站积压超过 ${OUTBOUND_LIMIT} 条，丢弃最旧消息`);
    }
    this.outQueue.push(pending);
    // 分发层只调用同步的 `deliver`，这里必须自己兜住异步失败，否则会变成
    // 未处理的 Promise rejection（进程级告警）。
    void this.flushOutbound().catch((error: unknown) => {
      this.log.warn(`[telegram] 出站队列异常：${errorText(error)}`);
    });
  }

  public async stop(reason: string): Promise<void> {
    this.stopping = true;
    this.stopController.abort();
    this.outQueue.length = 0;
    this.log.debug?.(`[telegram] 停止：${reason}`);
    const loop = this.loop;
    if (loop !== undefined) {
      await Promise.race([loop, sleep(1_000)]);
    }
  }

  // -------------------------------------------------------------------------
  // 长轮询生命周期
  // -------------------------------------------------------------------------

  private async run(): Promise<void> {
    // 先恢复记住的会话与 offset，再开始收消息：入站一到就要能正确算出发给谁，
    // 重启后也不重复处理已经确认过的 update。
    await this.learned.load();
    await this.loadOffset();

    while (!this.stopping) {
      if (this.fatal !== undefined) {
        this.log.error(`[telegram] 已停止重连：${this.fatal}`);
        return;
      }
      try {
        await this.ensureIdentity();
        await this.poll();
        this.attempts = 0;
        this.backoff = this.settings.reconnectMinMs;
      } catch (error) {
        if (this.stopping) {
          return;
        }
        if (this.markFatal(error)) {
          continue;
        }
        if (error instanceof TelegramApiError && error.status === 409 && !this.webhookCleared) {
          // 同一 bot 只能有一个 getUpdates 消费者：webhook 占位时自动清理一次。
          this.webhookCleared = true;
          await this.deleteWebhook();
          continue;
        }
        if (this.settings.reconnectMaxAttempts > 0 && this.attempts >= this.settings.reconnectMaxAttempts) {
          this.log.error(`[telegram] 达到最大重连次数 ${this.settings.reconnectMaxAttempts}`);
          return;
        }
        this.attempts += 1;
        const wait = this.waitFor(error);
        this.log.warn(`[telegram] 长轮询失败：${errorText(error)}`);
        this.log.info(`[telegram] ${Math.round(wait)} ms 后重试（第 ${this.attempts} 次）`);
        await this.abortableSleep(wait);
        this.backoff = Math.min(
          this.settings.reconnectMaxMs,
          Math.max(this.settings.reconnectMinMs, this.backoff * 2),
        );
      }
    }
  }

  /** 用 `getMe` 验证 token；成功后只在进程内记一次，不重复调用 */
  private async ensureIdentity(): Promise<void> {
    if (this.identity !== undefined) {
      return;
    }
    const me = await this.apiCall<Record<string, unknown>>("getMe", undefined);
    const id = idOf(me["id"]);
    if (id === undefined) {
      throw new TelegramApiError("Telegram getMe 响应缺少 id", 0);
    }
    const username = stringOf(me["username"]);
    this.identity = { id };
    this.log.info(
      `[telegram] 已连接：${username === undefined ? "机器人" : `@${username}`}（id=${id}）`,
    );
  }

  private async poll(): Promise<void> {
    const timeoutSecs = this.settings.pollTimeoutSecs;
    // 长轮询会一直挂到超时，HTTP 客户端要比它多留余量。
    const budget = Math.max(this.settings.apiTimeoutMs, timeoutSecs * 1_000 + 5_000);
    const updates = await this.apiCall<unknown>(
      "getUpdates",
      {
        offset: this.offset,
        timeout: timeoutSecs,
        limit: this.settings.pollLimit,
        allowed_updates: ["message"],
      },
      budget,
    );
    if (!Array.isArray(updates) || updates.length === 0) {
      return;
    }
    for (const update of updates) {
      if (this.stopping) {
        return;
      }
      try {
        this.onUpdate(update);
      } catch (error) {
        // 单条更新格式异常不应重启整条轮询链路
        this.log.warn(`[telegram] 处理更新失败：${errorText(error)}`);
      }
    }
    const last = updates[updates.length - 1];
    const lastId = numberOf(objectOf(last)?.["update_id"]);
    if (lastId !== undefined && lastId >= this.offset) {
      this.offset = lastId + 1;
      await this.saveOffset();
    }
  }

  /** 401/404 属配置或凭证问题，继续重连只会刷屏 */
  private markFatal(error: unknown): boolean {
    if (!(error instanceof TelegramApiError)) {
      return false;
    }
    if (error.status === 401) {
      this.fatal = "机器人 token 无效（401），请检查 telegram.botToken";
      return true;
    }
    if (error.status === 404) {
      this.fatal = `Bot API 返回 404（${error.message}），请检查 telegram.botToken 与 telegram.apiBase`;
      return true;
    }
    return false;
  }

  private waitFor(error: unknown): number {
    if (error instanceof TelegramApiError) {
      if (error.retryAfterMs !== undefined) {
        // 429 的 retry_after 是秒；至少留 250 ms，测试里可以给 0
        return Math.max(250, error.retryAfterMs);
      }
      if (error.status === 409) {
        return Math.max(this.backoff, CONFLICT_WAIT_MS);
      }
    }
    return jitter(this.backoff);
  }

  private async deleteWebhook(): Promise<void> {
    try {
      await this.apiCall("deleteWebhook", { drop_pending_updates: false });
      this.log.warn(
        "[telegram] 检测到 webhook 占用 getUpdates（409），已自动 deleteWebhook；本适配器只支持长轮询",
      );
    } catch (error) {
      this.log.warn(`[telegram] deleteWebhook 失败：${errorText(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // 入站
  // -------------------------------------------------------------------------

  private onUpdate(update: unknown): void {
    const record = objectOf(update);
    if (record === undefined) {
      return;
    }
    // 只处理新消息；edited_message 的 message_id 与原文相同，会被去重挡掉。
    const message = objectOf(record["message"]);
    if (message === undefined) {
      return;
    }
    this.onMessage(message);
  }

  private onMessage(message: Record<string, unknown>): void {
    const ctx = this.ctx;
    if (ctx === undefined || !this.settings.inbound) {
      return;
    }
    const chat = objectOf(message["chat"]);
    if (chat === undefined) {
      return;
    }
    const chatId = idOf(chat["id"]);
    if (chatId === undefined) {
      return;
    }
    const type = stringOf(chat["type"]) ?? "private";
    if (type !== "group" && type !== "supergroup" && type !== "private") {
      // 频道帖子、未知会话类型不在本桥范围
      return;
    }
    const isGroup = type !== "private";

    const from = objectOf(message["from"]);
    // 机器人自己的消息（群里开启隐私模式后仍可能收到）不回灌，避免自激。
    if (from === undefined || from["is_bot"] === true) {
      return;
    }
    const senderId = idOf(from["id"]);
    if (senderId === undefined) {
      return;
    }
    if (this.identity !== undefined && senderId === this.identity.id) {
      return;
    }

    // message_id 在 Telegram 里只在单个会话内唯一，必须带上 chat id；
    // 内核按 `platform:messageId` 去重，这里再兜一层，避免轮询重发。
    const rawMessageId = idOf(message["message_id"]);
    const messageId = rawMessageId === undefined ? undefined : `${chatId}:${rawMessageId}`;
    if (messageId !== undefined) {
      if (this.seen.has(messageId)) {
        return;
      }
      this.rememberSeen(messageId);
    }

    const text = telegramInboundText(message);
    if (text === "") {
      return;
    }

    const senderName = stringOf(from["username"]);
    if (
      this.settings.allowedUsers.length > 0 &&
      !matchesList(this.settings.allowedUsers, senderId, senderName)
    ) {
      this.warnDropped(isGroup, chatId, senderId, "发言人不在 telegram.allowedUsers 白名单");
      return;
    }
    if (isGroup) {
      if (
        this.settings.groups.length > 0 &&
        !matchesList(this.settings.groups, chatId, stringOf(chat["username"]))
      ) {
        this.warnDropped(isGroup, chatId, senderId, "群不在 telegram.groups 白名单");
        return;
      }
    } else {
      if (!this.settings.allowPrivate) {
        this.warnDropped(
          isGroup,
          chatId,
          senderId,
          "私聊未启用（telegram.allowPrivate=false）；如需接收私聊，把 telegram.allowPrivate 设为 true",
        );
        return;
      }
      if (
        this.settings.privateUsers.length > 0 &&
        !matchesList(this.settings.privateUsers, chatId, senderName)
      ) {
        this.warnDropped(isGroup, chatId, senderId, "私聊对象不在 telegram.privateUsers 白名单");
        return;
      }
    }

    const displayName =
      displayNameOf(from) ?? chatTitle(chat) ?? (senderName === undefined ? senderId : `@${senderName}`);

    // 论坛群：记住话题，出站回到同一个 topic。General 话题 id=1，发送时省略。
    const threadId = numberOf(message["message_thread_id"]);
    if (isGroup && threadId !== undefined) {
      this.threads.set(chatId, threadId);
    }

    this.learnChannel(isGroup, chatId);
    const channelKey = targetKey(isGroup ? "group" : "private", chatId);
    if (!this.warnedDrops.has(`seen:${channelKey}`)) {
      this.warnedDrops.add(`seen:${channelKey}`);
      this.log.info(
        isGroup
          ? `[telegram] 收到群消息：chat_id=${chatId}，作者=${displayName}（user_id=${senderId}）`
          : `[telegram] 收到私聊：user_id=${chatId}，作者=${displayName}`,
      );
    }

    const title = chatTitle(chat);
    const date = numberOf(message["date"]);
    const inbound: PlatformInboundMessage = {
      platform: this.id,
      channel: {
        kind: isGroup ? "group" : "private",
        id: chatId,
        ...(title === undefined ? {} : { name: title }),
      },
      author: { id: senderId, name: displayName },
      text,
      label: this.settings.label,
      ...(messageId === undefined ? {} : { messageId }),
      ...(date === undefined ? {} : { at: new Date(date * 1_000).toISOString() }),
      ...(this.settings.server === undefined ? {} : { server: this.settings.server }),
    };
    ctx.inbound(inbound);

    const media = this.settings.forwardMedia ? telegramInboundMedia(message) : [];
    this.mirrorToOtherChannels(isGroup, chatId, displayName, text, media);
  }

  /**
   * 群聊与私聊互相同步（`telegram.syncChannels`，默认开启）。
   *
   * 收到 Telegram 消息后，把它再发到「除来源会话之外」的其它会话：群里发的
   * 进私聊，私聊发的进群。跳过来源会话是为了避免把消息原样回发到发源地；
   * 机器人自己发的消息不会再触发入站，因此不会形成回环。
   */
  private mirrorToOtherChannels(
    isGroup: boolean,
    channelId: string,
    displayName: string,
    text: string,
    media: readonly TelegramInboundMedia[],
  ): void {
    if (!this.settings.syncChannels || this.stopping || text === "") {
      return;
    }
    const exclude = targetKey(isGroup ? "group" : "private", channelId);
    const hasOtherTarget = this.targets().some(
      (target) => targetKey(target.kind, target.id) !== exclude,
    );
    if (!hasOtherTarget) {
      this.warnNoMirrorTarget(isGroup);
      return;
    }
    // 真实媒体会跟在文字后面发出，把对应占位去掉，避免同一条消息里重复。
    const shownText =
      media.length === 0
        ? text
        : text.replace(/\[(?:图片|视频|动图|文件(?::[^\]]*)?)\]/g, "").trim();
    const head = `[${isGroup ? "群" : "私聊"}] ${displayName}`;
    const caption = shownText === "" ? head : `${head}: ${shownText}`;
    this.enqueue({
      id: `mirror:${exclude}`,
      text: caption,
      exclude,
      ...(media.length === 0 ? {} : { media }),
    });
  }

  /** 记住会话，作为留空配置时的出站目标；超上限丢最早的 */
  private learnChannel(isGroup: boolean, channelId: string): void {
    this.learned.remember(isGroup ? "group" : "private", channelId);
  }

  private rememberSeen(messageId: string): void {
    this.seen.set(messageId, Date.now());
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.keys().next();
      if (!oldest.done) {
        this.seen.delete(oldest.value);
      }
    }
  }

  /**
   * 入站被过滤时告警一次（每个会话独立），并带上 chat_id / user_id。
   *
   * Telegram 的 chat_id 也能从消息里直接看到，但用户往往不知道去哪里找；
   * 静默丢弃会让人以为适配器坏了，所以把可填进配置的值一起打出来。
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
        ? `[telegram] 丢弃群消息（${reason}）：chat_id=${channelId}，作者 user_id=${senderId}`
        : `[telegram] 丢弃私聊（${reason}）：user_id=${channelId}，作者=${senderId}`,
    );
  }

  /**
   * 「镜像无处可发」时告警一次
   *
   * 目标来自「见过的会话」：群 chat_id 只有在群里说过话之后才知道。
   * `telegram.groups` 留空时，群里还没开过口之前，私聊消息往群里镜像算出来
   * 是零个目标。这里说清缺什么、怎么补。
   */
  private warnNoMirrorTarget(isGroup: boolean): void {
    if (this.warnedNoMirror || !this.settings.syncChannels) {
      return;
    }
    if (isGroup) {
      return;
    }
    if (this.settings.groups.length > 0 || this.learned.groups().length > 0) {
      return;
    }
    this.warnedNoMirror = true;
    this.log.warn(
      "[telegram] 私聊镜像暂时发不到群：还没有记录到任何群会话（在群里发一条消息即可自动补齐，或把 telegram.groups 填成群 chat_id）",
    );
  }

  private targets(): readonly OutboundTarget[] {
    // 留空 = 全部：显式配置优先，否则发给收到过消息的会话（按首次出现顺序）。
    const groups =
      this.settings.groups.length > 0 ? this.settings.groups : this.learned.groups();
    const users =
      this.settings.privateUsers.length > 0
        ? this.settings.privateUsers
        : this.learned.users();
    const targets: OutboundTarget[] = [];
    for (const group of groups) {
      targets.push({ kind: "group", id: group });
    }
    for (const user of users) {
      targets.push({ kind: "private", id: user });
    }
    return targets;
  }

  // -------------------------------------------------------------------------
  // 出站
  // -------------------------------------------------------------------------

  private async flushOutbound(): Promise<void> {
    if (this.sending || this.stopping) {
      return;
    }
    this.sending = true;
    try {
      while (!this.stopping && this.outQueue.length > 0) {
        const pending = this.outQueue.shift();
        if (pending === undefined || pending.text === "") {
          continue;
        }
        const targets = this.targets().filter(
          (target) => pending.exclude !== targetKey(target.kind, target.id),
        );
        if (targets.length === 0) {
          // 会话列表为空（还没收到过任何消息）才是真的没有目标；
          // 仅因 `exclude` 过滤掉唯一目标是正常情况，不告警。
          const hasAny =
            this.settings.groups.length + this.settings.privateUsers.length + this.learned.size > 0;
          if (!hasAny && !this.warnedNoTarget) {
            this.warnedNoTarget = true;
            this.log.warn("[telegram] 还没有可用的会话目标（等收到第一条群/私聊消息后自动补齐）");
          }
          continue;
        }

        let failures = 0;
        for (const target of targets) {
          try {
            await this.sendToTarget(target, pending.text, pending.media ?? []);
          } catch (error) {
            failures += 1;
            this.log.warn(
              `[telegram] 发送到 ${target.kind}:${target.id} 失败：${errorText(error)}`,
            );
          }
        }
        if (failures === targets.length) {
          throw new Error(`Telegram 所有目标均发送失败（${pending.id}）`);
        }
        if (failures > 0) {
          this.log.warn(`[telegram] 消息 ${pending.id} 有 ${failures}/${targets.length} 个目标失败`);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  /** 先发文字（按长度分片），再逐条发媒体；文本与图片保持「文字在前」 */
  private async sendToTarget(
    target: OutboundTarget,
    text: string,
    media: readonly TelegramInboundMedia[],
  ): Promise<void> {
    for (const chunk of splitTelegramHtml(text, this.settings.maxLength)) {
      await this.sendWithRetry(target, "sendMessage", {
        ...this.payloadOf(target),
        text: chunk,
        parse_mode: "HTML",
        ...(this.settings.linkPreview ? {} : { link_preview_options: { is_disabled: true } }),
      });
    }
    for (const item of media) {
      const spec = MEDIA_SPEC[item.kind];
      await this.sendWithRetry(target, spec.method, {
        ...this.payloadOf(target),
        [spec.field]: item.fileId,
      });
    }
  }

  /** 会话相关的公共字段；论坛群带上话题，General（id=1）省略 */
  private payloadOf(target: OutboundTarget): Record<string, unknown> {
    const thread = this.threadOf(target);
    return {
      chat_id: target.id,
      ...(thread === undefined ? {} : { message_thread_id: thread }),
    };
  }

  private threadOf(target: OutboundTarget): number | undefined {
    if (target.kind !== "group") {
      return undefined;
    }
    const thread = this.threads.get(target.id);
    if (thread === undefined || thread === GENERAL_TOPIC_ID) {
      return undefined;
    }
    return thread;
  }

  private async sendWithRetry(
    target: OutboundTarget,
    method: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const key = targetKey(target.kind, target.id);
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      await this.pace();
      try {
        await this.apiCall(method, payload);
        this.log.debug?.(`[telegram] 已发送到 ${key}：${previewOf(payload)}`);
        return;
      } catch (error) {
        if (!(error instanceof TelegramApiError)) {
          if (attempt < SEND_ATTEMPTS) {
            await this.abortableSleep(300 * attempt);
            continue;
          }
          throw error;
        }
        // 群升级为超级群后 chat_id 变了：本次改用新 id，并提示更新配置。
        const migrated = error.migrateToChatId;
        if (
          migrated !== undefined &&
          target.kind === "group" &&
          String(payload["chat_id"]) !== migrated
        ) {
          payload["chat_id"] = migrated;
          if (!this.warnedMigration.has(target.id)) {
            this.warnedMigration.add(target.id);
            this.log.warn(
              `[telegram] 群 ${target.id} 已升级为超级群 ${migrated}；请把 telegram.groups 更新为新 id`,
            );
          }
          attempt -= 1;
          continue;
        }
        const retryable =
          error.status === 0 || error.status === 429 || error.status >= 500;
        if (!retryable || attempt === SEND_ATTEMPTS) {
          throw error;
        }
        const wait = error.retryAfterMs ?? Math.min(5_000, 500 * attempt);
        await this.abortableSleep(wait);
      }
    }
  }

  /** 全局最小发送间隔：Telegram 对同一群有 20 条/分钟的量级限制，宁可慢一点 */
  private async pace(): Promise<void> {
    if (this.settings.sendIntervalMs <= 0) {
      return;
    }
    const wait = this.settings.sendIntervalMs - (Date.now() - this.lastSendAt);
    if (wait > 0) {
      await this.abortableSleep(wait);
    }
    this.lastSendAt = Date.now();
  }

  // -------------------------------------------------------------------------
  // HTTP / 持久化
  // -------------------------------------------------------------------------

  private async apiCall<T = Record<string, unknown>>(
    method: string,
    body: Record<string, unknown> | undefined,
    timeoutMs = this.settings.apiTimeoutMs,
  ): Promise<T> {
    // 注意：URL 里含 token，任何日志都不要打印完整 URL，只记 method。
    const url = `${this.settings.apiBase}/bot${this.settings.botToken}/${method}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: this.requestSignal(timeoutMs),
      });
    } catch (error) {
      throw new TelegramApiError(`Telegram ${method} 网络错误：${errorText(error)}`, 0);
    }

    const text = await response.text().catch(() => "");
    let parsed: Record<string, unknown> = {};
    if (text.trim() !== "") {
      try {
        const value = JSON.parse(text) as unknown;
        const record = objectOf(value);
        parsed = record ?? {};
      } catch {
        throw new TelegramApiError(`Telegram ${method} 响应不是 JSON`, response.status);
      }
    }

    if (!response.ok || parsed["ok"] !== true) {
      const code = numberOf(parsed["error_code"]) ?? response.status;
      const description = stringOf(parsed["description"]) ?? text.slice(0, 200);
      const parameters = objectOf(parsed["parameters"]);
      const retryAfter = parameters === undefined ? undefined : numberOf(parameters["retry_after"]);
      const migrate = parameters === undefined ? undefined : idOf(parameters["migrate_to_chat_id"]);
      throw new TelegramApiError(
        `Telegram ${method} 失败 [${code}]：${description}`,
        response.status,
        code,
        retryAfter === undefined ? undefined : retryAfter * 1_000,
        migrate,
      );
    }

    return parsed["result"] as T;
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

  private abortableSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.ctx?.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.ctx?.signal.addEventListener("abort", done, { once: true });
    });
  }

  private async loadOffset(): Promise<void> {
    if (this.kv === undefined) {
      return;
    }
    try {
      const raw = await this.kv.get(OFFSET_KEY);
      if (raw === null || raw.length === 0) {
        return;
      }
      const value = Number.parseInt(Buffer.from(raw).toString("utf8").trim(), 10);
      if (Number.isSafeInteger(value) && value >= 0) {
        this.offset = value;
        this.log.info(`[telegram] 从 offset=${value} 继续收取更新`);
      }
    } catch (error) {
      if (!this.offsetWarned) {
        this.offsetWarned = true;
        this.log.warn(`[telegram] 读取 update offset 失败，从 0 开始：${errorText(error)}`);
      }
    }
  }

  private async saveOffset(): Promise<void> {
    if (this.kv === undefined) {
      return;
    }
    try {
      await this.kv.set(OFFSET_KEY, String(this.offset));
    } catch (error) {
      // 落盘失败不影响收取：本次会话仍用内存里的 offset，下次确认时会再试
      if (!this.offsetWarned) {
        this.offsetWarned = true;
        this.log.warn(`[telegram] 保存 update offset 失败（重启后可能重复收取）：${errorText(error)}`);
      }
    }
  }
}

export const telegramPlatformFactory: PlatformFactory = {
  id: "telegram",
  title: "Telegram",
  description: "Telegram Bot API 长轮询（getUpdates + REST），群聊/私聊双向互通",
  create(options) {
    return new TelegramPlatform(options);
  },
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function targetKey(kind: "group" | "private", id: string): string {
  return `${kind}:${id}`;
}

/** 配置里的目标可以写数字 id、`@username` 或裸 username */
function matchesList(list: readonly string[], id: string, username?: string): boolean {
  for (const item of list) {
    if (item === id) {
      return true;
    }
  }
  if (username === undefined) {
    return false;
  }
  // Telegram username 不区分大小写；数字 id 仍要求精确匹配。
  const name = username.replace(/^@/, "").toLowerCase();
  return list.some((item) => item.replace(/^@/, "").toLowerCase() === name);
}

function displayNameOf(from: Record<string, unknown>): string | undefined {
  const first = stringOf(from["first_name"]);
  const last = stringOf(from["last_name"]);
  const full = [first, last].filter((part): part is string => part !== undefined).join(" ");
  if (full !== "") {
    return full;
  }
  const username = stringOf(from["username"]);
  return username === undefined ? undefined : `@${username}`;
}

function chatTitle(chat: Record<string, unknown>): string | undefined {
  const title = stringOf(chat["title"]);
  if (title !== undefined) {
    return title;
  }
  const username = stringOf(chat["username"]);
  return username === undefined ? undefined : `@${username}`;
}

function previewOf(payload: Record<string, unknown>): string {
  const text = stringOf(payload["text"]);
  if (text !== undefined) {
    return text.slice(0, 60);
  }
  for (const field of ["photo", "video", "animation", "document"]) {
    if (payload[field] !== undefined) {
      return `[${field}]`;
    }
  }
  return "[消息]";
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function idOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return stringOf(value);
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function urlOf(value: unknown): string | undefined {
  const text = stringOf(value);
  if (text === undefined) {
    return undefined;
  }
  if (!/^https?:\/\//i.test(text)) {
    throw new PluginError(
      "invalid_input",
      `telegram 的 URL 必须以 http:// 或 https:// 开头，实际为 ${text}`,
    );
  }
  return text.replace(/\/+$/, "");
}

function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function intOf(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    const text = stringOf(item);
    if (text !== undefined && !out.includes(text)) {
      out.push(text);
    }
  }
  return out;
}

function categoriesOf(value: unknown): MessageCategory[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const out: MessageCategory[] = [];
  for (const item of value) {
    if (
      typeof item === "string" &&
      (CATEGORIES as readonly string[]).includes(item) &&
      !out.includes(item as MessageCategory)
    ) {
      out.push(item as MessageCategory);
    }
  }
  return out.length === 0 ? undefined : out;
}

function jitter(ms: number): number {
  return ms * (0.8 + Math.random() * 0.4);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}