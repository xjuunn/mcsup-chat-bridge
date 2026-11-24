/**
 * 微信平台适配器：腾讯官方 iLink Bot API（`getUpdates` 长轮询）
 *
 * 协议依据：腾讯 `Tencent/OpenClaw-Weixin` 的 `docs/protocol_zh_CN.md`。
 * 微信官方渠道插件同样跑在「没有公网入口」的宿主里，因此这里复用它的
 * 长轮询模型，而不是企业微信 / 公众号那类必须暴露回调地址的方案。
 *
 * 链路：
 * - 出站：`POST {apiBase}/ilink/bot/sendmessage`，文本放在
 *   `item_list[0].text_item.text`；
 * - 入站：`POST {apiBase}/ilink/bot/getupdates`，把 `get_updates_buf` 原样
 *   回传；有新消息或服务端长轮询超时后返回；
 * - 生命周期：启动时 `msg/notifystart`、停止时 `msg/notifystop`，失败只记
 *   调试日志，不阻塞启停。
 *
 * 设计取舍：
 * - 微信机器人是「一个 bot 对一个人」的单聊形态（官方客户端的 `ChatType`
 *   固定为 `direct`），因此所有会话都归一为 `private`；没有群/私聊镜像。
 * - 协议里没有昵称字段，发言人的显示名只能用它自己的 `from_user_id`，
 *   不编造联系人或手机号。
 * - 出站要回传入站消息里的 `context_token`，否则服务端可能以
 *   `ret=-2 prepare failed` 拒绝。令牌按会话持久化到宿主 KV（不是账号
 *   凭据），重启后不用等对方先说话。
 * - 媒体（图片 / 语音 / 文件 / 视频）在正文里保留 `[图片]` 之类的占位，
 *   不下载也不上传：CDN 内容是 AES 加密的，跨平台句柄也不通用。
 * - `ret` / `errcode` 为 `-14` 表示 bot token 失效：官方客户端会暂停该
 *   账号一小时，这里同样暂停长轮询与出站，避免把失效 token 打成重试风暴。
 */

import { randomUUID } from "node:crypto";

import { PluginError } from "mcsup-plugin";
import type { LogClient } from "mcsup-plugin";

