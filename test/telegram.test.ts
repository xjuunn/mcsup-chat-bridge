import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { LogClient } from "mcsup-plugin";

import type { KvLike } from "../src/core/targets.js";
import type { NormalizedMessage } from "../src/core/types.js";
import {
  escapeTelegramHtml,
  parseTelegramSettings,
  splitTelegramHtml,
  TelegramPlatform,
  telegramInboundMedia,
  telegramInboundText,
} from "../src/platforms/telegram.js";
import type { PlatformInboundMessage } from "../src/platforms/types.js";

const AT = "2026-11-23T12:00:00.000Z";
const TOKEN = "123456:TEST-TOKEN";
const UNIX = 1_790_000_000;

function fakeLog(): LogClient {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function logText(log: LogClient): string {
  return [log.debug, log.info, log.warn, log.error]
    .map((fn) => {
      const mock = fn as unknown as { mock?: { calls: unknown[][] } };
      return (mock.mock?.calls ?? []).map((args) => args.join(" ")).join("\n");
    })
    .join("\n");
}

/** 宿主 KV 的替身；测试用它模拟「上次运行记下的会话 / offset」 */
function fakeKv(): KvLike & { get(key: string): Promise<Uint8Array | null> } {
  const data = new Map<string, Uint8Array>();
  return {
    async get(key: string): Promise<Uint8Array | null> {
      return data.get(key) ?? null;
    },
    async set(key: string, value: string | Uint8Array): Promise<void> {
      data.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
    },
  };
}

function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: "m1",
    seq: 1,
    category: "chat",
    source: "chat",
    server: "survival",
    at: AT,
    from: "Steve",
    text: "hello",
    raw: "<Steve> hello",
    rule: "chat.message",
    ...overrides,
  };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(`等待超时：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// 假 Bot API：HTTP + 长轮询
// ---------------------------------------------------------------------------

interface SentCall {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

interface FakeTelegram {
  readonly apiBase: string;
  /** sendMessage / sendPhoto / sendVideo / ... 请求，按到达顺序 */
  readonly sends: SentCall[];
  /** getUpdates 请求里的 offset（按到达顺序） */
  readonly offsets: number[];
  readonly webhookDeletes: () => number;
  readonly meCalls: () => number;
  readonly log: LogClient;
  /** 设置后 getMe 返回 401 */
  unauthorized: boolean;
  /** 下一次 getUpdates 返回 409 */
  conflictOnce: boolean;
  push(update: Record<string, unknown>): void;
  failNext(method: string, status: number, payload?: Record<string, unknown>): void;
  close(): Promise<void>;
}

interface PendingPull {
  readonly offset: number;
  readonly finish: (updates: unknown[]) => void;
}

async function startFakeTelegram(): Promise<FakeTelegram> {
  const sends: SentCall[] = [];
  const offsets: number[] = [];
  const queue: Array<Record<string, unknown>> = [];
  const pending: PendingPull[] = [];
  const failures = new Map<string, Array<{ status: number; payload: Record<string, unknown> }>>();
  const log = fakeLog();
  let meCount = 0;
  let webhookDeletes = 0;
  let unauthorized = false;
  let conflictOnce = false;
  let sentSeq = 0;

  const send = (response: ServerResponse, status: number, payload: unknown): void => {
    if (response.writableEnded) {
      return;
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  const failureOf = (method: string): { status: number; payload: Record<string, unknown> } | undefined =>
    failures.get(method)?.shift();

  const take = (offset: number): unknown[] => {
    const ready: unknown[] = [];
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const update = queue[index];
      if (update !== undefined && Number(update["update_id"]) >= offset) {
        ready.unshift(update);
        queue.splice(index, 1);
      }
    }
    return ready;
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname);
      if (match === null || match[1] !== TOKEN) {
        send(response, 401, { ok: false, error_code: 401, description: "Unauthorized" });
        return;
      }
      const method = match[2] ?? "";
      const raw = Buffer.concat(chunks);
      const body =
        raw.length > 0 ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {};

      if (method === "getMe") {
        meCount += 1;
        if (unauthorized) {
          send(response, 401, { ok: false, error_code: 401, description: "Unauthorized" });
          return;
        }
        send(response, 200, {
          ok: true,
          result: { id: 900, is_bot: true, first_name: "Bridge", username: "bridge_bot" },
        });
        return;
      }

      if (method === "getUpdates") {
        const offset = typeof body["offset"] === "number" ? body["offset"] : 0;
        offsets.push(offset);
        if (conflictOnce) {
          conflictOnce = false;
          send(response, 409, {
            ok: false,
            error_code: 409,
            description: "Conflict: can't use getUpdates method while webhook is active",
          });
          return;
        }
        const ready = take(offset);
        if (ready.length > 0) {
          send(response, 200, { ok: true, result: ready });
          return;
        }
        const timer = setTimeout(() => {
          entry.finish([]);
        }, 150);
        timer.unref?.();
        const finish = (updates: unknown[]): void => {
          clearTimeout(timer);
          const index = pending.indexOf(entry);
          if (index >= 0) {
            pending.splice(index, 1);
          }
          send(response, 200, { ok: true, result: updates });
        };
        const entry: PendingPull = { offset, finish: (updates) => finish(updates) };
        pending.push(entry);
        return;
      }

      if (method === "deleteWebhook") {
        webhookDeletes += 1;
        send(response, 200, { ok: true, result: true });
        return;
      }

      if (method.startsWith("send")) {
        // 先记一次调用，再决定成功/失败：429 重试用例需要看到「发出了两次」。
        sends.push({ method, body });
        const forced = failureOf(method);
        if (forced !== undefined) {
          send(response, forced.status, forced.payload);
          return;
        }
        sentSeq += 1;
        send(response, 200, { ok: true, result: { message_id: sentSeq } });
        return;
      }

      send(response, 404, { ok: false, error_code: 404, description: "Not Found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    apiBase: `http://127.0.0.1:${port}`,
    sends,
    offsets,
    log,
    webhookDeletes: () => webhookDeletes,
    meCalls: () => meCount,
    get unauthorized(): boolean {
      return unauthorized;
    },
    set unauthorized(value: boolean) {
      unauthorized = value;
    },
    get conflictOnce(): boolean {
      return conflictOnce;
    },
    set conflictOnce(value: boolean) {
      conflictOnce = value;
    },
    push(update: Record<string, unknown>) {
      queue.push(update);
      const entry = pending.shift();
      entry?.finish(take(entry.offset));
    },
    failNext(method, status, payload = {}) {
      const list = failures.get(method) ?? [];
      list.push({
        status,
        payload: { ok: false, error_code: status, description: "forced failure", ...payload },
      });
      failures.set(method, list);
    },
    async close() {
      for (const entry of [...pending]) {
        entry.finish([]);
      }
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // 长轮询用的是 fetch（undici）的 keep-alive 连接：只调 `close()` 会一直等
      // 空闲连接自然超时，干净跑几百次里总有一次撞上 afterEach 的 10s 超时。
      server.closeAllConnections();
      await closed;
    },
  };
}

