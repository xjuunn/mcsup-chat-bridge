/**
 * QQ 平台适配器：QQ 机器人官方 API v2（QQ 开放平台）
 *
 * 协议依据（bot.q.qq.com 官方文档）：
 * - 访问凭证：`POST https://bots.qq.com/app/getAppAccessToken`
 *   body `{appId, clientSecret}` → `{access_token, expires_in}`；
 *   之后所有 OpenAPI 用 `Authorization: QQBot <access_token>`。
 * - 事件：`GET {apiBase}/gateway` 取 wss 地址，然后走 QQ 的 WebSocket
 *   Gateway：op 10 Hello → op 2 Identify（`token: "QQBot <token>"` +
 *   intents + shard）→ READY 拿 session_id；心跳 op 1 带最新 s；断线用
 *   op 6 Resume 续传，否则重新 Identify。
 * - 入站事件：`C2C_MESSAGE_CREATE`（单聊）、`GROUP_AT_MESSAGE_CREATE`
 *   （群里 @ 机器人）、`GROUP_MESSAGE_CREATE`（开启“接收所有消息”后的全量群消息）。
 * - 出站：`POST /v2/groups/{group_openid}/messages` 或
 *   `/v2/users/{user_openid}/messages`，`msg_type=0` 纯文本 / `2` Markdown。
 *
 * 设计取舍：
 * - 被动回复优先：QQ 只允许 60 分钟内对同一条消息被动回复 4 次（群聊 5 次，
 *   管理员 50 次）。适配器记录每个会话最近一条入站 msg_id，出站时带上
 *   `msg_id + 递增 msg_seq`；额度耗尽才降级为主动消息，避免直接撞频控。
 * - 主动消息有严格频控（群：bot 60/qpm、单关系 20/qpm、1000 条/天/群），
 *   因此出站串行 + 最小间隔；失败按 429/5xx 退避重试。
 * - 只用官方文本/消息段接口，不拼 CQ 码，避免注入。
 *
 * 与 OneBot 社区版的差异：QQ 官方机器人在群聊里默认只能收到 @ 它的消息；
 * 若在开放平台开通“接收所有消息”，会改为推送 GROUP_MESSAGE_CREATE。这是
 * 平台权限差异，不是适配器能绕过的。
 */

import WebSocket from "ws";

import { PluginError } from "mcsup-plugin";
import type { LogClient } from "mcsup-plugin";
import { CATEGORIES } from "../core/types.js";
import type { MessageCategory, NormalizedMessage } from "../core/types.js";
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

/** 解析后的 QQ 配置；数值都有默认值，工厂不做额外 IO */
export interface QqSettings {
  readonly appId: string;
  readonly clientSecret: string;
  /** OpenAPI 基址（默认 `https://api.sgroup.qq.com`，沙箱用 sandbox 前缀） */
  readonly apiBase: string;
  /** 获取 access_token 的地址 */
  readonly tokenUrl: string;
  /** 位或后的 intents */
  readonly intents: number;
  /** 是否用 Markdown（msg_type=2）发送；默认纯文本，避免玩家消息里的符号被渲染 */
  readonly markdown: boolean;
  readonly groups: readonly string[];
  readonly privateUsers: readonly string[];
  readonly allowedUsers: readonly string[];
  readonly categories?: readonly MessageCategory[];
  readonly inbound: boolean;
  readonly allowPrivate: boolean;
  readonly label: string;
  readonly server?: string;
  readonly maxLength: number;
  /** 有可用入站 msg_id 时优先走被动回复 */
  readonly passiveReply: boolean;
  /** 同一条消息最多被动回复次数（单聊 4、群聊 5，取默认 4 更保守） */
  readonly passiveLimit: number;
  /** 被动回复窗口；官方 60 分钟，默认留 5 分钟余量 */
  readonly passiveTtlMs: number;
  /** 两次 OpenAPI 调用之间的最小间隔 */
  readonly sendIntervalMs: number;
  /** 单次 HTTP 调用超时 */
  readonly apiTimeoutMs: number;
  readonly reconnectMinMs: number;
  readonly reconnectMaxMs: number;
  /** 0 表示无限重试 */
  readonly reconnectMaxAttempts: number;
}

/** 官方 intents 位；按需组合，默认只订阅群聊/单聊事件 */
export const INTENT_BITS = {
  guilds: 1 << 0,
  guild_members: 1 << 1,
  public_guild_messages: 1 << 30,
  direct_message: 1 << 12,
  group_and_c2c: 1 << 25,
  interaction: 1 << 26,
  message_audit: 1 << 27,
} as const;

export type IntentName = keyof typeof INTENT_BITS;