import { LearnedTargets } from "../core/targets.js";
import type { MessageCategory, NormalizedMessage } from "../core/types.js";
import { formatOutbound, formatRelay, splitText } from "../platform-kit/format.js";
import { OutboundQueue, TargetBook, type OutboundTarget, type QueueItem } from "../platform-kit/shared/outbound.js";
import { MessageSeen } from "../platform-kit/shared/seen.js";
import { abortableSleep, errorText, jitter, sleep } from "../platform-kit/shared/runtime.js";
import {
  boolOf,
  categoriesOf,
  httpUrlOf,
  idOf,
  intOf,
  numberOf,
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

/** 解析后的微信配置；数值都有默认值，工厂不做额外 IO */
export interface WeixinSettings {
  /** 扫码登录后取得的 bot token（形如 `wxbot_...`），界面遮蔽 */
  readonly botToken: string;
  /** Bot API 基址；默认腾讯 iLink API，登录返回的 `baseurl` 不同时改这里 */
  readonly apiBase: string;
  /** 出站私聊 user id；同时作为入站白名单。留空 = 全部（发给收到过消息的用户） */
  readonly privateUsers: readonly string[];
  /** 入站发言人白名单；留空表示不限 */
  readonly allowedUsers: readonly string[];
  /** 出站类别过滤；省略时沿用全局 forwardCategories */
  readonly categories?: readonly MessageCategory[];
  readonly inbound: boolean;
  readonly allowPrivate: boolean;
  readonly label: string;
  readonly server?: string;
  readonly maxLength: number;
  readonly sendIntervalMs: number;
  readonly apiTimeoutMs: number;
  /** getUpdates 单次长轮询的超时；服务端会通过 `longpolling_timeout_ms` 调整 */
  readonly pollTimeoutMs: number;
  readonly reconnectMinMs: number;
  readonly reconnectMaxMs: number;
  /** 0 表示无限重试 */
  readonly reconnectMaxAttempts: number;
}

const DEFAULT_API_BASE = "https://ilinkai.weixin.qq.com";
const USER_AGENT = `mcsup-chat-bridge/${PLUGIN_VERSION} (WeixinAdapter)`;

/** iLink 请求头里声明的 app id；官方客户端固定为 `bot` */
const ILINK_APP_ID = "bot";
/**
 * `channel_version` 是服务端识别客户端渠道的字段，前三段必须是 `3.x.x`。
 * 本项目版本放在 `/` 后缀里，既满足服务端的版本门槛，又能从日志里认出
 * 真正发请求的实现。
 */
const ILINK_CHANNEL_BASE = "3.0.1";
const ILINK_CHANNEL_VERSION = `${ILINK_CHANNEL_BASE}/mcsup-chat-bridge-${PLUGIN_VERSION}`;
const ILINK_CLIENT_VERSION = buildClientVersion(ILINK_CHANNEL_BASE);

/** 微信文本单条上限未知；按 QQ 的保守值分片，超过按码点切分 */
const TEXT_LIMIT = 4_000;
/** 出站队列上限：分发层之外再兜一层，避免断线期间无限堆积 */
const OUTBOUND_LIMIT = 512;
/** 留空配置时自动记住的私聊会话上限 */
const LEARNED_LIMIT = 64;
/** 会话上下文令牌的持久化上限；超过丢最早 */
const CONTEXT_LIMIT = 64;
/** 单次出站失败后的重试次数（首次 + 2 次重试） */
const SEND_ATTEMPTS = 3;
/** 最近消息 id 去重窗口 */
const SEEN_LIMIT = 1_000;
/** 长轮询游标的 KV 键 */
const CURSOR_KEY = "weixin:sync";
/** 会话上下文令牌的 KV 键（不是账号凭据） */
const CONTEXT_KEY = "weixin:context";
/** bot token 失效（-14）后的暂停时长：与官方客户端一致 */
const STALE_TOKEN_ERRCODE = -14;
const SESSION_PAUSE_MS = 60 * 60 * 1_000;
/** 连续失败达到该次数后拉长退避 */
const MAX_CONSECUTIVE_FAILURES = 3;
/** 服务端建议的超时落在该区间内才采用 */
const MIN_POLL_TIMEOUT_MS = 1_000;
const MAX_POLL_TIMEOUT_MS = 120_000;

/**
 * 校验并补全配置。
 *
 * 缺 botToken 时抛 `invalid_input`：微信没有「匿名试用」模式，token 必须
 * 先通过扫码脚本取得，让宿主在启动阶段回滚配置而不是静默空转。
 */
export function parseWeixinSettings(raw: unknown): WeixinSettings {
  if (typeof raw !== "object" || raw === null) {
    throw new PluginError(
      "invalid_input",
      "平台 weixin 缺少配置：先运行 `node scripts/weixin-login.mjs` 扫码取得 bot token，再写入 weixin.botToken；" +
        "不用微信时请从 platforms 移除 weixin",
    );
  }
  const record = raw as Record<string, unknown>;
  const botToken = stringOf(record["botToken"]);
  if (botToken === undefined) {
    throw new PluginError(
      "invalid_input",
      "平台 weixin 缺少 botToken：运行 `node scripts/weixin-login.mjs` 扫码登录，" +
        "把输出的 token 写入 weixin.botToken；不用微信时请从 platforms 移除 weixin",
    );
  }

  const categories = categoriesOf(record["categories"]);
  const server = stringOf(record["server"]);

  return {
    botToken,
    apiBase: httpUrlOf(record["apiBase"], "weixin") ?? DEFAULT_API_BASE,
    privateUsers: stringsOf(record["privateUsers"]),
    allowedUsers: stringsOf(record["allowedUsers"]),
    ...(categories === undefined ? {} : { categories }),
    inbound: boolOf(record["inbound"], true),
    // 微信机器人本身就是单聊形态：默认接收私聊，否则装完「什么都没反应」。
    // 担心陌生人打扰时把 allowPrivate 关掉，或填 allowedUsers 白名单。
    allowPrivate: boolOf(record["allowPrivate"], true),
    label: stringOf(record["label"]) ?? "微信",
    ...(server === undefined ? {} : { server }),
    maxLength: intOf(record["maxLength"], 1_500, 64, TEXT_LIMIT),
    sendIntervalMs: intOf(record["sendIntervalMs"], 1_000, 0, 10_000),
    apiTimeoutMs: intOf(record["apiTimeoutMs"], 15_000, 1_000, 60_000),
    pollTimeoutMs: intOf(record["pollTimeoutMs"], 35_000, MIN_POLL_TIMEOUT_MS, MAX_POLL_TIMEOUT_MS),
    reconnectMinMs: intOf(record["reconnectMinMs"], 1_000, 200, 60_000),
    reconnectMaxMs: intOf(record["reconnectMaxMs"], 60_000, 1_000, 600_000),
    reconnectMaxAttempts: intOf(record["reconnectMaxAttempts"], 0, 0, 10_000),
  };
}

// ---------------------------------------------------------------------------
// 协议常量与归一化
// ---------------------------------------------------------------------------

/** 消息项类型（proto: MessageItemType） */
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const ITEM_VOICE = 3;
const ITEM_FILE = 4;
const ITEM_VIDEO = 5;

/** 消息来源（proto: MessageType）；`2` 是 bot 自己 */
const MESSAGE_TYPE_BOT = 2;

/** `iLink-App-ClientVersion`：`0x00MMNNPP` */
function buildClientVersion(version: string): number {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/** 每个请求都要带的 `base_info` */
export function weixinBaseInfo(): { readonly channel_version: string; readonly bot_agent: string } {
  return {
    channel_version: ILINK_CHANNEL_VERSION,
    bot_agent: `mcsup-chat-bridge/${PLUGIN_VERSION}`,
  };
}

/** `X-WECHAT-UIN`：随机 uint32 → 十进制字符串 → base64 */
function randomWechatUin(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const uint32 =
    ((bytes[0] ?? 0) * 0x1_000_000 +
      (bytes[1] ?? 0) * 0x1_0000 +
      (bytes[2] ?? 0) * 0x100 +
      (bytes[3] ?? 0)) >>>
    0;
  return Buffer.from(String(uint32), "utf8").toString("base64");
}

/**
 * 把微信消息归一为纯文本。
 *
 * 顺序与官方客户端一致：按 `item_list` 顺序取第一条文本（语音消息用转写
 * `voice_item.text`），没有文本时用第一条媒体的占位。文本项之后的媒体不再
 * 追加，避免一条消息出现 `文字 [图片] [视频]` 的堆叠。
 */
export function weixinInboundText(itemList: unknown): string {
  if (!Array.isArray(itemList)) {
    return "";
  }
  for (const raw of itemList) {
    const item = objectOf(raw);
    if (item === undefined) {
      continue;
    }
    const type = numberOf(item["type"]);
    if (type === ITEM_TEXT) {
      const text = item["text_item"];
      const value = objectOf(text)?.["text"];
      if (value !== undefined && value !== null) {
        return String(value);
      }
    }
    if (type === ITEM_VOICE) {
      const voice = objectOf(item["voice_item"]);
      const transcript = stringOf(voice?.["text"]);
      if (transcript !== undefined) {
        return transcript;
      }
    }
    if (type === ITEM_IMAGE) {
      return "[图片]";
    }
    if (type === ITEM_VIDEO) {
      return "[视频]";
    }
    if (type === ITEM_VOICE) {
      return "[语音]";
    }
    if (type === ITEM_FILE) {
      const file = objectOf(item["file_item"]);
      const name = stringOf(file?.["file_name"]);
      return name === undefined ? "[文件]" : `[文件: ${name}]`;
    }
  }
  return "";
}

/** 归一化后的入站消息；与适配器状态无关，便于单测 */
export interface WeixinInbound {
  readonly senderId: string;
  readonly text: string;
  readonly messageId?: string;
  readonly at?: string;
  readonly contextToken?: string;
}

/**
 * 把 `getUpdates` 里的一条 `WeixinMessage` 转成入站消息。
 *
 * 返回 `undefined` 表示这条消息不该进桥：机器人自己的消息、已删除的消息、
 * 没有发送者或没有可展示内容的消息。
 */
export function parseWeixinMessage(raw: unknown): WeixinInbound | undefined {
  const message = objectOf(raw);
  if (message === undefined) {
    return undefined;
  }
  if (numberOf(message["message_type"]) === MESSAGE_TYPE_BOT) {
    return undefined;
  }
  const deleted = numberOf(message["delete_time_ms"]);
  if (deleted !== undefined && deleted > 0) {
    return undefined;
  }
  const senderId = idOf(message["from_user_id"]);
  if (senderId === undefined) {
    return undefined;
  }
  const text = weixinInboundText(message["item_list"]);
  if (text.trim() === "") {
    return undefined;
  }

  let messageId = idOf(message["message_id"]);
  if (messageId === undefined && Array.isArray(message["item_list"])) {
    for (const item of message["item_list"]) {
      const candidate = idOf(objectOf(item)?.["msg_id"]);
      if (candidate !== undefined) {
        messageId = candidate;
        break;
      }
    }
  }

  const created = numberOf(message["create_time_ms"]);
  const at =
    created === undefined || !Number.isFinite(created)
      ? undefined
      : new Date(created).toISOString();
  const contextToken = stringOf(message["context_token"]);

  return {
    senderId,
    text,
    ...(messageId === undefined ? {} : { messageId }),
    ...(at === undefined ? {} : { at }),
    ...(contextToken === undefined ? {} : { contextToken }),
  };
}

/**
 * 解析微信 API 的 JSON，并把 uint64 消息 id 保留成字符串。
 *
 * 微信的 `message_id` / `msg_id` / `svr_id` 是 uint64，直接 `JSON.parse`
 * 会落到 double 精度（超过 2^53 后相邻 id 可能相同），入站去重就会误杀。
 * 这里只在**对象键**位置给这三个字段的数字字面量加引号，字符串内容里的
 * 同样文本不会被改写。
 */
export function parseWeixinJson<T>(rawText: string): T {
  if (rawText.trim() === "") {
    throw new Error("微信 API 返回空响应体");
  }
  const quoteFields = new Set(["message_id", "msg_id", "svr_id"]);
  let output = "";
  let index = 0;
  while (index < rawText.length) {
    if (rawText.charAt(index) !== '"') {
      output += rawText.charAt(index);
      index += 1;
      continue;
    }

    const stringStart = index;
    index += 1;
    let escaped = false;
    let closed = false;
    while (index < rawText.length) {
      const char = rawText.charAt(index);
      index += 1;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        closed = true;
        break;
      }
    }
    const token = rawText.slice(stringStart, index);
    output += token;
    if (!closed) {
      continue;
    }

    let cursor = index;
    while (cursor < rawText.length && /\s/.test(rawText.charAt(cursor))) {
      cursor += 1;
    }
    if (rawText.charAt(cursor) !== ":") {
      continue;
    }
    let key: unknown;
    try {
      key = JSON.parse(token) as unknown;
    } catch {
      continue;
    }
    if (typeof key !== "string" || !quoteFields.has(key)) {
      continue;
    }

    output += rawText.slice(index, cursor + 1);
    cursor += 1;
    while (cursor < rawText.length && /\s/.test(rawText.charAt(cursor))) {
      output += rawText.charAt(cursor);
      cursor += 1;
    }

    const numberStart = cursor;
    if (rawText.charAt(cursor) === "-") {
      cursor += 1;
    }
    while (cursor < rawText.length && /\d/.test(rawText.charAt(cursor))) {
      cursor += 1;
    }
    const isNumber =
      cursor > numberStart &&
      !(cursor === numberStart + 1 && rawText.charAt(numberStart) === "-");
    if (isNumber) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else {
      index = numberStart;
    }
  }
  return JSON.parse(output) as T;
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

class WeixinApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly ret?: number,
  ) {
    super(message);
  }
}