// ---------------------------------------------------------------------------
// 启动助手
// ---------------------------------------------------------------------------

interface RunningPlatform {
  readonly platform: TelegramPlatform;
  readonly inbound: PlatformInboundMessage[];
  readonly log: LogClient;
  stop(): Promise<void>;
}

const cleanup: Array<() => Promise<void>> = [];

function startPlatform(
  fake: FakeTelegram,
  settings: Record<string, unknown> = {},
  inbound: PlatformInboundMessage[] = [],
  kv?: KvLike,
): RunningPlatform {
  // 用假服务器持有的同一个 log 实例，测试才能断言适配器写了什么。
  const log = fake.log;
  const platform = new TelegramPlatform({
    log,
    settings: {
      botToken: TOKEN,
      apiBase: fake.apiBase,
      sendIntervalMs: 0,
      pollTimeoutSecs: 1,
      apiTimeoutMs: 2_000,
      ...settings,
    },
    ...(kv === undefined ? {} : { kv }),
  });
  const abort = new AbortController();
  platform.start({ log, signal: abort.signal, inbound: (item) => inbound.push(item) });
  const stop = async (): Promise<void> => {
    abort.abort();
    await platform.stop("test");
  };
  cleanup.push(stop);
  return { platform, inbound, log, stop };
}

afterEach(async () => {
  for (const stop of cleanup.splice(0)) {
    await stop();
  }
});

