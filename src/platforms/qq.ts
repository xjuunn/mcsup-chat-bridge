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

import { createHash } from "node:crypto";

import WebSocket from "ws";

import { PluginError } from "mcsup-plugin";
import type { LogClient } from "mcsup-plugin";
import { LearnedTargets } from "../core/targets.js";
import { CATEGORIES } from "../core/types.js";
import type { MessageCategory, NormalizedMessage } from "../core/types.js";
import { formatOutbound, formatRelay, splitText } from "./format.js";
import type {
  ChatPlatform,
  PlatformContext,
  PlatformCreateOptions,
  PlatformFactory,
  PlatformInboundMessage,
  PlatformRelayMessage,
} from "./types.js";

// 出站格式与分片由 `format.ts` 统一提供；这里再导出一次，保持既有引用稳定。
export { formatOutbound } from "./format.js";

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
  /** 群聊与私聊互相同步（默认开启）；只影响 QQ 内部会话之间的转发 */
  readonly syncChannels: boolean;
  /** 群/私聊互转时是否把图片重新上传并转发（默认开启） */
  readonly forwardMedia: boolean;
  /**
   * 图文镜像的消息形态：
   * - `markdown`（默认）单条 Markdown 图文，图片先转存平台素材库换 `qqbot-media://` 引用，
   *   手机端也能显示；失败自动退回 `rich`。
   * - `rich` 单条富媒体（`msg_type=7`），图片在上、文字在下，兼容性最好。
   */
  readonly mediaMode: "markdown" | "rich";
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
const USER_AGENT = "mcsup-chat-bridge/0.1.15 (QQBotAdapter)";

/** 出站队列上限：分发层之外再兜一层，避免重连期间无限堆积 */
const OUTBOUND_LIMIT = 512;
/** 已处理消息 id 的记忆上限，用于抵御平台重发 */
const SEEN_LIMIT = 1_000;
/** 留空配置时自动记住的会话上限（群 / 私聊各自） */
const LEARNED_LIMIT = 64;
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
      "平台 qq 缺少配置：请填写 QQ 开放平台的 appId 与 clientSecret；只用 Telegram 时请从 platforms 移除 qq",
    );
  }
  const record = raw as Record<string, unknown>;
  const appId = stringOf(record["appId"]);
  if (appId === undefined) {
    throw new PluginError(
      "invalid_input",
      "平台 qq 缺少 appId：请在 q.qq.com 机器人管理端获取；只用 Telegram 时请从 platforms 移除 qq",
    );
  }
  const clientSecret = stringOf(record["clientSecret"]);
  if (clientSecret === undefined) {
    throw new PluginError(
      "invalid_input",
      "平台 qq 缺少 clientSecret：请在 q.qq.com 机器人管理端获取；只用 Telegram 时请从 platforms 移除 qq",
    );
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
    syncChannels: boolOf(record["syncChannels"], true),
    forwardMedia: boolOf(record["forwardMedia"], true),
    mediaMode: record["mediaMode"] === "rich" ? "rich" : "markdown",
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

  // QQ 客户端的表情在 content 里是 `<faceType=1,faceId="13",ext="...">` 这类标签，
  // 官方机器人无法原样渲染；转成占位，避免一大段标记出现在游戏聊天栏或镜像消息里。
  text = text.replace(/<faceType=\d+,faceId="\d+"(?:,ext="[^"]*")?\s*\/?>/g, "[表情]");

  return text.replace(/\s+/g, " ").trim();
}

/** 提取入站消息里的图片 URL（用于群/私聊之间转发真实图片） */
export function qqInboundImages(event: Record<string, unknown>): string[] {
  const attachments = Array.isArray(event["attachments"]) ? event["attachments"] : [];
  const urls: string[] = [];
  for (const item of attachments) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const attachment = item as Record<string, unknown>;
    const type = stringOf(attachment["content_type"]) ?? "";
    const url = stringOf(attachment["url"]);
    if (type.startsWith("image/") && url !== undefined && url !== "") {
      urls.push(url);
    }
  }
  return urls;
}