export class WeixinPlatform implements ChatPlatform {
  public readonly id = "weixin";
  public readonly title = "微信";

  private readonly settings: WeixinSettings;
  private readonly log: LogClient;
  private readonly kv: PlatformCreateOptions["kv"];
  /** 全局 `privateSync`：打开后即使 `weixin.allowPrivate=false` 也接收私聊 */
  private readonly privateSync: boolean;
  private ctx: PlatformContext | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private stopNotified = false;
  /** run() 是否已经开始过；未启动过的实例不向后端发下线通知 */
  private startAttempted = false;
  private readonly stopController = new AbortController();
  private fatal: string | undefined;

  /** `get_updates_buf` 游标；非空时原样回传 */
  private cursor = "";
  private cursorWarned = false;
  private connected = false;

  private backoff: number;
  private attempts = 0;
  private pollTimeoutMs: number;

  /** `-14` 之后的暂停终点；暂停期间不发长轮询也不出站 */
  private pausedUntil = 0;
  private pauseWarned = false;

  private lastSendAt = 0;
  private readonly seen = new MessageSeen(SEEN_LIMIT);
  /** 入站被过滤时只告警一次；键为 sender id */
  private readonly warnedDrops = new Set<string>();
  private receivedWarned = new Set<string>();
  /** 会话上下文令牌：会话 id → context_token */
  private readonly contextTokens = new Map<string, string>();
  private contextWarned = false;
  private contextSaveWarned = false;