const DEFAULT_INTENTS: readonly IntentName[] = ["group_and_c2c"];
const INTENT_NAMES = Object.keys(INTENT_BITS) as IntentName[];

const DEFAULT_API_BASE = "https://api.sgroup.qq.com";
const SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";
const DEFAULT_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const USER_AGENT = "mcsup-chat-bridge/0.1.0 (QQBotAdapter)";

/** 出站队列上限：分发层之外再兜一层，避免重连期间无限堆积 */
const OUTBOUND_LIMIT = 512;
/** 已处理消息 id 的记忆上限，用于抵御平台重发 */
const SEEN_LIMIT = 1_000;
/** 单次出站失败后的重试次数（首次 + 2 次重试） */
const SEND_ATTEMPTS = 3;
/** 被动回复失效后允许的兜底主动消息；官方频控较严，失败只记日志 */
const PASSIVE_EXPIRED_CODES = new Set([40034005, 304103, 40034024]);
const DEDUPE_CODE = 40054005;
const AUTH_CODES = new Set([11241, 11243, 11244]);
const RATE_LIMIT_CODE = 4008;
const QUICK_DISCONNECT_THRESHOLD_MS = 5_000;
const MAX_QUICK_DISCONNECTS = 3;

/** WS 关闭码：致命错误直接停止重连 */
const FATAL_CLOSE_CODES = new Map<number, string>([
  [4001, "无效的 opcode"],
  [4002, "无效的 payload"],
  [4010, "无效的 shard"],
  [4011, "需要分片"],
  [4012, "无效的 API 版本"],
  [4013, "无效的 intents（请在 QQ 开放平台检查事件权限）"],
  [4014, "intents 无权限"],
  [4914, "机器人已下架，只允许沙箱环境"],
  [4915, "机器人已被封禁"],
]);

/** 关闭码：会话失效，需要重新 Identify */
const SESSION_INVALID_CLOSE_CODES = new Set([4006, 4007, ...range(4900, 4913)]);

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let value = from; value <= to; value += 1) {
    out.push(value);
  }
  return out;
}

/**
 * 校验并补全配置。
 *
 * 缺 AppID / ClientSecret 时抛 `invalid_input`，让宿主在启动阶段回滚配置，
 * 而不是等到第一条消息才静默失败。
 */
export function parseQqSettings(raw: unknown): QqSettings {
  if (typeof raw !== "object" || raw === null) {
    throw new PluginError(
      "invalid_input",
      "平台 qq 缺少配置：请填写 QQ 开放平台的 appId 与 clientSecret",
    );
  }
  const record = raw as Record<string, unknown>;
  const appId = stringOf(record["appId"]);
  if (appId === undefined) {
    throw new PluginError("invalid_input", "平台 qq 缺少 appId：请在 q.qq.com 机器人管理端获取");
  }
  const clientSecret = stringOf(record["clientSecret"]);
  if (clientSecret === undefined) {
    throw new PluginError("invalid_input", "平台 qq 缺少 clientSecret：请在 q.qq.com 机器人管理端获取");
  }

  const sandbox = boolOf(record["sandbox"], false);
  const apiBase = urlOf(record["apiBase"]) ?? (sandbox ? SANDBOX_API_BASE : DEFAULT_API_BASE);
  const tokenUrl = urlOf(record["tokenUrl"]) ?? DEFAULT_TOKEN_URL;
  const intents = intentsOf(record["intents"]);
  const categories = categoriesOf(record["categories"]);
  const server = stringOf(record["server"]);

  return {
    appId,
    clientSecret,
    apiBase,
    tokenUrl,
    intents,
    markdown: boolOf(record["markdown"], false),
    groups: stringsOf(record["groups"]),
    privateUsers: stringsOf(record["privateUsers"]),
    allowedUsers: stringsOf(record["allowedUsers"]),
    ...(categories === undefined ? {} : { categories }),
    inbound: boolOf(record["inbound"], true),
    allowPrivate: boolOf(record["allowPrivate"], false),
    label: stringOf(record["label"]) ?? "QQ",
    ...(server === undefined ? {} : { server }),
    maxLength: intOf(record["maxLength"], 1_500, 64, 4_000),
    passiveReply: boolOf(record["passiveReply"], true),
    passiveLimit: intOf(record["passiveLimit"], 4, 1, 50),
    passiveTtlMs: intOf(record["passiveTtlMs"], 55 * 60_000, 10_000, 60 * 60_000),
    sendIntervalMs: intOf(record["sendIntervalMs"], 500, 0, 10_000),
    apiTimeoutMs: intOf(record["apiTimeoutMs"], 15_000, 1_000, 60_000),
    reconnectMinMs: intOf(record["reconnectMinMs"], 1_000, 200, 60_000),
    reconnectMaxMs: intOf(record["reconnectMaxMs"], 60_000, 1_000, 600_000),
    reconnectMaxAttempts: intOf(record["reconnectMaxAttempts"], 0, 0, 10_000),
  };
}