/**
 * 把文字里的 `[图片]` 占位换成 Markdown 图片，保证「文字在前、图片在后」且
 * 仍是同一条消息。
 *
 * 实测（QQ 官方 API v2）：Markdown 图片**必须带 `#宽px #高px`**，否则手机 QQ
 * 和电脑 QQ 都只显示 `[图片]` 占位、不加载图片。宽高从图片字节里解析，
 * 超过上限时等比缩小，避免被客户端拉伸。
 */
export function buildMediaMarkdown(
  text: string,
  images: readonly MediaMarkdownImage[],
): string {
  let index = 0;
  let out = text.replace(/\[图片\]/g, () => {
    const image = images[index];
    index += 1;
    return image === undefined ? "[图片]" : markdownImageTag(image);
  });
  // 附件比占位多时（例如表情贴纸没有对应占位），补在末尾，避免丢图。
  for (; index < images.length; index += 1) {
    const image = images[index];
    if (image !== undefined) {
      out += ` ${markdownImageTag(image)}`;
    }
  }
  return out;
}

/** Markdown 图文里的单张图片：引用地址 + 客户端展示尺寸 */
export interface MediaMarkdownImage {
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
}

function markdownImageTag(image: MediaMarkdownImage): string {
  const size =
    image.width !== undefined && image.height !== undefined
      ? ` #${image.width}px #${image.height}px`
      : "";
  return `![图片${size}](${image.url})`;
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
  /** 用于日志的标识（游戏消息用消息 id，镜像消息用 `mirror:...`） */
  readonly id: string;
  /** 已经格式化好的出站文本 */
  readonly text: string;
  /** 需要跳过的目标（`kind:id`），用于群/私聊镜像时不回发来源会话 */
  readonly exclude?: string;
  /**
   * 需要随消息一起转发的图片 URL。发送时先转存平台素材库换成
   * `qqbot-media://` 引用（Markdown 图文），失败再退回 `/files` 富媒体。
   */
  readonly media?: readonly string[];
  /** Markdown 图片最长边上限；贴纸传更小的值，避免表情被放大 */
  readonly mediaMaxPx?: number;
}

/** 平台素材库返回的图片引用（`qqbot-media://image/v1/...`） */
interface MediaImageRef {
  readonly url: string;
  readonly imageId?: string;
  /** 解析出的像素宽高；写进 Markdown 的 `#宽px #高px`，否则客户端不渲染图片 */
  readonly width?: number;
  readonly height?: number;
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
  /** 「私聊镜像发不到群」只告警一次，避免每条私聊都刷屏 */
  private warnedNoMirror = false;
  private readonly outQueue: PendingSend[] = [];
  private readonly seen = new Map<string, number>();
  private readonly passive = new Map<string, PassiveEntry>();
  private readonly seqs = new Map<string, number>();
  /** 被过滤丢弃的会话只告警一次，避免刷屏；键为 `kind:id` */
  private readonly warnedDrops = new Set<string>();
  /**
   * 未显式配置 `groups` / `privateUsers` 时，出站目标取「收到过消息的会话」。
   * 这样默认即全部：不用抄 openid 也能把游戏消息发回群里 / 私聊。
   *
   * 记录走宿主 `storage:kv`（`plugin-data/<id>/kv/`，按插件 id 划分，升级与
   * 宿主重启后仍在），否则重启后群里没先说话之前，私聊镜像会无目标可发。
   */
  private readonly learned: LearnedTargets;
  /** 全局 `privateSync`：打开后即使 `qq.allowPrivate=false` 也接收私聊 */
  private readonly privateSync: boolean;