  private readonly learned: LearnedTargets;
  private readonly targetBook: TargetBook;
  private readonly outbound: OutboundQueue<QueueItem>;

  public constructor(options: PlatformCreateOptions) {
    this.log = options.log;
    this.kv = options.kv;
    this.privateSync = options.private === true;
    this.settings = parseWeixinSettings(options.settings);
    this.backoff = this.settings.reconnectMinMs;
    this.pollTimeoutMs = this.settings.pollTimeoutMs;
    this.learned = new LearnedTargets({
      key: "weixin:targets",
      tag: this.id,
      log: options.log,
      limit: LEARNED_LIMIT,
      ...(options.kv === undefined ? {} : { kv: options.kv }),
    });
    this.targetBook = new TargetBook({
      label: this.id,
      log: this.log,
      learned: this.learned,
      groups: [],
      users: this.settings.privateUsers,
      // 微信只有单聊会话；把私聊再镜像给其它私聊会泄露一对一会话，必须关闭。
      syncChannels: false,
      noTargetHint:
        "先在微信里给机器人发一条消息就会自动记下目标；也可以在 weixin.privateUsers 里填 user id",
      noMirrorHint: "",
    });
    this.outbound = new OutboundQueue<QueueItem>({
      label: this.id,
      title: "微信",
      limit: OUTBOUND_LIMIT,
      log: this.log,
      targets: this.targetBook,
      isStopping: () => this.stopping,
      send: async (target, pending) => this.sendToTarget(target, pending.text),
    });
  }