function intentsOf(value: unknown): number {
  const names = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
  const chosen = names.length === 0 ? DEFAULT_INTENTS : names;
  let bits = 0;
  for (const name of chosen) {
    const normalized = name.trim().toLowerCase() as IntentName;
    if (!INTENT_NAMES.includes(normalized)) {
      throw new PluginError(
        "invalid_input",
        `qq.intents 含未知事件 ${name}；可选：${INTENT_NAMES.join(", ")}`,
      );
    }
    bits |= INTENT_BITS[normalized];
  }
  return bits;
}

/**
 * 出站格式。
 *
 * 玩家聊天严格使用 `[玩家名]:消息`（需求指定的格式）；其他类别用中文类别标签，
 * 避免把「加入了游戏」渲染成 `[Alex]:加入了游戏` 这种歧义句式。
 */
export function formatOutbound(message: NormalizedMessage): string {
  const text = message.text.replace(/\r?\n/g, " ").trim();
  if (text === "") {
    return "";
  }
  if (message.category === "chat" && message.from !== null) {
    return `[${message.from}]:${text}`;
  }
  const label = CATEGORY_LABELS[message.category];
  return message.from === null ? `[${label}] ${text}` : `[${label}] ${message.from}: ${text}`;
}

const CATEGORY_LABELS: Record<MessageCategory, string> = {
  chat: "聊天",
  command: "命令",
  join: "加入",
  leave: "离开",
  system: "系统",
  warning: "警告",
  error: "错误",
  death: "死亡",
  advancement: "进度",
  other: "其他",
};

/**
 * 把 QQ 官方入站事件归一为纯文本。
 *
 * - 全量群消息里 @ 会被替换成 `<@member_openid>`，这里换成 `@昵称`；
 *   机器人自己的 @ 直接去掉。
 * - 引用消息（`message_type=103`）正文在 `msg_elements` 里。
 * - 附件转占位文本，语音优先用 QQ 自带 ASR 结果。
 */
export function qqInboundText(event: Record<string, unknown>): string {
  let text = stringOf(event["content"]) ?? "";

  const mentions = Array.isArray(event["mentions"]) ? event["mentions"] : [];
  const names = new Map<string, { name?: string; isYou: boolean }>();
  for (const item of mentions) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const mention = item as Record<string, unknown>;
    const key = stringOf(mention["member_openid"]) ?? stringOf(mention["id"]);
    const name = stringOf(mention["member_nickname"]) ?? stringOf(mention["username"]);
    if (key !== undefined) {
      names.set(key, { ...(name === undefined ? {} : { name }), isYou: mention["is_you"] === true });
    }
  }
  text = text.replace(/<@!?([^>]+)>/g, (_match, id: string) => {
    if (id === "all" || id === "everyone") {
      return "@全体成员";
    }
    const found = names.get(id);
    if (found === undefined || found.isYou) {
      return "";
    }
    return found.name === undefined ? "" : `@${found.name}`;
  });

  if (text.trim() === "" && Number(event["message_type"]) === 103) {
    const elements = Array.isArray(event["msg_elements"]) ? event["msg_elements"] : [];
    const first = elements.find((item) => typeof item === "object" && item !== null) as
      | Record<string, unknown>
      | undefined;
    const quoted = first === undefined ? undefined : stringOf(first["content"]);
    if (quoted !== undefined) {
      text = `[引用] ${quoted}`;
    }
  }

  const markers: string[] = [];
  const attachments = Array.isArray(event["attachments"]) ? event["attachments"] : [];
  for (const item of attachments) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const attachment = item as Record<string, unknown>;
    const type = stringOf(attachment["content_type"]) ?? "";
    if (type.startsWith("image/")) {
      markers.push("[图片]");
    } else if (type === "voice") {
      const asr = stringOf(attachment["asr_refer_text"]);
      markers.push(asr === undefined ? "[语音]" : `[语音] ${asr}`);
    } else if (type.startsWith("video/")) {
      markers.push("[视频]");
    } else {
      const name = stringOf(attachment["filename"]);
      markers.push(name === undefined ? "[文件]" : `[文件: ${name}]`);
    }
  }
  if (markers.length > 0) {
    text = `${text} ${markers.join(" ")}`;
  }

  return text.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

interface OutboundTarget {
  readonly kind: "group" | "private";
  readonly id: string;
}

interface PassiveEntry {
  readonly messageId: string;
  readonly firstAt: number;
  count: number;
}