/** 私聊消息：chat.id 与 from.id 相同 */
function privateUpdate(
  updateId: number,
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: 100 + updateId,
      date: UNIX,
      chat: { id: 42, type: "private", first_name: "Alice", username: "alice" },
      from: { id: 42, is_bot: false, first_name: "Alice", username: "alice" },
      text,
      ...overrides,
    },
  };
}

/** 群消息：chat.id 为负数，from.id 与群无关 */
function groupUpdate(
  updateId: number,
  chatId: number,
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: 200 + updateId,
      date: UNIX,
      chat: { id: chatId, type: "supergroup", title: "MC 群", username: "mc_group" },
      from: { id: 7, is_bot: false, first_name: "Bob", last_name: "Lee", username: "bob" },
      text,
      ...overrides,
    },
  };
}

/** 机器人自身的入群 / 被踢事件；`status` 对应 new_chat_member.status */
function membershipUpdate(
  updateId: number,
  chatId: number,
  status: "member" | "administrator" | "left" | "kicked",
): Record<string, unknown> {
  return {
    update_id: updateId,
    my_chat_member: {
      chat: { id: chatId, type: "supergroup", title: "MC 群", username: "mc_group" },
      from: { id: 7, is_bot: false, first_name: "Bob" },
      date: UNIX,
      old_chat_member: { status: "left", user: { id: 999, is_bot: true } },
      new_chat_member: { status, user: { id: 999, is_bot: true } },
    },
  };
}

// ---------------------------------------------------------------------------
// 配置与纯函数
// ---------------------------------------------------------------------------

describe("Telegram 配置", () => {
  it("缺少 botToken 时以配置错误拒绝", () => {
    expect(() => parseTelegramSettings({})).toThrow(/botToken/);
    expect(() => parseTelegramSettings({ botToken: "   " })).toThrow(/botToken/);
  });

  it("默认值安全且与 QQ 对齐", () => {
    const settings = parseTelegramSettings({ botToken: "123:abc" });
    expect(settings.apiBase).toBe("https://api.telegram.org");
    expect(settings.inbound).toBe(true);
    expect(settings.allowPrivate).toBe(false);
    expect(settings.syncChannels).toBe(true);
    expect(settings.forwardMedia).toBe(true);
    expect(settings.label).toBe("Telegram");
    expect(settings.maxLength).toBe(3_500);
    expect(settings.linkPreview).toBe(false);
    expect(settings.pollTimeoutSecs).toBe(30);
    expect(settings.pollLimit).toBe(100);
    expect(settings.sendIntervalMs).toBe(1_000);
    expect(settings.groups).toEqual([]);
    expect(settings.privateUsers).toEqual([]);
  });

  it("apiBase 必须是 http(s)，并去掉尾斜杠", () => {
    expect(() => parseTelegramSettings({ botToken: "1:a", apiBase: "ftp://x" })).toThrow(/http/);
    expect(parseTelegramSettings({ botToken: "1:a", apiBase: "https://tg.test/" }).apiBase).toBe(
      "https://tg.test",
    );
  });

  it("列表与类别去重", () => {
    const settings = parseTelegramSettings({
      botToken: "1:a",
      groups: ["-100", "-100", " @mc_group "],
      allowedUsers: ["42", "42"],
      categories: ["chat", "nope", "chat"],
    });
    expect(settings.groups).toEqual(["-100", "@mc_group"]);
    expect(settings.allowedUsers).toEqual(["42"]);
    expect(settings.categories).toEqual(["chat"]);
  });
});

