import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { LogClient } from "mcsup-plugin";

import type { NormalizedMessage } from "../src/core/types.js";
import {
  formatOutbound,
  INTENT_BITS,
  parseQqSettings,
  QqPlatform,
  qqInboundText,
} from "../src/platforms/qq.js";
import type { PlatformInboundMessage } from "../src/platforms/types.js";

const AT = "2026-11-21T12:00:00.000Z";

function fakeLog(): LogClient {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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

/** 假 QQ 开放平台：REST（凭证 + OpenAPI）+ WebSocket Gateway */
interface FakeQq {
  readonly apiBase: string;
  readonly tokenUrl: string;
  readonly tokenCalls: () => number;
  readonly frames: Array<Record<string, unknown>>;
  readonly posts: Array<{ path: string; body: Record<string, unknown>; auth: string | undefined }>;
  /** 让下 N 次发消息返回 401 */
  failNextWith(status: number): void;
  ready(): Promise<void>;
  dispatch(type: string, data: Record<string, unknown>, s?: number): void;
  /** 以指定关闭码断开当前 Gateway 连接 */
  closeGateway(code: number): void;
  close(): Promise<void>;
}

interface FakeOptions {
  readonly appId: string;
  readonly clientSecret: string;
}

async function startFakeQq(options: FakeOptions): Promise<FakeQq> {
  const frames: FakeQq["frames"] = [];
  const posts: FakeQq["posts"] = [];
  const sockets: WsSocket[] = [];
  let tokenCount = 0;
  const forcedFailures: number[] = [];

  const http: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const send = (status: number, payload: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };

      if (url.pathname === "/token") {
        if (body["appId"] !== options.appId || body["clientSecret"] !== options.clientSecret) {
          send(401, { code: 11241, message: "invalid credentials" });
          return;
        }
        tokenCount += 1;
        send(200, { access_token: `tok-${tokenCount}`, expires_in: 7_200 });
        return;
      }

      if (url.pathname === "/gateway") {
        send(200, { url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}` });
        return;
      }

      if (url.pathname.startsWith("/v2/groups/") || url.pathname.startsWith("/v2/users/")) {
        posts.push({ path: url.pathname, body, auth: request.headers.authorization });
        const forced = forcedFailures.shift();
        if (forced !== undefined) {
          send(forced, { code: 11244, message: "token invalid" });
          return;
        }
        send(200, { id: `sent-${posts.length}`, timestamp: "2026-11-21T12:00:00Z" });
        return;
      }

      send(404, { code: 404, message: "not found" });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (rawFrame) => {
      const frame = JSON.parse(rawFrame.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame["op"] === 2) {
        socket.send(
          JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "sess-1" } }),
        );
      }
    });
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
  });

  return {
    apiBase: `http://127.0.0.1:${port}`,
    tokenUrl: `http://127.0.0.1:${port}/token`,
    tokenCalls: () => tokenCount,
    frames,
    posts,
    failNextWith(status) {
      forcedFailures.push(status);
    },
    async ready() {
      await waitFor(() => frames.some((frame) => frame["op"] === 2), "Identify 帧");
      // 等平台处理 READY
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
    dispatch(type, data, s = 2) {
      const socket = sockets[sockets.length - 1];
      if (socket === undefined) {
        throw new Error("Gateway 尚未连接");
      }
      socket.send(JSON.stringify({ op: 0, s, t: type, d: data }));
    },
    closeGateway(code) {
      sockets[sockets.length - 1]?.close(code, "test-close");
    },
    async close() {
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

interface RunningPlatform {
  readonly platform: QqPlatform;
  readonly inbound: PlatformInboundMessage[];
  stop(): Promise<void>;
}

const cleanup: Array<() => Promise<void>> = [];

function startPlatform(
  fake: FakeQq,
  settings: Record<string, unknown>,
  inbound: PlatformInboundMessage[] = [],
): RunningPlatform {
  const platform = new QqPlatform({
    log: fakeLog(),
    settings: {
      appId: "app-1",
      clientSecret: "secret-1",
      apiBase: fake.apiBase,
      tokenUrl: fake.tokenUrl,
      sendIntervalMs: 0,
      ...settings,
    },
  });
  const abort = new AbortController();
  platform.start({ log: fakeLog(), signal: abort.signal, inbound: (item) => inbound.push(item) });
  const stop = async (): Promise<void> => {
    abort.abort();
    await platform.stop("test");
  };
  cleanup.push(stop);
  return { platform, inbound, stop };
}

afterEach(async () => {
  for (const stop of cleanup.splice(0)) {
    await stop();
  }
});

describe("QQ 配置", () => {
  it("缺少 appId / clientSecret 时以配置错误拒绝", () => {
    expect(() => parseQqSettings({})).toThrow(/appId/);
    expect(() => parseQqSettings({ appId: "123" })).toThrow(/clientSecret/);
  });

  it("默认订阅群聊与单聊，并提供安全默认值", () => {
    const settings = parseQqSettings({ appId: "123", clientSecret: "s3cret" });
    expect(settings.intents).toBe(INTENT_BITS.group_and_c2c);
    expect(settings.apiBase).toBe("https://api.sgroup.qq.com");
    expect(settings.inbound).toBe(true);
    expect(settings.allowPrivate).toBe(false);
    expect(settings.markdown).toBe(false);
    expect(settings.passiveReply).toBe(true);
    expect(settings.label).toBe("QQ");
    expect(settings.maxLength).toBe(1_500);
  });

  it("沙箱开关切换 API 基址", () => {
    expect(parseQqSettings({ appId: "1", clientSecret: "s", sandbox: true }).apiBase).toBe(
      "https://sandbox.api.sgroup.qq.com",
    );
    expect(
      parseQqSettings({ appId: "1", clientSecret: "s", apiBase: "https://example.test/" }).apiBase,
    ).toBe("https://example.test");
  });

  it("未知 intents 与非 http 基址被拒绝", () => {
    expect(() => parseQqSettings({ appId: "1", clientSecret: "s", intents: ["nope"] })).toThrow(
      /intents/,
    );
    expect(() =>
      parseQqSettings({ appId: "1", clientSecret: "s", apiBase: "ws://127.0.0.1:1" }),
    ).toThrow(/http/);
  });

  it("intents 可组合", () => {
    const settings = parseQqSettings({
      appId: "1",
      clientSecret: "s",
      intents: ["group_and_c2c", "interaction"],
    });
    expect(settings.intents).toBe(INTENT_BITS.group_and_c2c | INTENT_BITS.interaction);
  });
});

describe("QQ 消息格式", () => {
  it("玩家聊天严格使用 [玩家名]:消息", () => {
    expect(formatOutbound(message())).toBe("[Steve]:hello");
    expect(formatOutbound(message({ text: "第一行\n第二行" }))).toBe("[Steve]:第一行 第二行");
  });

  it("非聊天类别用中文标签，避免歧义", () => {
    expect(
      formatOutbound(message({ category: "join", source: "event", from: "Alex", text: "加入了游戏" })),
    ).toBe("[加入] Alex: 加入了游戏");
    expect(
      formatOutbound(message({ category: "warning", source: "console", from: null, text: "Can't keep up" })),
    ).toBe("[警告] Can't keep up");
  });

  it("空文本不发送", () => {
    expect(formatOutbound(message({ text: "   " }))).toBe("");
  });

  it("全量群消息把 @ 换成昵称，并移除机器人自身的 @", () => {
    const text = qqInboundText({
      content: "<@member-1> 你好",
      mentions: [{ member_openid: "member-1", member_nickname: "小A" }],
    });
    expect(text).toBe("@小A 你好");

    expect(qqInboundText({ content: "<@bot> 在吗" })).toBe("在吗");
    expect(
      qqInboundText({
        content: "<@bot> 在吗",
        mentions: [{ member_openid: "bot", member_nickname: "BridgeBot", is_you: true }],
      }),
    ).toBe("在吗");
    expect(qqInboundText({ content: "<@all> 集合" })).toBe("@全体成员 集合");
  });

  it("附件转占位文本，语音优先使用 ASR", () => {
    expect(
      qqInboundText({
        content: "看图",
        attachments: [
          { content_type: "image/png" },
          { content_type: "voice", asr_refer_text: "你好呀" },
          { content_type: "file", filename: "a.txt" },
        ],
      }),
    ).toBe("看图 [图片] [语音] 你好呀 [文件: a.txt]");
  });

  it("引用消息取被引用正文", () => {
    expect(
      qqInboundText({
        content: "",
        message_type: 103,
        msg_elements: [{ content: "上一句" }],
      }),
    ).toBe("[引用] 上一句");
  });
});

describe("QQ 适配器（假官方 Gateway + REST）", () => {
  it("用 AppID/Secret 换 token，Identify 后按 [玩家]:消息 发进群", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const { platform } = startPlatform(fake, { groups: ["g1"] });

    await fake.ready();
    const identify = fake.frames.find((frame) => frame["op"] === 2);
    expect(identify).toBeDefined();
    const auth = identify?.["d"] as Record<string, unknown>;
    expect(auth["token"]).toBe("QQBot tok-1");
    expect(auth["intents"]).toBe(INTENT_BITS.group_and_c2c);
    expect(auth["shard"]).toEqual([0, 1]);

    platform.deliver(message());
    await waitFor(() => fake.posts.length === 1, "发送群消息");
    expect(fake.posts[0]?.path).toBe("/v2/groups/g1/messages");
    expect(fake.posts[0]?.auth).toBe("QQBot tok-1");
    expect(fake.posts[0]?.body).toMatchObject({ msg_type: 0, content: "[Steve]:hello" });
    expect(fake.posts[0]?.body["msg_id"]).toBeUndefined();
  });

  it("入站消息回流，并用 msg_id + 递增 msg_seq 被动回复", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    const { platform } = startPlatform(fake, { groups: ["g1"] }, inbound);
    await fake.ready();

    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "msg-in-1",
      group_openid: "g1",
      content: " 大家好 ",
      timestamp: "2026-11-21T12:00:00Z",
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "入站消息");
    expect(inbound[0]).toMatchObject({
      platform: "qq",
      channel: { kind: "group", id: "g1" },
      author: { id: "u1", name: "小A" },
      text: "大家好",
      messageId: "msg-in-1",
      label: "QQ",
    });

    platform.deliver(message());
    await waitFor(() => fake.posts.length === 1, "被动回复");
    const body = fake.posts[0]?.body;
    expect(body?.["msg_id"]).toBe("msg-in-1");
    expect(body?.["msg_seq"]).toBe(1);

    platform.deliver(message({ id: "m2", seq: 2 }));
    await waitFor(() => fake.posts.length === 2, "第二次被动回复");
    expect(fake.posts[1]?.body["msg_id"]).toBe("msg-in-1");
    expect(fake.posts[1]?.body["msg_seq"]).toBe(2);
  });

  it("白名单外、机器人自身、重复消息都被过滤", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { groups: ["g1"] }, inbound);
    await fake.ready();

    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "ok-1",
      group_openid: "g1",
      content: "hi",
      author: { member_openid: "u1", member_nickname: "Alice" },
    });
    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "ok-1",
      group_openid: "g1",
      content: "hi again",
      author: { member_openid: "u1", member_nickname: "Alice" },
    });
    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "other-group",
      group_openid: "g2",
      content: "别处",
      author: { member_openid: "u1", member_nickname: "Alice" },
    });
    fake.dispatch("GROUP_MESSAGE_CREATE", {
      id: "self",
      group_openid: "g1",
      content: "自己",
      author: { member_openid: "bot", bot: true },
    });

    await waitFor(() => inbound.length >= 1, "首条入站");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.text).toBe("hi");
  });

  it("私聊默认拒绝，allowPrivate 后接收", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { allowPrivate: true, privateUsers: ["u9"] }, inbound);
    await fake.ready();

    fake.dispatch("C2C_MESSAGE_CREATE", {
      id: "c2c-1",
      content: "悄悄话",
      author: { user_openid: "u9", username: "Bob" },
    });
    fake.dispatch("C2C_MESSAGE_CREATE", {
      id: "c2c-2",
      content: "陌生人",
      author: { user_openid: "u8", username: "Eve" },
    });
    await waitFor(() => inbound.length >= 1, "单聊入站");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      channel: { kind: "private", id: "u9" },
      author: { id: "u9", name: "Bob" },
      text: "悄悄话",
    });
  });

  it("markdown 开关使用 msg_type=2", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const { platform } = startPlatform(fake, { groups: ["g1"], markdown: true });
    await fake.ready();

    platform.deliver(message());
    await waitFor(() => fake.posts.length === 1, "Markdown 发送");
    expect(fake.posts[0]?.body).toMatchObject({
      msg_type: 2,
      markdown: { content: "[Steve]:hello" },
    });
  });

  it("401 时刷新 token 后重试成功", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const { platform } = startPlatform(fake, { groups: ["g1"] });
    await fake.ready();
    expect(fake.tokenCalls()).toBe(1);

    fake.failNextWith(401);
    platform.deliver(message());
    await waitFor(() => fake.posts.length === 1, "首次发送");
    await waitFor(() => fake.tokenCalls() === 2, "刷新 token");
    await waitFor(() => fake.posts.length === 2, "重试发送");
    expect(fake.posts[1]?.auth).toBe("QQBot tok-2");
    expect(fake.posts[1]?.body["content"]).toBe("[Steve]:hello");
  });

  it("出站按 maxLength 分片", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const { platform } = startPlatform(fake, { groups: ["g1"], maxLength: 64 });
    await fake.ready();

    platform.deliver(message({ text: "x".repeat(200) }));
    // "[Steve]:" + 200 = 208 字符 → 64 * 3 + 16 → 4 片
    await waitFor(() => fake.posts.length === 4, "分片发送");
    const joined = fake.posts.map((item) => String(item.body["content"])).join("");
    expect(joined).toBe(`[Steve]:${"x".repeat(200)}`);

    // emoji 按码点切分：不能把代理对拆到两片
    const before = fake.posts.length;
    platform.deliver(message({ id: "m-emoji", seq: 2, text: "😀".repeat(80) }));
    await waitFor(() => fake.posts.length === before + 2, "emoji 分片发送");
    const emojiChunks = fake.posts.slice(before).map((item) => String(item.body["content"]));
    expect(emojiChunks.join("")).toBe(`[Steve]:${"😀".repeat(80)}`);
    for (const chunk of emojiChunks) {
      // 孤立代理对经 UTF-8 编解码会变成 U+FFFD，据此判断切分是否安全
      expect(Buffer.from(chunk, "utf8").toString("utf8")).toBe(chunk);
    }
  });

  it("fatal 关闭码停止重连", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    startPlatform(fake, { groups: ["g1"] });
    await fake.ready();
    expect(fake.frames.filter((frame) => frame["op"] === 2)).toHaveLength(1);

    // 4013 = intents 无权限；平台应记录致命错误并停止重连
    fake.closeGateway(4013);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fake.frames.filter((frame) => frame["op"] === 2)).toHaveLength(1);
  });

  it("会话失效关闭码会重新 Identify", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    startPlatform(fake, { groups: ["g1"], reconnectMinMs: 200, reconnectMaxMs: 200 });
    await fake.ready();

    // 4006 = session 无效 → 清空 session 后重新 Identify（而非 Resume）
    fake.closeGateway(4006);
    await waitFor(
      () => fake.frames.filter((frame) => frame["op"] === 2).length >= 2,
      "重新 Identify",
    );
    expect(fake.frames.some((frame) => frame["op"] === 6)).toBe(false);
  });
});