interface PendingSend {
  readonly message: NormalizedMessage;
}

class QqApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
  ) {
    super(message);
  }
}

export class QqPlatform implements ChatPlatform {
  public readonly id = "qq";
  public readonly title = "QQ 机器人";

  private readonly settings: QqSettings;
  private readonly log: LogClient;
  private ctx: PlatformContext | undefined;
  private socket: WebSocket | undefined;
  private loop: Promise<void> | undefined;
  private stopping = false;
  private ready = false;
  private backoff: number;
  private attempts = 0;
  private lastSeq: number | null = null;
  private sessionId: string | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatMs = 30_000;
  private connectAt = 0;
  private quickDisconnects = 0;
  private fatal: string | undefined;

  private token: string | undefined;
  private tokenExpiresAt = 0;
  private tokenPromise: Promise<string> | undefined;

  private lastSendAt = 0;
  private sending = false;
  private warnedNoTarget = false;
  private readonly outQueue: PendingSend[] = [];
  private readonly seen = new Map<string, number>();
  private readonly passive = new Map<string, PassiveEntry>();
  private readonly seqs = new Map<string, number>();

  public constructor(options: PlatformCreateOptions) {
    this.log = options.log;
    this.settings = parseQqSettings(options.settings);
    this.backoff = this.settings.reconnectMinMs;
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
        this.teardown("桥停止");
      },
      { once: true },
    );
    this.loop = this.run();
  }

  public deliver(message: NormalizedMessage): void {
    if (this.settings.categories !== undefined && !this.settings.categories.includes(message.category)) {
      return;
    }
    if (formatOutbound(message) === "") {
      return;
    }
    if (this.outQueue.length >= OUTBOUND_LIMIT) {
      this.outQueue.shift();
      this.log.warn(`[qq] 出站积压超过 ${OUTBOUND_LIMIT} 条，丢弃最旧消息`);
    }
    this.outQueue.push({ message });
    void this.flushOutbound();
  }

  public async stop(reason: string): Promise<void> {
    this.stopping = true;
    this.teardown(reason);
    const loop = this.loop;
    if (loop !== undefined) {
      await Promise.race([loop, sleep(1_000)]);
    }
  }

  // -------------------------------------------------------------------------
  // 连接生命周期
  // -------------------------------------------------------------------------

  private async run(): Promise<void> {
    while (!this.stopping) {
      if (this.fatal !== undefined) {
        this.log.error(`[qq] 已停止重连：${this.fatal}`);
        return;
      }
      try {
        await this.openGateway();
        this.connectAt = Date.now();
        await this.session();
      } catch (error) {
        if (!this.stopping) {
          this.log.warn(`[qq] 连接失败：${errorText(error)}`);
        }
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
        // 4008：发送 payload 过快；官方建议等待后重连
        this.log.warn("[qq] 触发网关限流（4008），60 秒后重连");
        await this.abortableSleep(60_000);
        continue;
      }
      if (closeCode !== undefined) {
        const fatal = FATAL_CLOSE_CODES.get(closeCode);
        if (fatal !== undefined) {
          this.fatal = `${fatal}（关闭码 ${closeCode}），请检查 AppID/ClientSecret 与开放平台权限`;
          continue;
        }
        if (closeCode === 4004) {
          // 4004：token 无效，清掉缓存，下次重建连接时强制重取
          this.log.info("[qq] access_token 无效（4004），将刷新后重连");
          this.token = undefined;
          this.tokenExpiresAt = 0;
          this.sessionId = undefined;
          this.lastSeq = null;
        } else if (SESSION_INVALID_CLOSE_CODES.has(closeCode)) {
          // 4006/4007/4900~4913：会话不可恢复，重新 Identify
          this.sessionId = undefined;
          this.lastSeq = null;
        }
        // 4009（连接超时）故意不清 session：协议允许继续 Resume
      }
      if (closeCode !== undefined && this.shortLifecycle()) {
        this.quickDisconnects += 1;
        if (this.quickDisconnects >= MAX_QUICK_DISCONNECTS) {
          this.fatal = "连续短连接失败，请检查 AppID/Secret 与机器人事件权限";
          continue;
        }
      } else if (this.ready) {
        this.quickDisconnects = 0;
      }
      this.ready = false;

      if (this.settings.reconnectMaxAttempts > 0 && this.attempts >= this.settings.reconnectMaxAttempts) {
        this.log.error(`[qq] 达到最大重连次数 ${this.settings.reconnectMaxAttempts}`);
        return;
      }
      this.attempts += 1;
      const wait = jitter(this.backoff);
      this.log.info(`[qq] ${Math.round(wait)} ms 后重连（第 ${this.attempts} 次）`);
      await this.abortableSleep(wait);
      this.backoff = Math.min(
        this.settings.reconnectMaxMs,
        Math.max(this.settings.reconnectMinMs, this.backoff * 2),
      );
    }
  }

  private pendingCloseCode: number | undefined;
  private resolveClosed: (() => void) | undefined;

  /** 连接存活时间过短，视为权限/配置问题 */
  private shortLifecycle(): boolean {
    return this.connectAt > 0 && Date.now() - this.connectAt < QUICK_DISCONNECT_THRESHOLD_MS;
  }

  private async openGateway(): Promise<void> {
    const gatewayUrl = await this.getGatewayUrl();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(gatewayUrl, {
        handshakeTimeout: 10_000,
        headers: { "User-Agent": USER_AGENT },
      });
      this.socket = socket;

      // 监听必须在 open 之前挂好：官方 Gateway 连上后立即推 op10 Hello，
      // 若等 open 回调之后再挂 message，Hello 会在微任务间隙里丢掉。
      socket.on("message", (data: WebSocket.RawData) => {
        this.onFrame(data.toString());
      });
      socket.on("error", (error: Error) => {
        if (!this.stopping && this.fatal === undefined) {
          this.log.warn(`[qq] WebSocket 错误：${errorText(error)}`);
        }
      });
      socket.on("close", (code: number, reason: Buffer) => {
        this.pendingCloseCode = code;
        this.ready = false;
        if (!this.stopping) {
          this.log.info(
            `[qq] WebSocket 关闭（${code}${reason.length > 0 ? ` ${reason.toString()}` : ""}）`,
          );
        }
        this.resolveClosed?.();
      });

      const onError = (error: Error): void => {
        socket.terminate();
        reject(error);
      };
      socket.once("open", () => {
        socket.off("error", onError);
        resolve();
      });
      socket.once("error", onError);
    });
    this.log.info(`[qq] WebSocket 已连接（appId=${this.settings.appId}）`);
  }

  private async session(): Promise<void> {
    const socket = this.socket;
    if (socket === undefined) {
      throw new Error("WebSocket 未建立");
    }
    if (socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
      // 竞态兜底：注册回调前已经关闭
      if (this.socket === undefined || this.socket.readyState === WebSocket.CLOSED) {
        resolve();
      }
    });
    this.resolveClosed = undefined;
  }

  private onFrame(text: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.log.debug?.("[qq] 收到非 JSON 帧，已忽略");
      return;
    }
    if (typeof frame !== "object" || frame === null) {
      return;
    }
    const record = frame as Record<string, unknown>;
    const seq = record["s"];
    if (typeof seq === "number" && Number.isFinite(seq)) {
      this.lastSeq = this.lastSeq === null ? seq : Math.max(this.lastSeq, seq);
    }

    switch (record["op"]) {
      case 10: {
        const data = (typeof record["d"] === "object" && record["d"] !== null
          ? record["d"]
          : {}) as Record<string, unknown>;
        const interval = typeof data["heartbeat_interval"] === "number"
          ? data["heartbeat_interval"]
          : 30_000;
        this.heartbeatMs = Math.max(5_000, Math.floor(interval * 0.9));
        this.startHeartbeat();
        this.log.debug?.(`[qq] Hello，心跳间隔 ${this.heartbeatMs} ms`);
        if (this.sessionId !== undefined && this.lastSeq !== null) {
          void this.resume();
        } else {
          void this.identify();
        }
        return;
      }
      case 0: {
        this.onDispatch(String(record["t"] ?? ""), record["d"]);
        return;
      }
      case 7: {
        this.log.info("[qq] 服务端要求重连（op 7）");
        this.closeSocket(4_000, "server reconnect");
        return;
      }
      case 9: {
        if (record["d"] === false || record["d"] === null || record["d"] === undefined) {
          this.sessionId = undefined;
          this.lastSeq = null;
        }
        this.log.info("[qq] 会话失效（op 9），准备重连");
        this.closeSocket(4_000, "invalid session");
        return;
      }
      case 11:
        return;
      default:
        this.log.debug?.(`[qq] 未处理的 op：${String(record["op"])}`);
    }
  }

  private onDispatch(type: string, data: unknown): void {
    const event = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};

    switch (type) {
      case "READY": {
        const sessionId = stringOf(event["session_id"]);
        if (sessionId !== undefined) {
          this.sessionId = sessionId;
        }
        this.ready = true;
        this.attempts = 0;
        this.backoff = this.settings.reconnectMinMs;
        this.quickDisconnects = 0;
        this.log.info(`[qq] 鉴权成功（session=${this.sessionId ?? "-"}）`);
        return;
      }
      case "RESUMED": {
        this.ready = true;
        this.attempts = 0;
        this.backoff = this.settings.reconnectMinMs;
        this.log.info("[qq] 会话已恢复");
        return;
      }
      case "INTERACTION_CREATE": {
        void this.ackInteraction(stringOf(event["id"]));
        return;
      }
      case "C2C_MESSAGE_CREATE":
      case "GROUP_AT_MESSAGE_CREATE":
      case "GROUP_MESSAGE_CREATE": {
        this.onMessage(type, event);
        return;
      }
      default:
        this.log.debug?.(`[qq] 忽略事件 ${type}`);
    }
  }

  private async identify(): Promise<void> {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      const token = await this.ensureToken();
      socket.send(
        JSON.stringify({
          op: 2,
          d: {
            token: `QQBot ${token}`,
            intents: this.settings.intents,
            shard: [0, 1],
            properties: {
              $os: process.platform,
              $browser: "mcsup-chat-bridge",
              $device: "mcsup-chat-bridge",
            },
          },
        }),
      );
      this.log.debug?.("[qq] Identify 已发送");
    } catch (error) {
      this.log.warn(`[qq] Identify 失败：${errorText(error)}`);
      this.closeSocket(4_000, "identify failed");
    }
  }

  private async resume(): Promise<void> {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      const token = await this.ensureToken();
      socket.send(
        JSON.stringify({
          op: 6,
          d: {
            token: `QQBot ${token}`,
            session_id: this.sessionId,
            seq: this.lastSeq,
          },
        }),
      );
      this.log.debug?.(`[qq] Resume 已发送（seq=${this.lastSeq ?? 0}）`);
    } catch (error) {
      this.log.warn(`[qq] Resume 失败：${errorText(error)}`);
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
    this.heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        socket.send(JSON.stringify({ op: 1, d: this.lastSeq }));
      } catch {
        socket.terminate();
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
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

  private teardown(reason: string): void {
    this.stopHeartbeat();
    this.ready = false;
    this.outQueue.length = 0;
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

  private cleanupSocket(): void {
    this.stopHeartbeat();
    this.ready = false;
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

  // -------------------------------------------------------------------------
  // 入站
  // -------------------------------------------------------------------------

  private onMessage(type: string, event: Record<string, unknown>): void {
    const ctx = this.ctx;
    if (ctx === undefined || !this.settings.inbound) {
      return;
    }
    const messageId = stringOf(event["id"]);
    if (messageId !== undefined) {
      if (this.seen.has(messageId)) {
        return;
      }
      this.rememberSeen(messageId);
    }

    const author = (typeof event["author"] === "object" && event["author"] !== null
      ? event["author"]
      : {}) as Record<string, unknown>;
    if (author["bot"] === true) {
      // 机器人自己的消息（全量群消息模式下会收到），不回灌，避免自激
      return;
    }

    const text = qqInboundText(event);
    if (text === "") {
      return;
    }

    const isGroup = type === "GROUP_AT_MESSAGE_CREATE" || type === "GROUP_MESSAGE_CREATE";
    const channelId = isGroup
      ? stringOf(event["group_openid"])
      : stringOf(author["user_openid"]) ?? stringOf(author["id"]);
    if (channelId === undefined) {
      return;
    }

    const authorId = isGroup
      ? stringOf(author["member_openid"]) ?? stringOf(author["id"])
      : stringOf(author["user_openid"]) ?? stringOf(author["id"]);
    if (authorId === undefined) {
      return;
    }

    if (this.settings.allowedUsers.length > 0 && !this.settings.allowedUsers.includes(authorId)) {
      return;
    }
    if (isGroup) {
      if (this.settings.groups.length > 0 && !this.settings.groups.includes(channelId)) {
        return;
      }
    } else {
      if (!this.settings.allowPrivate) {
        return;
      }
      if (this.settings.privateUsers.length > 0 && !this.settings.privateUsers.includes(channelId)) {
        return;
      }
    }

    const displayName =
      stringOf(author["member_nickname"]) ??
      stringOf(author["username"]) ??
      stringOf(author["nickname"]) ??
      authorId;

    const passiveKey = targetKey(isGroup ? "group" : "private", channelId);
    if (messageId !== undefined) {
      // 记录最近一条入站消息，出站时优先走被动回复
      this.passive.set(passiveKey, { messageId, firstAt: Date.now(), count: 0 });
    }

    const inbound: PlatformInboundMessage = {
      platform: this.id,
      channel: {
        kind: isGroup ? "group" : "private",
        id: channelId,
      },
      author: { id: authorId, name: displayName },
      text,
      label: this.settings.label,
      ...(messageId === undefined ? {} : { messageId }),
      ...(stringOf(event["timestamp"]) === undefined ? {} : { at: stringOf(event["timestamp"])! }),
      ...(this.settings.server === undefined ? {} : { server: this.settings.server }),
    };
    ctx.inbound(inbound);
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

  private async ackInteraction(interactionId: string | undefined): Promise<void> {
    if (interactionId === undefined) {
      return;
    }
    try {
      await this.apiRequest("PUT", `/interactions/${encodeURIComponent(interactionId)}`, { code: 0 });
    } catch (error) {
      this.log.warn(`[qq] 交互 ACK 失败：${errorText(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // 出站
  // -------------------------------------------------------------------------

  private targets(): readonly OutboundTarget[] {
    const targets: OutboundTarget[] = [];
    for (const group of this.settings.groups) {
      targets.push({ kind: "group", id: group });
    }
    for (const user of this.settings.privateUsers) {
      targets.push({ kind: "private", id: user });
    }
    return targets;
  }

  private async flushOutbound(): Promise<void> {
    if (this.sending || this.stopping) {
      return;
    }
    this.sending = true;
    try {
      while (!this.stopping && this.outQueue.length > 0) {
        const pending = this.outQueue.shift();
        if (pending === undefined) {
          continue;
        }
        const text = formatOutbound(pending.message);
        if (text === "") {
          continue;
        }
        const targets = this.targets();
        if (targets.length === 0) {
          if (!this.warnedNoTarget) {
            this.warnedNoTarget = true;
            this.log.warn("[qq] 未配置 groups / privateUsers，出站消息将被丢弃");
          }
          continue;
        }

        let failures = 0;
        for (const target of targets) {
          try {
            await this.sendToTarget(target, text);
          } catch (error) {
            failures += 1;
            this.log.warn(`[qq] 发送到 ${target.kind}:${target.id} 失败：${errorText(error)}`);
          }
        }
        if (failures === targets.length) {
          throw new Error(`QQ 所有目标均发送失败（${pending.message.id}）`);
        }
        if (failures > 0) {
          this.log.warn(`[qq] 消息 ${pending.message.id} 有 ${failures}/${targets.length} 个目标失败`);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private async sendToTarget(target: OutboundTarget, text: string): Promise<void> {
    const chunks = splitText(text, this.settings.maxLength);
    for (const chunk of chunks) {
      await this.sendChunk(target, chunk);
    }
  }

  private async sendChunk(target: OutboundTarget, text: string): Promise<void> {
    const key = targetKey(target.kind, target.id);
    const path =
      target.kind === "group"
        ? `/v2/groups/${encodeURIComponent(target.id)}/messages`
        : `/v2/users/${encodeURIComponent(target.id)}/messages`;

    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      await this.pace();
      const passive = this.takePassive(key);
      const body: Record<string, unknown> = {
        msg_seq: this.nextSeq(key),
        ...(this.settings.markdown
          ? { msg_type: 2, markdown: { content: text } }
          : { msg_type: 0, content: text }),
        ...(passive === undefined ? {} : { msg_id: passive.messageId }),
      };
      try {
        await this.apiRequest("POST", path, body);
        return;
      } catch (error) {
        if (!(error instanceof QqApiError)) {
          if (attempt < SEND_ATTEMPTS) {
            await this.abortableSleep(300 * attempt);
            continue;
          }
          throw error;
        }
        if (passive !== undefined && PASSIVE_EXPIRED_CODES.has(error.code ?? -1)) {
          // 被动回复窗口过期/次数超限：改为主动消息再试一次
          this.passive.delete(key);
          this.log.info(`[qq] ${key} 被动回复已失效，降级为主动消息`);
          attempt -= 1;
          continue;
        }
        if (error.code === DEDUPE_CODE) {
          this.bumpSeq(key);
          if (attempt < SEND_ATTEMPTS) {
            continue;
          }
        }
        const retryable =
          error.status === 429 || error.status >= 500 || error.status === 0 || AUTH_CODES.has(error.code ?? -1);
        if (!retryable || attempt === SEND_ATTEMPTS) {
          throw error;
        }
        await this.abortableSleep(Math.min(5_000, 400 * attempt));
      }
    }
  }

  /** 全局最小发送间隔：官方对主动消息有 qpm 频控，宁可慢一点 */
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

  private takePassive(key: string): PassiveEntry | undefined {
    if (!this.settings.passiveReply) {
      return undefined;
    }
    const entry = this.passive.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (Date.now() - entry.firstAt > this.settings.passiveTtlMs) {
      this.passive.delete(key);
      return undefined;
    }
    if (entry.count >= this.settings.passiveLimit) {
      return undefined;
    }
    entry.count += 1;
    return entry;
  }

  /** 每个会话维护单调递增的 msg_seq（官方要求同 msg_id 下唯一） */
  private nextSeq(key: string): number {
    const current = this.seqs.get(key) ?? 1;
    this.seqs.set(key, (current % 65_535) + 1);
    return current;
  }

  /** 平台报告 msg_id+msg_seq 重复时，跳过冲突的序号再发 */
  private bumpSeq(key: string): void {
    void this.nextSeq(key);
  }

  // -------------------------------------------------------------------------
  // HTTP / 凭证
  // -------------------------------------------------------------------------

  private async ensureToken(force = false): Promise<string> {
    if (!force && this.token !== undefined && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.token;
    }
    if (this.tokenPromise !== undefined) {
      return await this.tokenPromise;
    }
    this.tokenPromise = this.fetchToken();
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = undefined;
    }
  }

  private async fetchToken(): Promise<string> {
    const response = await this.fetchJson(this.settings.tokenUrl, {
      method: "POST",
      body: JSON.stringify({ appId: this.settings.appId, clientSecret: this.settings.clientSecret }),
    });
    const token = stringOf(response["access_token"]);
    if (token === undefined) {
      throw new Error("QQ access_token 响应缺少 access_token");
    }
    const expiresIn = typeof response["expires_in"] === "number" ? response["expires_in"] : 7_200;
    this.token = token;
    this.tokenExpiresAt = Date.now() + expiresIn * 1_000;
    this.log.debug?.(`[qq] access_token 已刷新，${expiresIn} 秒后过期`);
    return token;
  }

  private async getGatewayUrl(): Promise<string> {
    const response = await this.apiRequest("GET", "/gateway");
    const url = stringOf(response["url"]);
    if (url === undefined) {
      throw new Error("QQ /gateway 响应缺少 url");
    }
    return url;
  }

  private async apiRequest(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const attempt = async (): Promise<Response> => {
      const token = await this.ensureToken();
      return await fetch(`${this.settings.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `QQBot ${token}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.settings.apiTimeoutMs),
      });
    };

    let response: Response;
    try {
      response = await attempt();
      if (response.status === 401) {
        await this.ensureToken(true);
        response = await attempt();
      }
    } catch (error) {
      throw new QqApiError(`QQ API 网络错误（${path}）：${errorText(error)}`, 0);
    }

    const text = await response.text().catch(() => "");
    if (!response.ok) {
      let code: number | undefined;
      let detail = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (typeof parsed["err_code"] === "number") {
          code = parsed["err_code"];
        } else if (typeof parsed["code"] === "number") {
          code = parsed["code"];
        }
        if (typeof parsed["message"] === "string") {
          detail = parsed["message"];
        }
      } catch {
        // HTML/纯文本错误页
      }
      throw new QqApiError(
        `QQ API ${method} ${path} 失败 [${response.status}${code === undefined ? "" : `/${code}`}]：${detail}`,
        response.status,
        code,
      );
    }

    if (text.trim() === "") {
      return {};
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new QqApiError(`QQ API 响应不是 JSON（${path}）`, response.status);
    }
  }

  private async fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(this.settings.apiTimeoutMs),
    });
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      throw new QqApiError(`QQ 凭证请求失败 [${response.status}]：${text.slice(0, 200)}`, response.status);
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new QqApiError("QQ 凭证响应不是 JSON", response.status);
    }
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
}

export const qqPlatformFactory: PlatformFactory = {
  id: "qq",
  title: "QQ 机器人",
  description: "QQ 开放平台官方机器人 API v2（WebSocket Gateway + REST），群聊/单聊双向互通",
  create(options) {
    return new QqPlatform(options);
  },
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function targetKey(kind: "group" | "private", id: string): string {
  return `${kind}:${id}`;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function urlOf(value: unknown): string | undefined {
  const text = stringOf(value);
  if (text === undefined) {
    return undefined;
  }
  if (!/^https?:\/\//i.test(text)) {
    throw new PluginError("invalid_input", `qq 的 URL 必须以 http:// 或 https:// 开头，实际为 ${text}`);
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
    if (typeof item === "string" && (CATEGORIES as readonly string[]).includes(item)) {
      out.push(item as MessageCategory);
    }
  }
  return out.length === 0 ? undefined : out;
}

function splitText(text: string, max: number): string[] {
  // 按码点切分，避免把 emoji/代理对从中间截断
  const points = Array.from(text);
  if (points.length <= max) {
    return [text];
  }
  const chunks: string[] = [];
  for (let index = 0; index < points.length; index += max) {
    chunks.push(points.slice(index, index + max).join(""));
  }
  return chunks;
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