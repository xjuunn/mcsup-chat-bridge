import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { PluginError } from "mcsup-plugin";
import type { LogClient } from "mcsup-plugin";

import type { KvLike } from "../src/core/targets.js";
import type { NormalizedMessage } from "../src/core/types.js";
import {
  DEFAULT_INTENTS,
  DiscordPlatform,
  discordInboundImages,
  discordInboundText,
  parseDiscordSettings,
} from "../src/platforms/discord.js";
import type { PlatformInboundMessage } from "../src/platform-kit/types.js";

const AT = "2026-11-24T12:00:00.000Z";
const TOKEN = "discord-test-token";

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

/** 宿主 KV 的替身；测试用它模拟「上次运行记下的会话」 */
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

async function waitFor(check: () => boolean, label: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(`等待超时：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 假 Discord：REST + WebSocket Gateway
// ---------------------------------------------------------------------------

interface SentCall {
  readonly channelId: string;
  readonly body: Record<string, unknown>;
}

interface FakeDiscord {
  readonly apiBase: string;
  /** POST /channels/{id}/messages 请求，按到达顺序 */
  readonly sends: SentCall[];
  /** POST /users/@me/channels 的请求体 */
  readonly dmCreates: Array<Record<string, unknown>>;
  /** 插件发给 Gateway 的帧 */
  readonly frames: Array<Record<string, unknown>>;
  readonly sockets: WsSocket[];
  readonly log: LogClient;
  /** 设置后所有 REST 请求返回 401 */
  unauthorized: boolean;
  readonly meCalls: () => number;
  readonly gatewayCalls: () => number;
  /** 等 Identify 完成、READY 已处理 */
  ready(): Promise<void>;
  dispatch(type: string, data: Record<string, unknown>, seq?: number): void;
  closeGateway(code: number): void;
  failNextSend(status: number, payload?: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function startFakeDiscord(): Promise<FakeDiscord> {
  const sends: SentCall[] = [];
  const dmCreates: Array<Record<string, unknown>> = [];
  const frames: Array<Record<string, unknown>> = [];
  const sockets: WsSocket[] = [];
  const failures: Array<{ status: number; payload: Record<string, unknown> }> = [];
  const log = fakeLog();
  let meCount = 0;
  let gatewayCount = 0;
  let unauthorized = false;
  let sentSeq = 0;

  const send = (response: ServerResponse, status: number, payload: unknown): void => {
    if (response.writableEnded) {
      return;
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", resolve);
  });
  const wssPort = (wss.address() as { port: number }).port;

  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (rawFrame) => {
      const frame = JSON.parse(rawFrame.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame["op"] === 2) {
        socket.send(
          JSON.stringify({
            op: 0,
            s: 1,
            t: "READY",
            d: {
              session_id: "sess-1",
              user: { id: "900", username: "bridge_bot", bot: true },
            },
          }),
        );
      } else if (frame["op"] === 6) {
        socket.send(JSON.stringify({ op: 0, s: 2, t: "RESUMED", d: {} }));
      }
    });
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
  });

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const route = url.pathname.replace(/^\/api\/v10/, "");
      const raw = Buffer.concat(chunks);
      const body =
        raw.length > 0 ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {};

      // 401 用例需要在鉴权失败时也能看到「插件确实尝试过 /users/@me」
      if (request.method === "GET" && route === "/users/@me") {
        meCount += 1;
      }

      if (request.headers.authorization !== `Bot ${TOKEN}` || unauthorized) {
        send(response, 401, { message: "401: Unauthorized", code: 0 });
        return;
      }

      if (request.method === "GET" && route === "/users/@me") {
        send(response, 200, {
          id: "900",
          username: "bridge_bot",
          global_name: "Bridge",
          bot: true,
        });
        return;
      }

      if (request.method === "GET" && route === "/gateway/bot") {
        gatewayCount += 1;
        send(response, 200, {
          url: `ws://127.0.0.1:${wssPort}`,
          shards: 1,
          session_start_limit: {
            total: 1_000,
            remaining: 999,
            reset_after: 1_000,
            max_concurrency: 1,
          },
        });
        return;
      }

      if (request.method === "POST" && route === "/users/@me/channels") {
        dmCreates.push(body);
        send(response, 200, { id: `dm-${String(body["recipient_id"])}`, type: 1 });
        return;
      }

      const match = /^\/channels\/([^/]+)\/messages$/.exec(route);
      if (request.method === "POST" && match !== null) {
        sends.push({ channelId: match[1] ?? "", body });
        const forced = failures.shift();
        if (forced !== undefined) {
          send(response, forced.status, forced.payload);
          return;
        }
        sentSeq += 1;
        send(response, 200, {
          id: `out-${sentSeq}`,
          channel_id: match[1],
          content: body["content"],
        });
        return;
      }

      send(response, 404, { message: "404: Not Found", code: 0 });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    apiBase: `http://127.0.0.1:${port}/api/v10`,
    sends,
    dmCreates,
    frames,
    sockets,
    log,
    get unauthorized(): boolean {
      return unauthorized;
    },
    set unauthorized(value: boolean) {
      unauthorized = value;
    },
    meCalls: () => meCount,
    gatewayCalls: () => gatewayCount,
    async ready() {
      await waitFor(() => frames.some((frame) => frame["op"] === 2), "Identify 帧");
      // 等平台处理 READY
      await delay(50);
    },
    dispatch(type, data, seq = 3) {
      const socket = sockets[sockets.length - 1];
      if (socket === undefined) {
        throw new Error("Gateway 尚未连接");
      }
      socket.send(JSON.stringify({ op: 0, s: seq, t: type, d: data }));
    },
    closeGateway(code) {
      sockets[sockets.length - 1]?.close(code, "test-close");
    },
    failNextSend(status, payload = {}) {
      failures.push({
        status,
        payload: { message: "forced failure", code: 0, ...payload },
      });
    },
    async close() {
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

// ---------------------------------------------------------------------------
// 启动助手
// ---------------------------------------------------------------------------

interface RunningPlatform {
  readonly platform: DiscordPlatform;
  readonly inbound: PlatformInboundMessage[];
  readonly log: LogClient;
  stop(): Promise<void>;
}

const platformCleanup: Array<() => Promise<void>> = [];
const fakeCleanup: Array<() => Promise<void>> = [];

function startPlatform(
  fake: FakeDiscord,
  settings: Record<string, unknown> = {},
  inbound: PlatformInboundMessage[] = [],
  kv?: KvLike,
  extra: { readonly private?: boolean } = {},
): RunningPlatform {
  const log = fake.log;
  const platform = new DiscordPlatform({
    log,
    settings: {
      botToken: TOKEN,
      apiBase: fake.apiBase,
      sendIntervalMs: 0,
      apiTimeoutMs: 2_000,
      reconnectMinMs: 200,
      reconnectMaxMs: 1_000,
      ...settings,
    },
    ...(extra.private === undefined ? {} : { private: extra.private }),
    ...(kv === undefined ? {} : { kv }),
  });
  const abort = new AbortController();
  platform.start({ log, signal: abort.signal, inbound: (item) => inbound.push(item) });
  const stop = async (): Promise<void> => {
    abort.abort();
    await platform.stop("test");
  };
  platformCleanup.push(stop);
  return { platform, inbound, log, stop };
}

afterEach(async () => {
  for (const stop of platformCleanup.splice(0)) {
    await stop();
  }
  for (const close of fakeCleanup.splice(0)) {
    await close();
  }
});

async function startFake(): Promise<FakeDiscord> {
  const fake = await startFakeDiscord();
  fakeCleanup.push(() => fake.close());
  return fake;
}

function groupEvent(
  id: string,
  content: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    channel_id: "200",
    guild_id: "100",
    content,
    timestamp: AT,
    author: { id: "42", username: "alice", global_name: "Alice", bot: false },
    attachments: [],
    ...overrides,
  };
}