describe("Telegram 入站归一化", () => {
  it("正文取 text/caption，媒体转占位文本", () => {
    expect(telegramInboundText({ text: "你好" })).toBe("你好");
    expect(telegramInboundText({ caption: "看图", photo: [{ file_id: "p1" }] })).toBe(
      "看图 [图片]",
    );
    expect(
      telegramInboundText({ document: { file_id: "d1", file_name: "a.txt" } }),
    ).toBe("[文件: a.txt]");
    expect(telegramInboundText({ sticker: { file_id: "s1", emoji: "😀" } })).toBe("[表情 😀]");
    expect(telegramInboundText({ poll: { id: "p" } })).toBe("[投票]");
    expect(telegramInboundText({ voice: { file_id: "v1" } })).toBe("[语音]");
    expect(telegramInboundText({})).toBe("");
  });

  it("GIF 同时带 animation/document 时只记一次", () => {
    const text = telegramInboundText({
      animation: { file_id: "a1" },
      document: { file_id: "a1", file_name: "x.gif" },
    });
    expect(text).toBe("[动图]");
  });

  it("媒体提取取最大的 photo，并支持视频/动图/文件", () => {
    expect(
      telegramInboundMedia({
        photo: [{ file_id: "small" }, { file_id: "large" }],
      }),
    ).toEqual([{ kind: "photo", fileId: "large" }]);
    expect(telegramInboundMedia({ video: { file_id: "v1" } })).toEqual([
      { kind: "video", fileId: "v1" },
    ]);
    expect(telegramInboundMedia({ animation: { file_id: "a1" } })).toEqual([
      { kind: "animation", fileId: "a1" },
    ]);
    expect(telegramInboundMedia({ document: { file_id: "d1" } })).toEqual([
      { kind: "document", fileId: "d1" },
    ]);
    expect(telegramInboundMedia({ voice: { file_id: "x" } })).toEqual([]);
  });

  it("HTML 转义只处理 & < >", () => {
    expect(escapeTelegramHtml("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
    expect(escapeTelegramHtml("普通文本")).toBe("普通文本");
  });

  it("转义后按 UTF-16 码元分片，不切断代理对与 HTML 实体", () => {
    expect(splitTelegramHtml("abcdef", 4)).toEqual(["abcd", "ef"]);

    const text = "a😀b";
    const chunks = splitTelegramHtml(text, 2);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      // 不能留下半个代理对
      expect(chunk).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(chunk).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }

    // `&` 转义成 `&amp;` 后变长：按转义后的长度分片，且实体不被切开
    const escaped = splitTelegramHtml("&".repeat(4), 8);
    expect(escaped.every((chunk) => chunk.length <= 8)).toBe(true);
    expect(escaped.join("")).toBe("&amp;".repeat(4));
    for (const chunk of escaped) {
      expect(chunk).toMatch(/^(?:&amp;)+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// 适配器行为
// ---------------------------------------------------------------------------

describe("Telegram 适配器（假 Bot API）", () => {
  it("getMe 校验 token，私聊消息映射为 PlatformInboundMessage", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { allowPrivate: true }, inbound);

    fake.push(privateUpdate(1, "来自 Telegram"));
    await waitFor(() => inbound.length === 1, "入站消息");

    expect(fake.meCalls()).toBe(1);
    expect(inbound[0]).toMatchObject({
      platform: "telegram",
      channel: { kind: "private", id: "42" },
      author: { id: "42", name: "Alice" },
      text: "来自 Telegram",
      label: "Telegram",
      messageId: "42:101",
      at: new Date(UNIX * 1_000).toISOString(),
    });
    expect(logText(fake.log)).toContain("@bridge_bot");
  });

  it("allowPrivate=false 时丢弃私聊，但 offset 继续前进", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, {}, inbound);

    fake.push(privateUpdate(3, "陌生人"));
    await waitFor(() => fake.offsets.includes(4), "offset 前进");
    expect(inbound).toEqual([]);
    expect(logText(fake.log)).toContain("allowPrivate");
  });

  it("群白名单生效", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { groups: ["-100"] }, inbound);

    fake.push(groupUpdate(1, -200, "别的群"));
    await waitFor(() => fake.offsets.includes(2), "处理第一条");
    fake.push(groupUpdate(2, -100, "白名单群"));
    await waitFor(() => inbound.length === 1, "白名单群入站");

    expect(inbound[0]?.channel.id).toBe("-100");
    expect(logText(fake.log)).toContain("telegram.groups");
  });

  it("发言人白名单生效", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { allowedUsers: ["999"] }, inbound);

    fake.push(groupUpdate(1, -300, "陌生人的消息"));
    await waitFor(() => fake.offsets.includes(2), "处理第一条");

    expect(inbound).toEqual([]);
    expect(logText(fake.log)).toContain("allowedUsers");
  });

  it("白名单可写 @username，大小写不敏感", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { groups: ["@MC_GROUP"] }, inbound);

    fake.push(groupUpdate(1, -100, "大小写不同"));
    await waitFor(() => inbound.length === 1, "白名单群入站");
    expect(inbound[0]?.channel.name).toBe("MC 群");
  });

  it("群消息自动学习出站目标；出站转义 HTML 并分片", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    const kv = fakeKv();
    const { platform } = startPlatform(fake, { maxLength: 64 }, [], kv);

    fake.push(groupUpdate(1, -100, "hi"));
    await waitFor(() => fake.offsets.includes(2), "入站处理");

    platform.deliver(message({ text: "a<b>&c" }));
    await waitFor(() => fake.sends.length === 1, "发送");
    expect(fake.sends[0]).toMatchObject({
      method: "sendMessage",
      body: {
        chat_id: "-100",
        parse_mode: "HTML",
        text: "[Steve]:a&lt;b&gt;&amp;c",
        link_preview_options: { is_disabled: true },
      },
    });
    // 学习到的群目标写回宿主 KV
    const saved = await kv.get("telegram:targets");
    expect(saved === null ? "" : Buffer.from(saved).toString("utf8")).toContain("-100");

    // 长文本按 maxLength 分片，且每片独立转义
    fake.sends.length = 0;
    const long = "x".repeat(200);
    platform.deliver(message({ text: long }));
    await waitFor(() => fake.sends.length >= 4, "分片发送");
    const joined = fake.sends
      .map((call) => String(call.body["text"] ?? ""))
      .join("");
    expect(joined).toBe(`[Steve]:${long}`);
  });

  it("机器人入群事件直接学习出站目标，不必等群消息", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    const { platform } = startPlatform(fake, {}, inbound);

    fake.push(membershipUpdate(1, -100, "member"));
    await waitFor(() => fake.offsets.includes(2), "入群事件确认");
    expect(inbound).toEqual([]);

    platform.deliver(message({ text: "游戏消息" }));
    await waitFor(() => fake.sends.length === 1, "发到群");
    expect(fake.sends[0]?.body["chat_id"]).toBe("-100");
    expect(logText(fake.log)).toContain("已加入群");
  });

  it("机器人被移出群后忘记该出站目标", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    const { platform } = startPlatform(fake, {});

    fake.push(membershipUpdate(1, -100, "member"));
    await waitFor(() => fake.offsets.includes(2), "入群事件确认");
    fake.push(membershipUpdate(2, -100, "kicked"));
    await waitFor(() => fake.offsets.includes(3), "离开事件确认");

    platform.deliver(message());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.sends).toEqual([]);
    expect(logText(fake.log)).toContain("已移出出站目标");
  });

  it("群/私聊互相同步，并跳过来源会话", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    const { platform } = startPlatform(fake, { allowPrivate: true }, inbound);

    // 私聊先说话：学会私聊目标
    fake.push(privateUpdate(1, "先私聊"));
    await waitFor(() => inbound.length === 1, "私聊入站");
    fake.sends.length = 0;

    // 群消息 → 镜像到私聊
    fake.push(groupUpdate(2, -100, "群里的消息"));
    await waitFor(
      () => fake.sends.some((call) => call.body["chat_id"] === "42"),
      "群 → 私聊镜像",
    );
    const toPrivate = fake.sends.find((call) => call.body["chat_id"] === "42");
    expect(toPrivate?.body["text"]).toBe("[群] Bob Lee: 群里的消息");

    // 私聊消息 → 镜像到群
    fake.sends.length = 0;
    fake.push(privateUpdate(3, "私聊的消息"));
    await waitFor(
      () => fake.sends.some((call) => call.body["chat_id"] === "-100"),
      "私聊 → 群镜像",
    );
    const toGroup = fake.sends.find((call) => call.body["chat_id"] === "-100");
    expect(toGroup?.body["text"]).toBe("[私聊] Alice: 私聊的消息");

    platform.deliver(message({ text: "游戏消息" }));
  });

  it("媒体镜像复用 file_id，并把文字与媒体分开送达", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { allowPrivate: true }, inbound);

    fake.push(privateUpdate(1, "先学私聊"));
    await waitFor(() => inbound.length === 1, "私聊入站");
    fake.sends.length = 0;

    fake.push(
      groupUpdate(2, -100, "", {
        caption: "看图",
        photo: [{ file_id: "small" }, { file_id: "photo-large" }],
      }),
    );
    await waitFor(() => inbound.length === 2, "群入站");
    await waitFor(
      () => fake.sends.some((call) => call.method === "sendPhoto"),
      "媒体镜像",
    );

    const textCall = fake.sends.find((call) => call.method === "sendMessage");
    const photoCall = fake.sends.find((call) => call.method === "sendPhoto");
    expect(textCall?.body["chat_id"]).toBe("42");
    expect(textCall?.body["text"]).toBe("[群] Bob Lee: 看图");
    expect(photoCall?.body).toMatchObject({ chat_id: "42", photo: "photo-large" });
  });

  it("论坛群记住 message_thread_id，General 话题省略", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    const { platform } = startPlatform(fake, {});

    fake.push(groupUpdate(1, -100, "话题 7", { message_thread_id: 7 }));
    await waitFor(() => fake.offsets.includes(2), "入站处理");
    platform.deliver(message());
    await waitFor(() => fake.sends.length === 1, "话题出站");
    expect(fake.sends[0]?.body["message_thread_id"]).toBe(7);

    fake.sends.length = 0;
    fake.push(groupUpdate(2, -100, "General", { message_thread_id: 1 }));
    await waitFor(() => fake.offsets.includes(3), "General 入站");
    platform.deliver(message());
    await waitFor(() => fake.sends.length === 1, "General 出站");
    expect(fake.sends[0]?.body["message_thread_id"]).toBeUndefined();
  });

  it("429 按 retry_after 重试，同一条消息再发一次", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    const { platform } = startPlatform(fake, { groups: ["-100"] });

    fake.failNext("sendMessage", 429, {
      parameters: { retry_after: 0 },
    });
    platform.deliver(message());
    await waitFor(() => fake.sends.length === 2, "重试发送");
    expect(fake.sends.map((call) => call.body["text"])).toEqual([
      "[Steve]:hello",
      "[Steve]:hello",
    ]);
  });

  it("offset 持久化到宿主 KV，重启后从下一条继续", async () => {
    // 「重启」用一个新的假 Bot API 模拟：旧进程的连接必须彻底断掉，
    // 否则残留的长轮询会替新进程消费掉队列里的 update。
    const first = await startFakeTelegram();
    cleanup.push(() => first.close());
    const kv = fakeKv();
    const inbound: PlatformInboundMessage[] = [];
    const run = startPlatform(first, { allowPrivate: true }, inbound, kv);

    first.push(privateUpdate(10, "第一条"));
    await waitFor(() => inbound.length === 1, "第一条入站");
    const saved = await kv.get("telegram:offset");
    expect(saved === null ? "" : Buffer.from(saved).toString("utf8")).toBe("11");
    await run.stop();
    await first.close();

    const second = await startFakeTelegram();
    cleanup.push(() => second.close());
    // 每条更新都在各自会话的 from 里带上 message_id；这里模拟平台重发旧 update
    second.push(privateUpdate(10, "重复"));
    second.push(privateUpdate(11, "第二条"));
    const secondInbound: PlatformInboundMessage[] = [];
    startPlatform(second, { allowPrivate: true }, secondInbound, kv);
    await waitFor(() => secondInbound.length === 1, "第二条入站");
    expect(secondInbound[0]?.messageId).toBe("42:111");
    expect(second.offsets).toContain(11);
  });

  it("401 视为凭证错误：只校验一次并停止重连", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    fake.unauthorized = true;
    startPlatform(fake, {});

    await waitFor(() => logText(fake.log).includes("已停止重连"), "停止重连");
    expect(logText(fake.log)).toContain("401");
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fake.meCalls()).toBe(1);
    expect(fake.offsets).toEqual([]);
  });

  it("getUpdates 409 时自动 deleteWebhook 一次后继续", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    fake.conflictOnce = true;
    startPlatform(fake, {});

    await waitFor(() => fake.webhookDeletes() === 1, "deleteWebhook");
    await waitFor(() => fake.offsets.length >= 1, "重新轮询");
    expect(logText(fake.log)).toContain("deleteWebhook");
  });

  it("停止后不再发送新消息", async () => {
    const fake = await startFakeTelegram();
    cleanup.push(() => fake.close());
    const { platform, stop } = startPlatform(fake, { groups: ["-100"] });
    await stop();
    platform.deliver(message());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.sends).toEqual([]);
  });
});