  public constructor(options: PlatformCreateOptions) {
    this.log = options.log;
    this.settings = parseQqSettings(options.settings);
    this.privateSync = options.private === true;
    this.backoff = this.settings.reconnectMinMs;
    this.learned = new LearnedTargets({
      key: "qq:targets",
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
    const text = formatOutbound(message);
    if (text === "") {
      return;
    }
    this.enqueue({ id: message.id, text });
  }

  /**
   * 接收其它平台转发来的消息并发送到本平台的会话目标。
   *
   * 只入自己的出站队列，不回流 `ctx.inbound`：来源平台已经处理过一次入站，
   * 再回流就会形成 qq → telegram → qq 的环。由此平台侧也不需要额外的回声
   * 窗口——转发路径与入站路径完全分开。
   *
   * 跨平台不复用媒体句柄：QQ 侧图片要先转存 `qqbot-media://`，Telegram 的
   * `file_id` 在 QQ 上无效。正文里的 `[图片]` 之类占位原样保留，让接收方
   * 知道原消息带图，但图片本身不发。
   *
   * 来源会话在本平台不存在时不需要排除：QQ 的会话 id 是 openid，与其它平台
   * 的 id 空间不重叠，`exclude` 不会有命中。
   */
  public relay(message: PlatformRelayMessage): void {
    if (this.stopping) {
      return;
    }
    const text = formatRelay(message);
    if (text === "") {
      return;
    }
    this.enqueue({ id: `relay:${message.platform}:${message.messageId ?? message.at ?? ""}`, text });
  }

  /** 入队一条已格式化的出站消息；超限时丢最旧，避免重连期间无限堆积 */
  private enqueue(pending: PendingSend): void {
    if (this.outQueue.length >= OUTBOUND_LIMIT) {
      this.outQueue.shift();
      this.log.warn(`[qq] 出站积压超过 ${OUTBOUND_LIMIT} 条，丢弃最旧消息`);
    }
    this.outQueue.push(pending);
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
    // 先恢复记住的会话，再连网关：入站消息一到就要能正确算出发给谁
    await this.learned.load();
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
      case "GROUP_ADD_ROBOT":
      case "GROUP_DEL_ROBOT": {
        // 入群/退群事件是拿到 group_openid 的唯一可靠来源（群号无法换算）
        const groupId = stringOf(event["group_openid"]);
        if (groupId === undefined) {
          this.log.info(`[qq] ${type}（未带 group_openid）`);
          return;
        }
        if (type === "GROUP_ADD_ROBOT") {
          this.log.info(
            `[qq] 机器人已加入群：group_openid=${groupId}；把它填进 qq.groups 才能在该群收发`,
          );
        } else {
          this.log.info(`[qq] 机器人已被移出群：group_openid=${groupId}`);
        }
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
    if (ctx === undefined) {
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
      this.warnDropped(isGroup, channelId, authorId, "发言人不在 allowedUsers 白名单");
      return;
    }
    if (isGroup) {
      if (this.settings.groups.length > 0 && !this.settings.groups.includes(channelId)) {
        this.warnDropped(isGroup, channelId, authorId, "群不在 qq.groups 白名单");
        return;
      }
    } else {
      if (!this.allowPrivate()) {
        this.warnDropped(
          isGroup,
          channelId,
          authorId,
          "私聊未启用（qq.allowPrivate=false）；如需接收私聊，把 qq.allowPrivate 设为 true，" +
            "或在安装向导里打开「同步私聊消息」",
        );
        return;
      }
      if (this.settings.privateUsers.length > 0 && !this.settings.privateUsers.includes(channelId)) {
        this.warnDropped(isGroup, channelId, authorId, "私聊对象不在 qq.privateUsers 白名单");
        return;
      }
    }

    const displayName =
      stringOf(author["member_nickname"]) ??
      stringOf(author["username"]) ??
      stringOf(author["nickname"]) ??
      authorId;

    // 首次见到某个会话时打一条 info；同时记进出站目标，留空配置时也能发回这里。
    // 同一会话只打一次，不刷屏。
    const channelKey = `${isGroup ? "group" : "private"}:${channelId}`;
    this.learnChannel(isGroup, channelId);
    if (!this.warnedDrops.has(`seen:${channelKey}`)) {
      this.warnedDrops.add(`seen:${channelKey}`);
      this.log.info(
        isGroup
          ? `[qq] 收到群消息：group_openid=${channelId}，作者=${displayName}（member_openid=${authorId}）`
          : `[qq] 收到私聊消息：user_openid=${channelId}，作者=${displayName}`,
      );
    }

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
      ...(this.settings.inbound ? {} : { inject: false }),
      ...(messageId === undefined ? {} : { messageId }),
      ...(stringOf(event["timestamp"]) === undefined ? {} : { at: stringOf(event["timestamp"])! }),
      ...(this.settings.server === undefined ? {} : { server: this.settings.server }),
    };
    ctx.inbound(inbound);

    // 图片转发：优先用 Markdown 单条消息（文字在前、图片在后）。
    // 只有纯表情消息（正文只有 face 标签）时，贴纸图片就是那个表情：
    // 不保留 `[表情]` 占位，让表情图片直接跟在昵称后面。
    const images = this.settings.forwardMedia ? qqInboundImages(event) : [];
    const rawContent = stringOf(event["content"]) ?? "";
    const faceOnly =
      images.length > 0 &&
      /<faceType=\d+,faceId="\d+"/.test(rawContent) &&
      rawContent
        .replace(/<faceType=\d+,faceId="\d+"(?:,ext="[^"]*")?\s*\/?>/g, "")
        .replace(/<@!?[^>]+>/g, "")
        .trim() === "";
    this.mirrorToOtherChannels(isGroup, channelId, displayName, text, images, faceOnly);
  }

  /**
   * 群聊与私聊互相同步（qq.syncChannels，默认开启）。
   *
   * 收到 QQ 消息后，把它再发到「除来源会话之外」的其它会话：群里发的进私聊，
   * 私聊发的进群。跳过来源会话是为了避免把消息原样回发到发源地（造成重复），
   * 机器人自己发的消息不会再触发入站事件，因此不会形成回环。
   *
   * 带图片时发一条 Markdown 图文消息：`[群] 昵称: 文字 ![图片](url)`，
   * 文字在前、图片在后，仍是同一条消息。Markdown 失败时退回「文本 + 富媒体上传」。
   */
  private mirrorToOtherChannels(
    isGroup: boolean,
    channelId: string,
    displayName: string,
    text: string,
    images: readonly string[],
    faceOnly: boolean,
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
    const shownText = faceOnly ? text.replace(/\[表情\]\s*/g, "").trim() : text;
    const caption = `[${isGroup ? "群" : "私聊"}] ${displayName}: ${shownText}`;
    this.enqueue({
      id: `mirror:${exclude}`,
      text: caption,
      exclude,
      ...(images.length === 0
        ? {}
        : {
            media: images,
            // 纯表情消息里的图是贴纸：限制得更小，避免被当成大图展开
            ...(faceOnly ? { mediaMaxPx: STICKER_MAX_DISPLAY_PX } : {}),
          }),
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

  /** 私聊是否可接收：平台自己的开关与全局 `privateSync` 取并集 */
  private allowPrivate(): boolean {
    return this.settings.allowPrivate || this.privateSync;
  }

  /**
   * 入站被过滤时告警一次（每个会话独立），并带上 OpenID。
   *
   * OpenID 无法从 QQ 号推导，只能从事件里取；配置阶段如果静默丢弃，用户
   * 既不知道被过滤，也拿不到填配置所需的值。
   */
  private warnDropped(
    isGroup: boolean,
    channelId: string,
    authorId: string,
    reason: string,
  ): void {
    const key = `${isGroup ? "group" : "private"}:${channelId}`;
    if (this.warnedDrops.has(key)) {
      return;
    }
    this.warnedDrops.add(key);
    this.log.warn(
      isGroup
        ? `[qq] 丢弃群消息（${reason}）：group_openid=${channelId}，作者 member_openid=${authorId}`
        : `[qq] 丢弃私聊消息（${reason}）：user_openid=${channelId}，作者=${authorId}`,
    );
  }

  /**
   * 「镜像无处可发」时告警一次
   *
   * 群/私聊镜像的目标来自「见过的会话」，而群的 `group_openid` 只有在群里说过
   * 话（或入群事件）之后才知道：`qq.groups` 留空时，群里还没开过口之前，私聊
   * 消息往群里镜像算出来是零个目标。旧实现直接静默返回——用户只看到「群里不
   * 同步」，日志里一个字都没有。这里说清缺什么、怎么补。
   */
  private warnNoMirrorTarget(isGroup: boolean): void {
    if (this.warnedNoMirror || !this.settings.syncChannels) {
      return;
    }
    // 缺目标只会发生在「私聊 → 群」：私聊目标随第一条私聊就有，群目标要等群开口
    if (isGroup) {
      return;
    }
    if (this.settings.groups.length > 0 || this.learned.groups().length > 0) {
      return;
    }
    this.warnedNoMirror = true;
    this.log.warn(
      "[qq] 私聊镜像暂时发不到群：还没有记录到任何群会话（在群里发一条消息即可自动补齐，或把 qq.groups 填成群 openid）",
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
        const text = pending.text;
        if (text === "") {
          continue;
        }
        const targets = this.targets().filter(
          (target) => pending.exclude !== targetKey(target.kind, target.id),
        );
        if (targets.length === 0) {
          // 会话列表为空（还没收到过任何消息）才是真的没有目标；
          // 仅因 `exclude` 过滤掉唯一目标是正常情况，不告警。
          const hasAny =
            this.settings.groups.length +
              this.settings.privateUsers.length +
              this.learned.size >
            0;
          if (!hasAny && !this.warnedNoTarget) {
            this.warnedNoTarget = true;
            this.log.warn("[qq] 还没有可用的会话目标（等收到第一条群/私聊消息后自动补齐）");
          }
          continue;
        }

        const media = pending.media ?? [];
        // 先把图片转存到平台素材库（qqbot-media://），再拼单条 Markdown 图文。
        // 任何一张失败就整体退回富媒体，避免一半 Markdown 一半富媒体的拼凑。
        const uploaded: MediaImageRef[] = [];
        let markdown: string | undefined;
        if (media.length > 0 && this.settings.mediaMode === "markdown") {
          let ready = true;
          for (const url of media) {
            try {
              uploaded.push(await this.uploadMarkdownImage(url, pending.mediaMaxPx));
            } catch (error) {
              ready = false;
              this.log.warn(`[qq] 图片转存平台素材库失败，退回富媒体：${errorText(error)}`);
              break;
            }
          }
          if (ready && uploaded.length === media.length) {
            markdown = buildMediaMarkdown(text, uploaded);
          }
        }

        let failures = 0;
        for (const target of targets) {
          try {
            await this.sendToTarget(target, text, pending.media, markdown);
          } catch (error) {
            failures += 1;
            this.log.warn(`[qq] 发送到 ${target.kind}:${target.id} 失败：${errorText(error)}`);
          }
        }
        if (failures === targets.length) {
          throw new Error(`QQ 所有目标均发送失败（${pending.id}）`);
        }
        if (failures > 0) {
          this.log.warn(`[qq] 消息 ${pending.id} 有 ${failures}/${targets.length} 个目标失败`);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private async sendToTarget(
    target: OutboundTarget,
    text: string,
    media?: readonly string[],
    markdown?: string,
  ): Promise<void> {
    const key = targetKey(target.kind, target.id);
    // 图文优先走单条 Markdown：`[群] 昵称: 文字 ![图片](url)`，文字在前、图片在后。
    if (markdown !== undefined) {
      try {
        await this.sendChunk(target, markdown, { markdown: true });
        return;
      } catch (error) {
        this.log.warn(
          `[qq] ${key} Markdown 图文发送失败，退回文本 + 富媒体：${errorText(error)}`,
        );
      }
    }
    if (media !== undefined && media.length > 0) {
      const sent = await this.sendImages(target, text, media);
      if (sent > 0) {
        return;
      }
      // 图片全部上传失败：退回纯文本，保留 `[图片]` 占位，至少让文字送达。
      this.log.warn(`[qq] ${key} 图片全部转发失败，退回纯文本`);
    }
    const chunks = splitText(text, this.settings.maxLength);
    for (const chunk of chunks) {
      await this.sendChunk(target, chunk);
    }
  }

  /**
   * Markdown 图文发送失败时的兜底：把图片重新上传到目标会话，再以富媒体消息
   * （`msg_type=7`）发出。官方不提供跨会话复用 `file_info` 的接口，必须先
   * `/files` 上传目标会话自己的 `file_info`；因此这里逐张上传。返回成功发出的
   * 张数，0 表示全部失败。
   *
   * 顺序：QQ 客户端会把富媒体消息的 `content` 渲染在图片之后，所以把
   * `[私聊] 昵称: ...` 先作为普通文本发出，再逐张发图片，保证标签在前、图片在后。
   */
  private async sendImages(
    target: OutboundTarget,
    text: string,
    media: readonly string[],
  ): Promise<number> {
    const key = targetKey(target.kind, target.id);
    // 正文里不再保留 `[图片]` 占位（真实图片马上会跟一条）；若正文只有图片，
    // 保留 `[私聊] 昵称:` 这个前缀作为图片的标题行。
    const cleaned = text.replace(/\[图片\]\s*/g, "").trim();
    const caption = cleaned === "" ? "" : (splitText(cleaned, this.settings.maxLength)[0] ?? "");

    // 先全部上传：只要有任意一张成功，就先发标题再发图片；全部失败则退回纯文本。
    const uploaded: string[] = [];
    for (const url of media) {
      try {
        uploaded.push(await this.uploadMedia(target, url));
      } catch (error) {
        this.log.warn(`[qq] 图片上传到 ${key} 失败：${errorText(error)}`);
      }
    }
    if (uploaded.length === 0) {
      return 0;
    }

    if (caption !== "") {
      await this.sendChunk(target, caption);
    }
    for (const fileInfo of uploaded) {
      await this.sendChunk(target, "", { fileInfo });
    }
    this.log.debug?.(`[qq] 已转发 ${uploaded.length}/${media.length} 张图片到 ${key}`);
    return uploaded.length;
  }

  /** 上传图片素材，返回目标会话可用的 `file_info` */
  private async uploadMedia(target: OutboundTarget, url: string): Promise<string> {
    const path =
      target.kind === "group"
        ? `/v2/groups/${encodeURIComponent(target.id)}/files`
        : `/v2/users/${encodeURIComponent(target.id)}/files`;
    await this.pace();
    const result = await this.apiRequest("POST", path, {
      file_type: 1, // 1=图片；官方富媒体文件类型
      url,
      srv_send_msg: false, // 只上传，不直接发送
    });
    const fileInfo = stringOf(result["file_info"]);
    if (fileInfo === undefined) {
      throw new Error("上传接口未返回 file_info");
    }
    return fileInfo;
  }

  /**
   * 把入站图片转存到 QQ 平台素材库，返回可写进 Markdown 的 `qqbot-media://` 引用。
   *
   * 手机 QQ 不会渲染指向外部公网 URL 的 Markdown 图片（只显示 `[图片]` 占位），
   * 官方为此提供 `/v2/media-images/*`：先申请预签名 URL 直传，再 complete 换引用。
   * 平台会在发送消息时转存图片副本，所以手机和电脑都能正常显示。
   *
   * 图片引用是滑动 90 天有效期、单机器人上限 100 张。发送后**不能立即删除**：
   * 客户端加载图片仍依赖该引用，删早了会退回 `[图片]` 占位。正常靠 90 天
   * 滑动过期自动回收；只有配额满（40035007）时才主动淘汰最旧的图片。
   */
  private async uploadMarkdownImage(
    sourceUrl: string,
    maxPx: number = MEDIA_IMAGE_MAX_DISPLAY_PX,
  ): Promise<MediaImageRef> {
    const response = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(this.settings.apiTimeoutMs),
    });
    if (!response.ok) {
      throw new QqApiError(`下载源图片失败 [${response.status}]：${sourceUrl.slice(0, 120)}`, response.status);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new Error("源图片为空");
    }
    if (bytes.byteLength > MEDIA_IMAGE_MAX_BYTES) {
      throw new Error(`源图片超过 10MB（${bytes.byteLength} 字节）`);
    }
    const contentType = imageContentTypeOf(response.headers.get("content-type"), sourceUrl);
    const md5 = createHash("md5").update(bytes).digest("hex");
    const sha1 = createHash("sha1").update(bytes).digest("hex");

    await this.pace();
    const prepareBody = {
      file_name: `chat-bridge-${md5.slice(0, 12)}.${IMAGE_EXTENSIONS[contentType]}`,
      file_size: bytes.byteLength,
      content_type: contentType,
      md5,
      sha1,
    };
    let prepared: Record<string, unknown>;
    try {
      prepared = await this.apiRequest("POST", "/v2/media-images/prepare", prepareBody);
    } catch (error) {
      // 40035007：素材库满 100 张。清理最旧的一半后重试一次。
      if (error instanceof QqApiError && error.code === MEDIA_QUOTA_CODE) {
        const freed = await this.pruneMediaImages();
        this.log.warn(`[qq] 素材库已满，清理 ${freed} 张旧图后重试`);
        if (freed === 0) {
          throw error;
        }
        prepared = await this.apiRequest("POST", "/v2/media-images/prepare", prepareBody);
      } else {
        throw error;
      }
    }
    const uploadId = stringOf(prepared["upload_id"]);
    const presignedUrl = stringOf(prepared["presigned_url"]);
    if (uploadId === undefined || presignedUrl === undefined) {
      throw new Error("素材上传申请缺少 upload_id / presigned_url");
    }

    const put = await fetch(presignedUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: bytes,
      signal: AbortSignal.timeout(this.settings.apiTimeoutMs),
    });
    if (!put.ok) {
      throw new QqApiError(`素材直传失败 [${put.status}]`, put.status);
    }
    const etag = (put.headers.get("etag") ?? "").replace(/"/g, "").toLowerCase();
    const completeMd5 = /^[0-9a-f]{32}$/.test(etag) ? etag : md5;

    await this.pace();
    const completed = await this.apiRequest("POST", "/v2/media-images/complete", {
      upload_id: uploadId,
      md5: completeMd5,
    });
    const reference = stringOf(completed["url"]);
    if (reference === undefined) {
      throw new Error("素材上传完成但未返回 qqbot-media 引用");
    }
    const imageId = stringOf(completed["image_id"]);
    const { width, height } = imageSizeOf(bytes, contentType);
    return {
      url: reference,
      ...(imageId === undefined ? {} : { imageId }),
      ...clampImageSize(width, height, maxPx),
    };
  }

  /**
   * 素材库满额（100 张）时清理最旧的一半，给新图片腾位置。
   *
   * 图片引用是滑动 90 天有效期，正常不需要主动删；只有配额满时才做一次
   * 淘汰。清理失败不阻塞发送，本次仍会抛回原始错误、退回富媒体。
   */
  private async pruneMediaImages(): Promise<number> {
    const listed = await this.apiRequest("GET", "/v2/media-images");
    const images = Array.isArray(listed["images"]) ? listed["images"] : [];
    const items = images
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        id: stringOf(item["image_id"]),
        createdAt: intOf(item["created_at"], 0, 0, Number.MAX_SAFE_INTEGER),
      }))
      .filter((item): item is { id: string; createdAt: number } => item.id !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt);
    const drop = Math.max(1, Math.ceil(items.length / 2));
    let removed = 0;
    for (const item of items.slice(0, drop)) {
      try {
        await this.pace();
        await this.apiRequest("DELETE", `/v2/media-images/${encodeURIComponent(item.id)}/delete`);
        removed += 1;
      } catch (error) {
        this.log.warn(`[qq] 清理素材库旧图 ${item.id} 失败：${errorText(error)}`);
      }
    }
    return removed;
  }

  private async sendChunk(
    target: OutboundTarget,
    text: string,
    options: { fileInfo?: string; markdown?: boolean } = {},
  ): Promise<void> {
    const key = targetKey(target.kind, target.id);
    const path =
      target.kind === "group"
        ? `/v2/groups/${encodeURIComponent(target.id)}/messages`
        : `/v2/users/${encodeURIComponent(target.id)}/messages`;
    const { fileInfo } = options;
    const useMarkdown = options.markdown ?? this.settings.markdown;

    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      await this.pace();
      const passive = this.takePassive(key);
      const payload: Record<string, unknown> =
        fileInfo !== undefined
          ? {
              msg_type: 7,
              media: { file_info: fileInfo },
              ...(text === "" ? {} : { content: text }),
            }
          : useMarkdown
            ? { msg_type: 2, markdown: { content: text } }
            : { msg_type: 0, content: text };
      const body: Record<string, unknown> = {
        msg_seq: this.nextSeq(key),
        ...payload,
        ...(passive === undefined ? {} : { msg_id: passive.messageId }),
      };
      try {
        await this.apiRequest("POST", path, body);
        const summary =
          fileInfo !== undefined
            ? `[图片] ${text.slice(0, 60)}`
            : useMarkdown
              ? `[图文] ${text.slice(0, 60)}`
              : text.slice(0, 60);
        this.log.debug?.(
          `[qq] 已发送到 ${key}${passive === undefined ? "（主动消息）" : "（被动回复）"}：${summary}`,
        );
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

/** 平台素材库限制：单张图片不超过 10MB */
const MEDIA_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 素材库满额错误码 */
const MEDIA_QUOTA_CODE = 40035007;
/** Markdown 里展示的最长边（像素）；过大的图按比例缩小，避免被客户端拉伸 */
const MEDIA_IMAGE_MAX_DISPLAY_PX = 480;
/** 纯表情贴纸的最长边上限；表情图不能被放大成大图 */
const STICKER_MAX_DISPLAY_PX = 160;
const IMAGE_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;

type MarkdownImageType = keyof typeof IMAGE_EXTENSIONS;

/**
 * 从图片字节解析像素宽高。Markdown 图片不带 `#宽px #高px` 时 QQ 客户端
 * （手机和电脑）只显示 `[图片]` 占位，所以这里必须尽量拿到真实尺寸。
 */
function imageSizeOf(
  bytes: Uint8Array,
  contentType: MarkdownImageType,
): { width?: number; height?: number } {
  try {
    if (contentType === "image/png") {
      if (bytes.length >= 24) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { width: view.getUint32(16), height: view.getUint32(20) };
      }
      return {};
    }
    if (contentType === "image/gif") {
      if (bytes.length >= 10) {
        return {
          width: bytes[6]! | (bytes[7]! << 8),
          height: bytes[8]! | (bytes[9]! << 8),
        };
      }
      return {};
    }
    if (contentType === "image/jpeg") {
      return jpegSizeOf(bytes);
    }
  } catch {
    // 尺寸解析失败不影响发送，只是失去宽高提示
  }
  return {};
}

function jpegSizeOf(bytes: Uint8Array): { width?: number; height?: number } {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) {
      return {};
    }
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
      };
    }
    offset += 2 + length;
  }
  return {};
}

/** 等比缩放到展示上限，保留整数像素；拿不到尺寸就不写宽高 */
function clampImageSize(
  width: number | undefined,
  height: number | undefined,
  maxPx: number = MEDIA_IMAGE_MAX_DISPLAY_PX,
): { width?: number; height?: number } {
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return {};
  }
  const scale = Math.min(1, maxPx / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * 归一化图片 MIME。部分 CDN 会返回 `image/jpg` 或 `application/octet-stream`，
 * 平台只接受 png/jpeg/gif/webp，且扩展名必须与 Content-Type 一致。
 */
function imageContentTypeOf(value: string | null, url: string): MarkdownImageType {
  const mime = (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime === "image/jpg") {
    return "image/jpeg";
  }
  if (mime in IMAGE_EXTENSIONS) {
    return mime as MarkdownImageType;
  }
  const path = url.split("?")[0]?.toLowerCase() ?? "";
  if (path.endsWith(".png")) {
    return "image/png";
  }
  if (path.endsWith(".gif")) {
    return "image/gif";
  }
  if (path.endsWith(".webp")) {
    return "image/webp";
  }
  return "image/jpeg";
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