function privateEvent(
  id: string,
  content: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    channel_id: "dm-42",
    content,
    timestamp: AT,
    author: { id: "42", username: "alice", global_name: "Alice", bot: false },
    attachments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe("Discord 配置与归一化", () => {
  it("默认值、缺 token 与越界夹取", () => {
    const settings = parseDiscordSettings({ botToken: "t" });
    expect(settings.apiBase).toBe("https://discord.com/api/v10");
    expect(settings.guilds).toEqual([]);
    expect(settings.groups).toEqual([]);
    expect(settings.privateUsers).toEqual([]);
    expect(settings.inbound).toBe(true);
    expect(settings.allowPrivate).toBe(false);
    expect(settings.syncChannels).toBe(true);
    expect(settings.forwardMedia).toBe(true);
    expect(settings.maxLength).toBe(1_900);
    expect(settings.sendIntervalMs).toBe(1_000);
    expect(parseDiscordSettings({ botToken: "t", maxLength: 9_999 }).maxLength).toBe(2_000);

    expect(() => parseDiscordSettings({})).toThrow(PluginError);
    expect(() => parseDiscordSettings(undefined)).toThrow(PluginError);
    expect(() => parseDiscordSettings({ botToken: "t", apiBase: "ftp://x" })).toThrow(PluginError);
  });

  it("附件、贴纸与图片 URL 的归一化", () => {
    const event = {
      content: "看这个",
      attachments: [
        { content_type: "image/png", filename: "a.png", url: "https://cdn.example/a.png" },
        { content_type: "video/mp4", filename: "v.mp4", url: "https://cdn.example/v.mp4" },
        { content_type: "audio/ogg", filename: "a.ogg", url: "https://cdn.example/a.ogg" },
        { content_type: "application/pdf", filename: "d.pdf", url: "https://cdn.example/d.pdf" },
      ],
      sticker_items: [{ id: "s1", name: "wave" }],
    };
    expect(discordInboundText(event)).toBe("看这个 [图片] [视频] [音频] [文件: d.pdf] [表情]");
    expect(discordInboundImages(event)).toEqual(["https://cdn.example/a.png"]);
    expect(discordInboundImages({ content: "无附件" })).toEqual([]);
  });

  it("Identify 默认 intents 覆盖频道、私聊与消息正文", () => {
    expect(DEFAULT_INTENTS & (1 << 9)).toBe(1 << 9);
    expect(DEFAULT_INTENTS & (1 << 12)).toBe(1 << 12);
    expect(DEFAULT_INTENTS & (1 << 15)).toBe(1 << 15);
  });
});

describe("Discord 出站", () => {
  it("按配置频道发送，禁用 @everyone 解析", async () => {
    const fake = await startFake();
    const run = startPlatform(fake, { groups: ["200"] });
    await fake.ready();

    run.platform.deliver(message({ text: "@everyone hello" }));
    await waitFor(() => fake.sends.length === 1, "发送到频道");

    expect(fake.sends[0]?.channelId).toBe("200");
    expect(fake.sends[0]?.body["content"]).toBe("[Steve]:@everyone hello");
    expect(fake.sends[0]?.body["allowed_mentions"]).toEqual({ parse: [] });
    const identify = fake.frames.find((frame) => frame["op"] === 2);
    expect(identify?.["d"]).toMatchObject({ token: TOKEN, intents: DEFAULT_INTENTS });
  });

  it("超过 maxLength 时按码点分片", async () => {
    const fake = await startFake();
    const run = startPlatform(fake, { groups: ["200"], maxLength: 64 });
    await fake.ready();

    run.platform.deliver(message({ text: "字".repeat(150) }));
    await waitFor(() => fake.sends.length === 3, "三片文本");
    for (const sent of fake.sends) {
      expect(typeof sent.body["content"]).toBe("string");
      expect(Array.from(sent.body["content"] as string).length).toBeLessThanOrEqual(64);
    }
  });

  it("私聊配置是 user id，换成 DM channel 后缓存", async () => {
    const fake = await startFake();
    const run = startPlatform(fake, { privateUsers: ["42"] });
    await fake.ready();

    run.platform.deliver(message({ text: "第一条" }));
    await waitFor(() => fake.sends.length === 1, "第一条私聊");
    run.platform.deliver(message({ id: "m2", text: "第二条" }));
    await waitFor(() => fake.sends.length === 2, "第二条私聊");

    expect(fake.dmCreates).toEqual([{ recipient_id: "42" }]);
    expect(fake.sends.map((sent) => sent.channelId)).toEqual(["dm-42", "dm-42"]);
  });

  it("留空配置时使用学到的目标（群频道与 DM channel）", async () => {
    const fake = await startFake();
    const inbound: PlatformInboundMessage[] = [];
    const run = startPlatform(fake, {}, inbound, fakeKv(), { private: true });
    await fake.ready();

    fake.dispatch("MESSAGE_CREATE", groupEvent("in-1", "群里说话"), 5);
    fake.dispatch("MESSAGE_CREATE", privateEvent("in-2", "私聊说话"), 6);
    await waitFor(() => inbound.length === 2, "两条入站");

    run.platform.deliver(message({ text: "从游戏来" }));
    const sentChannels = (): Set<string> => new Set(fake.sends.map((sent) => sent.channelId));
    // 入站镜像也会占用 `sends`，所以要等两个目标都出现，而不是等条数
    await waitFor(
      () => sentChannels().has("200") && sentChannels().has("dm-42"),
      "发给学到的两个目标",
    );
    expect([...sentChannels()].sort()).toEqual(["200", "dm-42"]);
    // 学到的私聊已经是 DM channel id，不应再调 /users/@me/channels
    expect(fake.dmCreates).toHaveLength(0);
  });

  it("群/私聊镜像跳过来源会话，图片作为 embed 重发", async () => {
    const fake = await startFake();
    const inbound: PlatformInboundMessage[] = [];
    const run = startPlatform(fake, { groups: ["200"], privateUsers: ["42"] }, inbound);
    await fake.ready();

    fake.dispatch(
      "MESSAGE_CREATE",
      groupEvent("in-1", "看这个", {
        channel_id: "200",
        attachments: [
          {
            content_type: "image/png",
            filename: "a.png",
            url: "https://cdn.example/a.png",
          },
        ],
      }),
      5,
    );
    await waitFor(() => inbound.length === 1, "群消息入站");
    await waitFor(() => fake.sends.length === 1, "镜像到私聊");

    expect(inbound[0]?.text).toBe("看这个 [图片]");
    expect(fake.sends[0]?.channelId).toBe("dm-42");
    expect(fake.sends[0]?.body["content"]).toBe("[群] Alice: 看这个");
    expect(fake.sends[0]?.body["embeds"]).toEqual([
      { image: { url: "https://cdn.example/a.png" } },
    ]);
  });

  it("relay 只发本平台会话，不回流 ctx.inbound", async () => {
    const fake = await startFake();
    const inbound: PlatformInboundMessage[] = [];
    const run = startPlatform(fake, { groups: ["200"] }, inbound);
    await fake.ready();

    run.platform.relay({
      platform: "qq",
      source: "QQ",
      channel: { kind: "group", id: "200" },
      author: { id: "u1", name: "小A" },
      text: "来自 QQ",
      messageId: "q1",
    });
    await waitFor(() => fake.sends.length === 1, "relay 发送");

    expect(fake.sends[0]?.channelId).toBe("200");
    expect(fake.sends[0]?.body["content"]).toBe("[QQ 群] 小A: 来自 QQ");
    expect(inbound).toHaveLength(0);
  });

  it("429 读取 retry_after 后重试", async () => {
    const fake = await startFake();
    const run = startPlatform(fake, { groups: ["200"] });
    await fake.ready();

    fake.failNextSend(429, { retry_after: 0.05, global: false });
    run.platform.deliver(message({ text: "重试" }));
    await waitFor(() => fake.sends.length === 2, "429 后重试");

    expect(fake.sends[0]?.body["content"]).toBe("[Steve]:重试");
    expect(fake.sends[1]?.body["content"]).toBe("[Steve]:重试");
    expect(logText(run.log)).not.toContain(TOKEN);
  });
});

describe("Discord 入站", () => {
  it("频道消息注入游戏；inbound=false 时只同步不注入", async () => {
    const fake = await startFake();
    const inbound: PlatformInboundMessage[] = [];
    const run = startPlatform(fake, { inbound: false, server: "survival" }, inbound);
    await fake.ready();

    fake.dispatch("MESSAGE_CREATE", groupEvent("in-1", "来自 Discord"), 5);
    await waitFor(() => inbound.length === 1, "频道入站");

    expect(inbound[0]).toMatchObject({
      platform: "discord",
      channel: { kind: "group", id: "200" },
      author: { id: "42", name: "Alice" },
      text: "来自 Discord",
      label: "Discord",
      inject: false,
      messageId: "in-1",
      server: "survival",
    });
    expect(inbound[0]?.at).toBe(AT);
  });

  it("重复消息 id、机器人消息与白名单过滤", async () => {
    const fake = await startFake();
    const inbound: PlatformInboundMessage[] = [];
    const run = startPlatform(fake, { allowedUsers: ["42"] }, inbound);
    await fake.ready();

    fake.dispatch("MESSAGE_CREATE", groupEvent("in-1", "第一条"), 5);
    fake.dispatch("MESSAGE_CREATE", groupEvent("in-1", "重复"), 6);
    fake.dispatch(
      "MESSAGE_CREATE",
      groupEvent("in-2", "机器人", { author: { id: "77", username: "bot", bot: true } }),
      7,
    );
    fake.dispatch("MESSAGE_CREATE", groupEvent("in-3", "陌生人", { author: { id: "99", username: "eve" } }), 8);
    await waitFor(() => inbound.length === 1, "仅第一条通过");
    await delay(50);

    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.messageId).toBe("in-1");
    expect(logText(run.log)).toContain("allowedUsers");
  });

  it("guilds / groups 白名单与私聊开关", async () => {
    const fake = await startFake();
    const inbound: PlatformInboundMessage[] = [];
    const run = startPlatform(
      fake,
      { guilds: ["999"], groups: ["999"], privateUsers: ["42"] },
      inbound,
    );
    await fake.ready();

    fake.dispatch("MESSAGE_CREATE", groupEvent("in-1", "别的服务器"), 5);
    fake.dispatch("MESSAGE_CREATE", privateEvent("in-2", "私聊"), 6);
    await delay(100);

    expect(inbound).toHaveLength(0);
    const text = logText(run.log);
    expect(text).toContain("discord.guilds");
    expect(text).toContain("私聊未启用");
  });

  it("全局 privateSync 打开后接收私聊，并按作者 id 过滤", async () => {
    const fake = await startFake();
    const inbound: PlatformInboundMessage[] = [];
    const run = startPlatform(fake, { privateUsers: ["42"] }, inbound, undefined, {
      private: true,
    });
    await fake.ready();

    fake.dispatch("MESSAGE_CREATE", privateEvent("in-1", "允许"), 5);
    fake.dispatch("MESSAGE_CREATE", privateEvent("in-2", "不允许", { author: { id: "99", username: "eve" } }), 6);
    await waitFor(() => inbound.length === 1, "只允许白名单私聊");

    expect(inbound[0]).toMatchObject({
      channel: { kind: "private", id: "dm-42" },
      author: { id: "42", name: "Alice" },
    });
  });
});