  public start(ctx: PlatformContext): void {
    this.ctx = ctx;
    if (ctx.signal.aborted) {
      return;
    }
    if (this.settings.privateUsers.length === 0) {
      this.log.info(
        "[weixin] 微信机器人是单聊形态：对方发来的会话会自动记为出站目标，" +
          "不用手填 user id；出站目标记在宿主 storage:kv，重启后仍有效",
      );
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
      this.log.error(`[weixin] 适配器异常退出：${errorText(error)}`);
    });
  }

  public deliver(message: NormalizedMessage): void {
    if (this.settings.categories !== undefined && !this.settings.categories.includes(message.category)) {
      return;
    }
    if (this.isPaused()) {
      this.warnPaused();
      return;
    }
    const text = formatOutbound(message);
    if (text === "") {
      return;
    }
    this.outbound.push({ id: message.id, text });
  }

  /**
   * 接收其它平台转发来的消息并发送到本平台的私聊目标。
   *
   * 与 `deliver` 共用出站队列与限流，但不回流 `ctx.inbound`，所以不会成环。
   */
  public relay(message: PlatformRelayMessage): void {
    if (this.stopping || this.isPaused()) {
      if (this.isPaused()) {
        this.warnPaused();
      }
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
    if (!this.stopping) {
      this.stopping = true;
      this.outbound.clear();
      this.log.debug?.(`[weixin] 停止：${reason}`);
    }
    // notify 用独立超时且忽略停止信号：宿主可能先 abort 再调 stop，
    // 只按 `stopping` 判断会让后端永远收不到下线通知。
    if (!this.stopNotified && this.startAttempted) {
      this.stopNotified = true;
      await this.notify("ilink/bot/msg/notifystop");
    }
    this.stopController.abort();
    const loop = this.loop;
    if (loop !== undefined) {
      await Promise.race([loop, sleep(1_000)]);
    }
  }

  // -------------------------------------------------------------------------
  // 长轮询生命周期
  // -------------------------------------------------------------------------

  private async run(): Promise<void> {
    this.startAttempted = true;
    await this.learned.load();
    await this.loadCursor();
    await this.loadContextTokens();
    await this.notify("ilink/bot/msg/notifystart");

    while (!this.stopping) {
      if (this.fatal !== undefined) {
        this.log.error(`[weixin] 已停止重连：${this.fatal}`);
        return;
      }
      const pause = this.pauseRemainingMs();
      if (pause > 0) {
        this.warnPaused();
        await abortableSleep(pause, this.stopController.signal, this.ctx?.signal);
        continue;
      }
      try {
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
        if (
          this.settings.reconnectMaxAttempts > 0 &&
          this.attempts >= this.settings.reconnectMaxAttempts
        ) {
          this.log.error(`[weixin] 达到最大重连次数 ${this.settings.reconnectMaxAttempts}`);
          return;
        }
        this.attempts += 1;
        const wait = this.waitFor(error);
        this.log.warn(`[weixin] 长轮询失败：${errorText(error)}`);
        this.log.info(`[weixin] ${Math.round(wait)} ms 后重试（第 ${this.attempts} 次）`);
        await abortableSleep(wait, this.stopController.signal, this.ctx?.signal);
        this.backoff = Math.min(
          this.settings.reconnectMaxMs,
          Math.max(this.settings.reconnectMinMs, this.backoff * 2),
        );
      }
    }
  }

  private async poll(): Promise<void> {
    let response: Record<string, unknown>;
    try {
      response = await this.apiPost<Record<string, unknown>>(
        "ilink/bot/getupdates",
        leaveDefined({
          get_updates_buf: this.cursor,
          base_info: weixinBaseInfo(),
        }),
        this.pollTimeoutMs + 5_000,
      );
    } catch (error) {
      if (isAbortError(error) && !this.stopping && this.ctx?.signal.aborted !== true) {
        // 客户端侧长轮询超时是正常控制流：服务端没消息时本来就该挂到超时。
        return;
      }
      throw error;
    }

    const suggested = numberOf(response["longpolling_timeout_ms"]);
    if (suggested !== undefined) {
      this.pollTimeoutMs = Math.min(
        MAX_POLL_TIMEOUT_MS,
        Math.max(MIN_POLL_TIMEOUT_MS, Math.trunc(suggested)),
      );
    }

    const ret = numberOf(response["ret"]);
    const errcode = numberOf(response["errcode"]);
    if (ret === STALE_TOKEN_ERRCODE || errcode === STALE_TOKEN_ERRCODE) {
      this.pauseForStaleToken(stringOf(response["errmsg"]));
      return;
    }
    if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
      throw new WeixinApiError(
        `微信 getUpdates 失败（ret=${ret ?? 0}, errcode=${errcode ?? 0}, errmsg=${stringOf(response["errmsg"]) ?? ""}）`,
        200,
        ret ?? errcode,
      );
    }

    if (!this.connected) {
      this.connected = true;
      this.log.info("[weixin] 已连接：微信机器人（iLink 长轮询）");
    }

    const messages = Array.isArray(response["msgs"]) ? response["msgs"] : [];
    for (const message of messages) {
      if (this.stopping) {
        return;
      }
      try {
        this.onMessage(message);
      } catch (error) {
        // 单条消息格式异常不应重启整条轮询链路
        this.log.warn(`[weixin] 处理消息失败：${errorText(error)}`);
      }
    }

    const nextCursor = stringOf(response["get_updates_buf"]);
    if (nextCursor !== undefined && nextCursor !== this.cursor) {
      this.cursor = nextCursor;
      await this.saveCursor();
    }
  }

  private markFatal(error: unknown): boolean {
    if (!(error instanceof WeixinApiError)) {
      return false;
    }
    if (error.status === 401 || error.status === 403) {
      this.fatal = "bot token 无效或被拒绝（401/403），请重新运行 node scripts/weixin-login.mjs 扫码并更新 weixin.botToken";
      return true;
    }
    if (error.status === 404) {
      this.fatal = `微信 API 返回 404（${error.message}），请检查 weixin.apiBase`;
      return true;
    }
    return false;
  }

  private waitFor(error: unknown): number {
    if (error instanceof WeixinApiError && error.status === 429) {
      return Math.max(250, this.backoff);
    }
    if (
      error instanceof WeixinApiError &&
      error.status === 200 &&
      this.attempts + 1 >= MAX_CONSECUTIVE_FAILURES
    ) {
      return 30_000;
    }
    return jitter(this.backoff);
  }

  // -------------------------------------------------------------------------
  // 入站
  // -------------------------------------------------------------------------

  private onMessage(raw: unknown): void {
    const ctx = this.ctx;
    if (ctx === undefined) {
      return;
    }
    const parsed = parseWeixinMessage(raw);
    if (parsed === undefined) {
      return;
    }
    if (parsed.messageId !== undefined) {
      if (this.seen.has(parsed.messageId)) {
        return;
      }
      this.seen.remember(parsed.messageId);
    }

    if (!this.allowPrivate()) {
      this.warnDropped(
        parsed.senderId,
        "私聊未启用（weixin.allowPrivate=false）；如需接收微信消息，把 weixin.allowPrivate 设为 true，" +
          "或在安装向导里打开「同步私聊消息」",
      );
      return;
    }
    if (
      this.settings.allowedUsers.length > 0 &&
      !this.settings.allowedUsers.includes(parsed.senderId)
    ) {
      this.warnDropped(parsed.senderId, "发言人不在 weixin.allowedUsers 白名单");
      return;
    }
    if (
      this.settings.privateUsers.length > 0 &&
      !this.settings.privateUsers.includes(parsed.senderId)
    ) {
      this.warnDropped(parsed.senderId, "私聊对象不在 weixin.privateUsers 白名单");
      return;
    }

    this.learned.remember("private", parsed.senderId);
    if (parsed.contextToken !== undefined) {
      this.rememberContext(parsed.senderId, parsed.contextToken);
    }
    if (!this.receivedWarned.has(parsed.senderId)) {
      this.receivedWarned.add(parsed.senderId);
      this.log.info(
        `[weixin] 收到私聊：user_id=${parsed.senderId}，正文长度 ${Array.from(parsed.text).length}`,
      );
    }

    const inbound: PlatformInboundMessage = {
      platform: this.id,
      channel: { kind: "private", id: parsed.senderId },
      // 协议不提供昵称：用对方 id 作显示名，不编造姓名
      author: { id: parsed.senderId, name: parsed.senderId },
      text: parsed.text,
      label: this.settings.label,
      ...(this.settings.inbound ? {} : { inject: false }),
      ...(parsed.messageId === undefined ? {} : { messageId: parsed.messageId }),
      ...(parsed.at === undefined ? {} : { at: parsed.at }),
      ...(this.settings.server === undefined ? {} : { server: this.settings.server }),
    };
    ctx.inbound(inbound);
  }

  /** 私聊是否可接收：平台开关与全局 `privateSync` 取并集 */
  private allowPrivate(): boolean {
    return this.settings.allowPrivate || this.privateSync;
  }

  private warnDropped(senderId: string, reason: string): void {
    if (this.warnedDrops.has(senderId)) {
      return;
    }
    this.warnedDrops.add(senderId);
    this.log.warn(`[weixin] 丢弃私聊（${reason}）：user_id=${senderId}`);
  }

  private warnPaused(): void {
    if (this.pauseWarned) {
      return;
    }
    this.pauseWarned = true;
    const minutes = Math.ceil(this.pauseRemainingMs() / 60_000);
    this.log.warn(
      `[weixin] bot token 已失效（-14），暂停收发约 ${minutes} 分钟；` +
        "持续失效时请重新扫码登录并更新 weixin.botToken",
    );
  }

  private pauseForStaleToken(detail: string | undefined): void {
    this.pausedUntil = Date.now() + SESSION_PAUSE_MS;
    this.pauseWarned = false;
    this.connected = false;
    this.log.error(
      `[weixin] getUpdates 返回 -14（bot token 失效），暂停 60 分钟${detail === undefined ? "" : `：${detail}`}`,
    );
  }

  private pauseRemainingMs(): number {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  private isPaused(): boolean {
    return this.pauseRemainingMs() > 0;
  }

  // -------------------------------------------------------------------------
  // 出站
  // -------------------------------------------------------------------------

  private async sendToTarget(target: OutboundTarget, text: string): Promise<void> {
    const contextToken = this.contextTokens.get(target.id);
    if (contextToken === undefined && !this.contextWarned) {
      this.contextWarned = true;
      this.log.warn(
        "[weixin] 还没有会话上下文令牌（context_token），仍会尝试发送；" +
          "若服务端返回 ret=-2，请先在微信里给机器人发一条消息",
      );
    }
    for (const chunk of splitText(text, this.settings.maxLength)) {
      await this.sendMessage(target, chunk, contextToken);
    }
  }

  private async sendMessage(
    target: OutboundTarget,
    text: string,
    contextToken: string | undefined,
  ): Promise<void> {
    const key = targetKey(target.kind, target.id);
    let withoutContext = contextToken === undefined;
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      await this.pace();
      try {
        const response = await this.apiPost<Record<string, unknown>>(
          "ilink/bot/sendmessage",
          {
            msg: leaveDefined({
              from_user_id: "",
              to_user_id: target.id,
              client_id: randomUUID(),
              message_type: 2,
              message_state: 2,
              context_token: withoutContext ? undefined : contextToken,
              item_list: [{ type: ITEM_TEXT, text_item: { text } }],
            }),
            base_info: weixinBaseInfo(),
          },
          this.settings.apiTimeoutMs,
        );
        const ret = numberOf(response["ret"]);
        if (ret !== undefined && ret !== 0) {
          throw new WeixinApiError(
            `微信 sendMessage 失败（ret=${ret}, errmsg=${stringOf(response["errmsg"]) ?? ""}）`,
            200,
            ret,
          );
        }
        this.log.debug?.(`[weixin] 已发送到 ${key}：${text.slice(0, 60)}`);
        return;
      } catch (error) {
        // `ret=-2 prepare failed` 多数是 context_token 过期：清掉后不带令牌重试一次
        if (
          error instanceof WeixinApiError &&
          error.ret === -2 &&
          !withoutContext &&
          contextToken !== undefined
        ) {
          withoutContext = true;
          this.contextTokens.delete(target.id);
          void this.persistContextTokens();
          this.log.warn(`[weixin] ${key} 的 context_token 已失效，去掉令牌重试`);
          attempt -= 1;
          continue;
        }
        const retryable =
          !(error instanceof WeixinApiError) ||
          error.status === 0 ||
          error.status === 429 ||
          error.status >= 500;
        if (!retryable || attempt === SEND_ATTEMPTS) {
          throw error;
        }
        await abortableSleep(
          300 * attempt,
          this.stopController.signal,
          this.ctx?.signal,
        );
      }
    }
  }

  /** 全局最小发送间隔：官方接口的具体频控未知，按保守值温柔发送 */
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
  // HTTP / 持久化
  // -------------------------------------------------------------------------

  private async apiPost<T = Record<string, unknown>>(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<T>;
  private async apiPost<T = Record<string, unknown>>(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    ignoreStop?: boolean,
  ): Promise<T>;
  private async apiPost<T = Record<string, unknown>>(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs = this.settings.apiTimeoutMs,
    ignoreStop = false,
  ): Promise<T> {
    const url = `${this.settings.apiBase}/${endpoint}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: this.requestSignal(timeoutMs, ignoreStop),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new WeixinApiError(`微信 API ${endpoint} 网络错误：${errorText(error)}`, 0);
    }

    const rawText = await response.text().catch(() => "");
    if (!response.ok) {
      throw new WeixinApiError(
        `微信 API ${endpoint} 失败 [${response.status}]：${rawText.slice(0, 200)}`,
        response.status,
      );
    }
    try {
      return parseWeixinJson<T>(rawText);
    } catch (error) {
      throw new WeixinApiError(
        `微信 API ${endpoint} 响应不是 JSON：${errorText(error)}`,
        response.status,
      );
    }
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${this.settings.botToken}`,
      "X-WECHAT-UIN": randomWechatUin(),
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": String(ILINK_CLIENT_VERSION),
      "User-Agent": USER_AGENT,
    };
  }

  /**
   * 组合停止信号、插件信号与超时。
   *
   * `ignoreStop` 只给「停止时的 notifystop」用：它必须能在 stopController
   * 已经 abort 之后仍然发出，否则后端永远收不到下线通知。
   */
  private requestSignal(timeoutMs: number, ignoreStop = false): AbortSignal {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    timer.unref?.();

    const sources: AbortSignal[] = [];
    if (!ignoreStop) {
      sources.push(this.stopController.signal);
      const ctxSignal = this.ctx?.signal;
      if (ctxSignal !== undefined) {
        sources.push(ctxSignal);
      }
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

  /** 启动 / 停止通知；失败只记调试日志，不影响主链路 */
  private async notify(endpoint: string): Promise<void> {
    try {
      await this.apiPost(endpoint, { base_info: weixinBaseInfo() }, this.settings.apiTimeoutMs, true);
      this.log.debug?.(`[weixin] ${endpoint} 已发送`);
    } catch (error) {
      this.log.debug?.(`[weixin] ${endpoint} 失败（忽略）：${errorText(error)}`);
    }
  }

  private async loadCursor(): Promise<void> {
    if (this.kv === undefined) {
      return;
    }
    try {
      const raw = await this.kv.get(CURSOR_KEY);
      if (raw === null || raw.length === 0) {
        return;
      }
      const value = Buffer.from(raw).toString("utf8").trim();
      if (value !== "") {
        this.cursor = value;
        this.log.info("[weixin] 从上次的 get_updates_buf 继续收取消息");
      }
    } catch (error) {
      if (!this.cursorWarned) {
        this.cursorWarned = true;
        this.log.warn(`[weixin] 读取 get_updates_buf 失败，从头开始：${errorText(error)}`);
      }
    }
  }

  private async saveCursor(): Promise<void> {
    if (this.kv === undefined) {
      return;
    }
    try {
      await this.kv.set(CURSOR_KEY, this.cursor);
    } catch (error) {
      if (!this.cursorWarned) {
        this.cursorWarned = true;
        this.log.warn(
          `[weixin] 保存 get_updates_buf 失败（重启后可能重复收取最后一批）：${errorText(error)}`,
        );
      }
    }
  }

  private async loadContextTokens(): Promise<void> {
    if (this.kv === undefined) {
      return;
    }
    try {
      const raw = await this.kv.get(CONTEXT_KEY);
      if (raw === null || raw.length === 0) {
        return;
      }
      const parsed = JSON.parse(Buffer.from(raw).toString("utf8")) as unknown;
      const record = objectOf(parsed);
      if (record === undefined) {
        return;
      }
      for (const [id, value] of Object.entries(record)) {
        const token = stringOf(value);
        if (token !== undefined && this.contextTokens.size < CONTEXT_LIMIT) {
          this.contextTokens.set(id, token);
        }
      }
      if (this.contextTokens.size > 0) {
        this.log.info(`[weixin] 恢复 ${this.contextTokens.size} 个会话上下文令牌`);
      }
    } catch (error) {
      this.log.debug?.(`[weixin] 读取会话上下文令牌失败（忽略）：${errorText(error)}`);
    }
  }

  private rememberContext(id: string, token: string): void {
    if (this.contextTokens.get(id) === token) {
      return;
    }
    this.contextTokens.set(id, token);
    while (this.contextTokens.size > CONTEXT_LIMIT) {
      const oldest = this.contextTokens.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.contextTokens.delete(oldest.value);
    }
    void this.persistContextTokens();
  }

  private async persistContextTokens(): Promise<void> {
    if (this.kv === undefined) {
      return;
    }
    try {
      await this.kv.set(CONTEXT_KEY, JSON.stringify(Object.fromEntries(this.contextTokens)));
    } catch (error) {
      if (!this.contextSaveWarned) {
        this.contextSaveWarned = true;
        this.log.warn(
          `[weixin] 保存会话上下文令牌失败（重启后需等对方先发消息）：${errorText(error)}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 工厂与工具
// ---------------------------------------------------------------------------

export const weixinPlatformFactory: PlatformFactory = {
  id: "weixin",
  title: "微信",
  description: "微信机器人 iLink 长轮询（getUpdates + sendMessage），单聊双向互通",
  create(options) {
    return new WeixinPlatform(options);
  },
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** 省略值为 `undefined` 的键，避免把 `context_token: undefined` 发出去 */
function leaveDefined(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}