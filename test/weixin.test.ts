import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { LogClient } from "mcsup-plugin";

import type { KvLike } from "../src/core/targets.js";
import type { NormalizedMessage } from "../src/core/types.js";
import {
  parseWeixinJson,
  parseWeixinMessage,
  parseWeixinSettings,
  weixinAlias,
  weixinInboundText,
  WeixinPlatform,
} from "../src/platforms/weixin.js";
import type { PlatformInboundMessage } from "../src/platform-kit/types.js";

const TOKEN = "wxbot_TEST-TOKEN";
const CURSOR_KEY = "weixin:sync";
const CONTEXT_KEY = "weixin:context";
const AT = "2026-11-23T12:00:00.000Z";

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

function fakeKv(seed?: Record<string, string>): KvLike & { has(key: string): boolean } {
  const data = new Map<string, Uint8Array>();
  for (const [key, value] of Object.entries(seed ?? {})) {
    data.set(key, new TextEncoder().encode(value));
  }
  return {
    async get(key: string): Promise<Uint8Array | null> {
      return data.get(key) ?? null;
    },
    async set(key: string, value: string | Uint8Array): Promise<void> {
      data.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
    },
    has(key: string): boolean {
      return data.has(key);
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
// 假 iLink API
// ---------------------------------------------------------------------------

interface SentCall {
  readonly endpoint: string;
  readonly body: Record<string, unknown>;
}

interface FakeWeixin {
  readonly apiBase: string;
  readonly sends: SentCall[];
  readonly pollBodies: Array<Record<string, unknown>>;
  readonly log: LogClient;
  readonly notifyCalls: () => string[];
  push(msg: Record<string, unknown>, cursor?: string): void;
  /** 下一次 getUpdates 返回指定 JSON（覆盖正常消息路径） */
  replyNextGetUpdates(payload: Record<string, unknown>): void;
  /** 下一次 sendMessage 返回指定 JSON（HTTP 200） */
  replyNextSend(payload: Record<string, unknown>): void;
  /** 下一次 sendMessage 返回指定 HTTP 状态 */
  replyNextSendStatus(status: number, payload?: Record<string, unknown>): void;
  close(): Promise<void>;
}

interface PendingPull {
  finish(payload?: Record<string, unknown>): void;
}

async function startFakeWeixin(): Promise<FakeWeixin> {
  const sends: SentCall[] = [];
  const pollBodies: Array<Record<string, unknown>> = [];
  const notifyCalls: string[] = [];
  const log = fakeLog();
  const queue: Array<{ msg: Record<string, unknown>; cursor: string }> = [];
  const pending: PendingPull[] = [];
  let overrides: Record<string, unknown> | undefined;
  const sendOverrides: Array<{ status: number; payload: Record<string, unknown> }> = [];
  let cursor = "";

  const send = (response: ServerResponse, status: number, payload: unknown): void => {
    if (response.writableEnded) {
      return;
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const endpoint = url.pathname.replace(/^\/ilink\/bot\//, "");
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        send(response, 401, { ret: -1, errmsg: "unauthorized" });
        return;
      }
      const raw = Buffer.concat(chunks);
      const body =
        raw.length > 0 ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {};

      if (request.method === "POST" && endpoint === "getupdates") {
        pollBodies.push(body);
        const forced = overrides;
        overrides = undefined;
        if (forced !== undefined) {
          send(response, 200, forced);
          return;
        }
        const ready: Array<Record<string, unknown>> = [];
        while (queue.length > 0) {
          const entry = queue.shift();
          if (entry !== undefined) {
            ready.push(entry.msg);
            cursor = entry.cursor;
          }
        }
        if (ready.length > 0) {
          send(response, 200, { ret: 0, msgs: ready, get_updates_buf: cursor });
          return;
        }
        const entry: PendingPull = {
          finish: (payload) => {
            const index = pending.indexOf(entry);
            if (index >= 0) {
              pending.splice(index, 1);
            }
            send(response, 200, payload ?? { ret: 0, msgs: [], get_updates_buf: cursor });
          },
        };
        pending.push(entry);
        const timer = setTimeout(() => {
          entry.finish();
        }, 100);
        timer.unref?.();
        return;
      }

      if (request.method === "POST" && endpoint === "sendmessage") {
        sends.push({ endpoint, body });
        const forced = sendOverrides.shift();
        if (forced !== undefined) {
          send(response, forced.status, forced.payload);
          return;
        }
        send(response, 200, { ret: 0 });
        return;
      }

      if (request.method === "POST" && endpoint.startsWith("msg/notify")) {
        notifyCalls.push(endpoint);
        send(response, 200, { ret: 0 });
        return;
      }

      send(response, 404, { ret: -1, errmsg: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    apiBase: `http://127.0.0.1:${port}`,
    sends,
    pollBodies,
    log,
    notifyCalls: () => [...notifyCalls],
    push(msg, nextCursor = `cursor-${Date.now()}`) {
      queue.push({ msg, cursor: nextCursor });
      pending.shift()?.finish();
    },
    replyNextGetUpdates(payload) {
      overrides = payload;
      const entry = pending.shift();
      if (entry === undefined) {
        return;
      }
      overrides = undefined;
      entry.finish(payload);
    },
    replyNextSend(payload) {
      sendOverrides.push({ status: 200, payload });
    },
    replyNextSendStatus(status, payload = {}) {
      sendOverrides.push({ status, payload });
    },
    async close() {
      for (const entry of [...pending]) {
        entry.finish();
      }
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
  readonly platform: WeixinPlatform;
  readonly inbound: PlatformInboundMessage[];
  readonly log: LogClient;
  stop(): Promise<void>;
}

const cleanup: Array<() => Promise<void>> = [];

function startPlatform(
  fake: FakeWeixin,
  settings: Record<string, unknown> = {},
  inbound: PlatformInboundMessage[] = [],
  extra: { kv?: KvLike; private?: boolean } = {},
): RunningPlatform {
  const log = fake.log;
  const platform = new WeixinPlatform({
    log,
    settings: {
      botToken: TOKEN,
      apiBase: fake.apiBase,
      sendIntervalMs: 0,
      apiTimeoutMs: 2_000,
      pollTimeoutMs: 1_000,
      ...settings,
    },
    ...(extra.kv === undefined ? {} : { kv: extra.kv }),
    ...(extra.private === undefined ? {} : { private: extra.private }),
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

/** 一条典型的微信单聊文本消息 */
function weixinMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 1_845_000_000_000_001,
    from_user_id: 42,
    to_user_id: 900,
    message_type: 1,
    create_time_ms: Date.parse(AT),
    context_token: "ctx-1",
    item_list: [{ type: 1, text_item: { text: "你好" } }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 配置与纯函数
// ---------------------------------------------------------------------------

describe("微信配置", () => {
  it("缺少 botToken 时以配置错误拒绝", () => {
    expect(() => parseWeixinSettings({})).toThrow(/botToken/);
    expect(() => parseWeixinSettings({ botToken: "  " })).toThrow(/botToken/);
  });

  it("默认值：单聊形态默认接收、标签为微信", () => {
    const settings = parseWeixinSettings({ botToken: TOKEN });
    expect(settings.apiBase).toBe("https://ilinkai.weixin.qq.com");
    expect(settings.privateUsers).toEqual([]);
    expect(settings.allowedUsers).toEqual([]);
    expect(settings.inbound).toBe(true);
    expect(settings.allowPrivate).toBe(true);
    expect(settings.label).toBe("微信");
    expect(settings.maxLength).toBe(1_500);
    expect(settings.sendIntervalMs).toBe(1_000);
    expect(settings.pollTimeoutMs).toBe(35_000);
  });

  it("apiBase 必须是 http(s)，并去掉尾斜杠", () => {
    expect(() => parseWeixinSettings({ botToken: TOKEN, apiBase: "ftp://x" })).toThrow(/http/);
    expect(parseWeixinSettings({ botToken: TOKEN, apiBase: "https://wx.test/" }).apiBase).toBe(
      "https://wx.test",
    );
  });
});

describe("微信消息归一化", () => {
  it("文本、语音转写、媒体占位与文件名", () => {
    expect(weixinInboundText([{ type: 1, text_item: { text: "hi" } }])).toBe("hi");
    expect(weixinInboundText([{ type: 3, voice_item: { text: "转写内容" } }])).toBe("转写内容");
    expect(weixinInboundText([{ type: 2 }])).toBe("[图片]");
    expect(weixinInboundText([{ type: 5 }])).toBe("[视频]");
    expect(weixinInboundText([{ type: 3 }])).toBe("[语音]");
    expect(weixinInboundText([{ type: 4, file_item: { file_name: "a.zip" } }])).toBe(
      "[文件: a.zip]",
    );
    expect(weixinInboundText([])).toBe("");
  });

  it("跳过机器人自己、已删除与没有正文的消息", () => {
    expect(parseWeixinMessage(weixinMessage({ message_type: 2 }))).toBeUndefined();
    expect(parseWeixinMessage(weixinMessage({ delete_time_ms: 1 }))).toBeUndefined();
    expect(parseWeixinMessage({ item_list: [{ type: 1, text_item: { text: "x" } }] })).toBeUndefined();
    expect(
      parseWeixinMessage(weixinMessage({ item_list: [{ type: 1, text_item: { text: "  " } }] })),
    ).toBeUndefined();
  });

  it("保留 uint64 消息 id 精度", () => {
    const raw = '{"ret":0,"msgs":[{"message_id":1845000000000000001,"svr_id":99,"msg_id":12345678901234567890}]}';
    const parsed = parseWeixinJson<{
      msgs: Array<Record<string, string>>;
    }>(raw);
    expect(parsed.msgs[0]?.["message_id"]).toBe("1845000000000000001");
    expect(parsed.msgs[0]?.["msg_id"]).toBe("12345678901234567890");
    expect(parsed.msgs[0]?.["svr_id"]).toBe("99");
  });

  it("字符串内容里出现同名字段不会被改写", () => {
    const raw = '{"text":"\\"message_id\\":123"}';
    expect(parseWeixinJson<{ text: string }>(raw).text).toBe('"message_id":123');
  });

  it("归一化出 id、时间与上下文令牌", () => {
    const parsed = parseWeixinMessage(weixinMessage());
    expect(parsed).toMatchObject({
      senderId: "42",
      text: "你好",
      messageId: "1845000000000001",
      contextToken: "ctx-1",
      at: AT,
    });
  });

  it("由 user id 派生稳定短别名作显示名", () => {
    const id = "o9cq807-h3vWKMzqjF9ysuPMTbhQ@im.wechat";
    const alias = weixinAlias(id);
    expect(alias).toBe("微信用户-81b249");
    expect(weixinAlias(id)).toBe(alias);
    expect(alias).toMatch(/^微信用户-[0-9a-f]{6}$/);
    expect(alias.length).toBeLessThan(20);
  });

  it("不同 user id 得到不同别名", () => {
    expect(weixinAlias("42")).toBe("微信用户-73475c");
    expect(weixinAlias("43")).not.toBe(weixinAlias("42"));
  });
});

// ---------------------------------------------------------------------------
// 收 / 发
// ---------------------------------------------------------------------------

describe("微信收发", () => {
  it("入站私聊注入内核，并记住出站目标", async () => {
    const fake = await startFakeWeixin();
    const kv = fakeKv();
    const inbound: PlatformInboundMessage[] = [];
    const running = startPlatform(fake, {}, inbound, { kv });

    fake.push(weixinMessage());
    await waitFor(() => inbound.length === 1, "入站消息");

    expect(inbound[0]).toMatchObject({
      platform: "weixin",
      channel: { kind: "private", id: "42" },
      author: { id: "42", name: "微信用户-73475c" },
      text: "你好",
      label: "微信",
      messageId: "1845000000000001",
    });
    expect(kv.has("weixin:targets")).toBe(true);
    expect(kv.has(CONTEXT_KEY)).toBe(true);

    running.platform.deliver(message());
    await waitFor(() => fake.sends.length === 1, "出站消息");
    const body = fake.sends[0]?.body as {
      msg: { to_user_id: string; context_token?: string; item_list: Array<{ text_item: { text: string } }> };
    };
    expect(body.msg.to_user_id).toBe("42");
    expect(body.msg.context_token).toBe("ctx-1");
    expect(body.msg.item_list[0]?.text_item.text).toBe("[Steve]:hello");

    await fake.close();
  });

  it("长文本按上限分片", async () => {
    const fake = await startFakeWeixin();
    const inbound: PlatformInboundMessage[] = [];
    const running = startPlatform(fake, { maxLength: 64 }, inbound);

    fake.push(weixinMessage());
    await waitFor(() => inbound.length === 1, "入站消息");

    running.platform.deliver(message({ text: "x".repeat(200) }));
    await waitFor(() => fake.sends.length === 4, "分片发送");
    for (const call of fake.sends) {
      const body = call.body as { msg: { item_list: Array<{ text_item: { text: string } }> } };
      expect(Array.from(body.msg.item_list[0]?.text_item.text ?? "").length).toBeLessThanOrEqual(64);
    }

    await fake.close();
  });

  it("ret=-2 时清掉 context_token 后重试", async () => {
    const fake = await startFakeWeixin();
    const kv = fakeKv();
    const inbound: PlatformInboundMessage[] = [];
    const running = startPlatform(fake, {}, inbound, { kv });

    fake.push(weixinMessage());
    await waitFor(() => inbound.length === 1, "入站消息");
    await waitFor(() => kv.has(CONTEXT_KEY), "上下文令牌落盘");

    fake.replyNextSend({ ret: -2, errmsg: "prepare failed" });
    running.platform.deliver(message());
    await waitFor(() => fake.sends.length === 2, "重试发送");

    const first = fake.sends[0]?.body as { msg: { context_token?: string } };
    const second = fake.sends[1]?.body as { msg: { context_token?: string } };
    expect(first.msg.context_token).toBe("ctx-1");
    expect(second.msg.context_token).toBeUndefined();

    await fake.close();
  });

  it("sendMessage 网络/5xx 错误会重试", async () => {
    const fake = await startFakeWeixin();
    const inbound: PlatformInboundMessage[] = [];
    const running = startPlatform(fake, {}, inbound);

    fake.push(weixinMessage());
    await waitFor(() => inbound.length === 1, "入站消息");

    fake.replyNextSendStatus(500, { ret: -1, errmsg: "server busy" });
    fake.replyNextSendStatus(500, { ret: -1, errmsg: "server busy" });
    running.platform.deliver(message());
    await waitFor(() => fake.sends.length === 3, "重试两次后成功");

    await fake.close();
  });

  it("relay 把其它平台消息发给学到的私聊目标", async () => {
    const fake = await startFakeWeixin();
    const inbound: PlatformInboundMessage[] = [];
    const running = startPlatform(fake, { label: "微信" }, inbound);

    fake.push(weixinMessage());
    await waitFor(() => inbound.length === 1, "入站消息");

    running.platform.relay?.({
      platform: "qq",
      source: "QQ",
      channel: { kind: "private", id: "42" },
      author: { id: "42", name: "Alice" },
      text: "来自 QQ",
      messageId: "q1",
      at: AT,
    });
    await waitFor(() => fake.sends.length === 1, "跨平台转发");
    const body = fake.sends[0]?.body as { msg: { item_list: Array<{ text_item: { text: string } }> } };
    expect(body.msg.item_list[0]?.text_item.text).toBe("[QQ 私聊] Alice: 来自 QQ");

    await fake.close();
  });
});

// ---------------------------------------------------------------------------
// 过滤、暂停与持久化
// ---------------------------------------------------------------------------

describe("微信过滤与生命周期", () => {
  it("allowedUsers 白名单之外的发言被丢弃", async () => {
    const fake = await startFakeWeixin();
    const inbound: PlatformInboundMessage[] = [];
    const running = startPlatform(fake, { allowedUsers: ["7"] }, inbound);

    fake.push(weixinMessage({ from_user_id: 42 }));
    await waitFor(() => logText(running.log).includes("allowedUsers"), "丢弃日志");
    expect(inbound).toHaveLength(0);

    await fake.close();
  });

  it("allowPrivate=false 时全局 private 仍可接收", async () => {
    const fake = await startFakeWeixin();
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { allowPrivate: false }, inbound, { private: true });

    fake.push(weixinMessage());
    await waitFor(() => inbound.length === 1, "全局私聊开关打开后入站");
    await fake.close();
  });

  it("allowPrivate=false 且未开全局时丢弃", async () => {
    const fake = await startFakeWeixin();
    const inbound: PlatformInboundMessage[] = [];
    const running = startPlatform(fake, { allowPrivate: false }, inbound);

    fake.push(weixinMessage());
    await waitFor(() => logText(running.log).includes("allowPrivate"), "丢弃日志");
    expect(inbound).toHaveLength(0);
    await fake.close();
  });

  it("inbound=false 仍向内核投递但标记不注入", async () => {
    const fake = await startFakeWeixin();
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { inbound: false }, inbound);

    fake.push(weixinMessage());
    await waitFor(() => inbound.length === 1, "入站消息");
    expect(inbound[0]?.inject).toBe(false);
    await fake.close();
  });

  it("ret=-14 暂停长轮询与出站", async () => {
    const fake = await startFakeWeixin();
    const kv = fakeKv();
    const inbound: PlatformInboundMessage[] = [];
    const running = startPlatform(fake, {}, inbound, { kv });

    const pollsBefore = fake.pollBodies.length;
    fake.replyNextGetUpdates({ ret: -14, errmsg: "token expired" });
    await waitFor(() => logText(running.log).includes("-14"), "暂停日志");

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.pollBodies.length).toBe(pollsBefore + 1);
    expect(logText(running.log)).toContain("暂停");

    running.platform.deliver(message());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.sends).toHaveLength(0);

    await fake.close();
  });

  it("恢复 get_updates_buf 游标并在更新后落盘", async () => {
    const fake = await startFakeWeixin();
    const kv = fakeKv({ [CURSOR_KEY]: "cursor-old" });
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, {}, inbound, { kv });

    await waitFor(() => fake.pollBodies.length >= 1, "长轮询");
    expect(fake.pollBodies[0]?.["get_updates_buf"]).toBe("cursor-old");

    fake.push(weixinMessage(), "cursor-new");
    await waitFor(() => inbound.length === 1, "入站消息");
    await waitFor(() => kv.has(CURSOR_KEY), "游标落盘");

    await fake.close();
  });

  it("启动/停止发送 notify 通知", async () => {
    const fake = await startFakeWeixin();
    const running = startPlatform(fake);
    await waitFor(() => fake.notifyCalls().length >= 1, "notifystart");
    await running.stop();
    expect(fake.notifyCalls()).toContain("msg/notifystart");
    expect(fake.notifyCalls()).toContain("msg/notifystop");
    await fake.close();
  });
});