describe("Discord Gateway 生命周期", () => {
  it("token 无效时 401 直接停止，不连接 Gateway", async () => {
    const fake = await startFake();
    fake.unauthorized = true;
    const run = startPlatform(fake, { groups: ["200"] });

    await waitFor(() => logText(run.log).includes("bot token 无效"), "401 致命日志");
    expect(fake.meCalls()).toBe(1);
    expect(fake.gatewayCalls()).toBe(0);
    expect(fake.frames).toHaveLength(0);
  });

  it("4014 视为致命，提示开启 Message Content Intent 且不重连", async () => {
    const fake = await startFake();
    const run = startPlatform(fake, { groups: ["200"] });
    await fake.ready();

    fake.closeGateway(4014);
    await waitFor(() => logText(run.log).includes("Message Content Intent"), "4014 提示");
    await delay(300);

    expect(fake.sockets).toHaveLength(1);
    expect(fake.frames.filter((frame) => frame["op"] === 2)).toHaveLength(1);
  });

  it("普通断线优先 Resume，带 session 与最新 seq", async () => {
    const fake = await startFake();
    const run = startPlatform(fake, { groups: ["200"] }, []);
    await fake.ready();

    fake.dispatch("TYPING_START", { channel_id: "200" }, 5);
    await delay(30);
    fake.closeGateway(4000);
    await waitFor(() => fake.sockets.length === 2, "重连");

    await waitFor(
      () => fake.frames.some((frame) => frame["op"] === 6),
      "Resume 帧",
    );
    const resume = fake.frames.find((frame) => frame["op"] === 6);
    expect(resume?.["d"]).toMatchObject({ token: TOKEN, session_id: "sess-1", seq: 5 });
    await waitFor(() => logText(run.log).includes("会话已恢复"), "RESUMED 日志");
  });

  it("4009 清 session 后重新 Identify，不发 Resume", async () => {
    const fake = await startFake();
    const run = startPlatform(fake, { groups: ["200"] });
    await fake.ready();
    const identifies = fake.frames.filter((frame) => frame["op"] === 2).length;

    fake.closeGateway(4009);
    await waitFor(() => fake.sockets.length === 2, "重连");
    await waitFor(
      () => fake.frames.filter((frame) => frame["op"] === 2).length === identifies + 1,
      "重新 Identify",
    );

    expect(fake.frames.some((frame) => frame["op"] === 6)).toBe(false);
    expect(logText(run.log)).toContain("重新 Identify");
  });
});