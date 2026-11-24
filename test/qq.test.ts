import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { LogClient } from "mcsup-plugin";

import type { NormalizedMessage } from "../src/core/types.js";
import type { KvLike } from "../src/core/targets.js";
import {
  buildMediaMarkdown,
  formatOutbound,
  INTENT_BITS,
  parseQqSettings,
  QqPlatform,
  qqInboundImages,
  qqInboundText,
} from "../src/platforms/qq.js";
import type { PlatformInboundMessage } from "../src/platform-kit/types.js";

const AT = "2026-11-21T12:00:00.000Z";

function fakeLog(): LogClient {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
  /** `/files` 富媒体上传请求 */
  readonly files: Array<{ path: string; body: Record<string, unknown> }>;
  /** 素材库 prepare 请求 */
  readonly mediaPrepares: Array<Record<string, unknown>>;
  /** 素材库预签名直传（PUT） */
  readonly mediaUploads: Array<{ path: string; contentType: string; md5: string; bytes: number }>;
  /** 素材库删除请求路径 */
  readonly mediaDeletes: string[];
  /** 源图片下载次数 */
  readonly imageFetches: () => number;
  /** 让下 N 次发消息返回指定错误码 */
  failNextWith(status: number, code?: number): void;
  /** 让下 N 次富媒体上传返回 400 */
  failNextFile(status: number): void;
  /** 让下 N 次素材库 prepare 返回错误 */
  failNextPrepare(status: number, code?: number): void;
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
  const files: FakeQq["files"] = [];
  const mediaPrepares: FakeQq["mediaPrepares"] = [];
  const mediaUploads: FakeQq["mediaUploads"] = [];
  const mediaDeletes: string[] = [];
  const sockets: WsSocket[] = [];
  let tokenCount = 0;
  let imageFetches = 0;
  const forcedFailures: Array<{ status: number; code: number }> = [];
  const fileFailures: number[] = [];
  const prepareFailures: Array<{ status: number; code: number }> = [];
  // 1x1 PNG，够平台校验用；测试里只关心字节数和 MD5
  const TEST_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  // 只有 PNG 头（IHDR 960x480），用于验证宽高解析与等比缩放
  const WIDE_PNG = (() => {
    const buffer = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write("IHDR", 12, "ascii");
    buffer.writeUInt32BE(960, 16);
    buffer.writeUInt32BE(480, 20);
    buffer[24] = 8;
    buffer[25] = 2;
    return buffer;
  })();

  const http: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const raw = Buffer.concat(chunks);
      const contentType = request.headers["content-type"] ?? "";
      const isJson = contentType.includes("application/json");
      const body =
        isJson && raw.length > 0
          ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>)
          : ({} as Record<string, unknown>);
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(payload));
      };

      if (url.pathname.startsWith("/images/")) {
        imageFetches += 1;
        response.writeHead(200, { "content-type": "image/png" });
        response.end(url.pathname === "/images/wide.png" ? WIDE_PNG : TEST_PNG);
        return;
      }

      if (request.method === "PUT" && url.pathname.startsWith("/upload/")) {
        const md5 = createHash("md5").update(raw).digest("hex");
        mediaUploads.push({ path: url.pathname, contentType, md5, bytes: raw.length });
        send(200, {}, { etag: `"${md5}"` });
        return;
      }

      if (url.pathname === "/v2/media-images/prepare") {
        const forced = prepareFailures.shift();
        if (forced !== undefined) {
          send(forced.status, { code: forced.code, message: "prepare failed" });
          return;
        }
        mediaPrepares.push(body);
        const uploadId = `upload-${mediaPrepares.length}`;
        send(200, {
          upload_id: uploadId,
          presigned_url: `http://${request.headers.host ?? "127.0.0.1"}/upload/${uploadId}`,
          expires_in: 3_600,
        });
        return;
      }

      if (url.pathname === "/v2/media-images/complete") {
        const uploadId = typeof body["upload_id"] === "string" ? body["upload_id"] : "upload-1";
        send(200, {
          image_id: `img-${uploadId}`,
          url: `qqbot-media://image/v1/${uploadId}`,
          ttl: 7_776_000,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v2/media-images") {
        send(200, {
          images: [
            { image_id: "old-1", url: "qqbot-media://image/v1/old-1", created_at: 1, expires_at: 9 },
            { image_id: "old-2", url: "qqbot-media://image/v1/old-2", created_at: 2, expires_at: 9 },
          ],
          next_cursor: "",
          total: 2,
        });
        return;
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/v2/media-images/")) {
        mediaDeletes.push(url.pathname);
        send(200, {});
        return;
      }

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

      if (url.pathname.endsWith("/files")) {
        files.push({ path: url.pathname, body });
        const forced = fileFailures.shift();
        if (forced !== undefined) {
          send(forced, { code: 40034002, message: "upload failed" });
          return;
        }
        send(200, { file_uuid: `uuid-${files.length}`, file_info: `fi-${files.length}`, ttl: 3_600, id: `file-${files.length}` });
        return;
      }

      if (url.pathname.startsWith("/v2/groups/") || url.pathname.startsWith("/v2/users/")) {
        posts.push({ path: url.pathname, body, auth: request.headers.authorization });
        const forced = forcedFailures.shift();
        if (forced !== undefined) {
          send(forced.status, { code: forced.code, message: "forced failure" });
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
    files,
    mediaPrepares,
    mediaUploads,
    mediaDeletes,
    imageFetches: () => imageFetches,
    failNextWith(status, code = 11244) {
      forcedFailures.push({ status, code });
    },
    failNextFile(status) {
      fileFailures.push(status);
    },
    failNextPrepare(status, code = 40035006) {
      prepareFailures.push({ status, code });
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
  kv?: KvLike,
  extra: { readonly private?: boolean } = {},
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
    ...(extra.private === undefined ? {} : { private: extra.private }),
    ...(kv === undefined ? {} : { kv }),
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
    expect(settings.syncChannels).toBe(true);
    expect(settings.forwardMedia).toBe(true);
    expect(settings.mediaMode).toBe("markdown");
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

  it("QQ 表情标签转为 [表情]", () => {
    expect(
      qqInboundText({ content: '哈哈<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">好' }),
    ).toBe("哈哈[表情]好");
    expect(qqInboundText({ content: '<faceType=1,faceId="13",ext="x"/>' })).toBe("[表情]");
  });

  it("提取图片 URL 供群/私聊转发", () => {
    expect(
      qqInboundImages({
        attachments: [
          { content_type: "image/png", url: "https://cdn.test/a.png" },
          { content_type: "voice", url: "https://cdn.test/a.silk" },
          { content_type: "image/jpeg", url: "" },
        ],
      }),
    ).toEqual(["https://cdn.test/a.png"]);
  });

  it("Markdown 图文把文字放在图片前，并带上宽高提示", () => {
    expect(
      buildMediaMarkdown("[群] 小A: 看图 [图片]", [{ url: "u1", width: 208, height: 320 }]),
    ).toBe("[群] 小A: 看图 ![图片 #208px #320px](u1)");
    expect(buildMediaMarkdown("纯图 [图片]", [{ url: "u1" }, { url: "u2" }])).toBe(
      "纯图 ![图片](u1) ![图片](u2)",
    );
    expect(buildMediaMarkdown("没有占位", [{ url: "u1" }])).toBe("没有占位 ![图片](u1)");
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

  it("未配置 groups 时，出站自动发给收到过消息的群（默认全部）", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    const { platform } = startPlatform(fake, {}, inbound);
    await fake.ready();

    fake.dispatch("GROUP_MESSAGE_CREATE", {
      id: "msg-auto-1",
      group_openid: "gAuto",
      content: "先来一条",
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "入站消息");

    platform.deliver(message());
    await waitFor(() => fake.posts.length === 1, "自动目标出站");
    expect(fake.posts[0]?.path).toBe("/v2/groups/gAuto/messages");
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

  it("全局 privateSync 打开时，即使 allowPrivate=false 也接收私聊", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, {}, inbound, undefined, { private: true });
    await fake.ready();

    fake.dispatch("C2C_MESSAGE_CREATE", {
      id: "c2c-private-sync",
      content: "全局开关",
      author: { user_openid: "u9", username: "Bob" },
    });

    await waitFor(() => inbound.length === 1, "全局开关下的私聊入站");
    expect(inbound[0]).toMatchObject({
      channel: { kind: "private", id: "u9" },
      text: "全局开关",
    });
  });

  it("全局 privateSync 关闭且 allowPrivate=false 时仍拒绝私聊", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, {}, inbound, undefined, { private: false });
    await fake.ready();

    fake.dispatch("C2C_MESSAGE_CREATE", {
      id: "c2c-private-off",
      content: "不该出现",
      author: { user_openid: "u9", username: "Bob" },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(inbound).toHaveLength(0);
  });

  it("群消息镜像到私聊，且不回发来源群", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { groups: ["g1"], allowPrivate: true, privateUsers: ["u1"] }, inbound);
    await fake.ready();

    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "g-msg-1",
      group_openid: "g1",
      content: "群里的话",
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "群消息入站");
    await waitFor(() => fake.posts.length >= 1, "镜像到私聊");

    expect(fake.posts[0]?.path).toBe("/v2/users/u1/messages");
    expect(fake.posts[0]?.body["content"]).toBe("[群] 小A: 群里的话");
    // 来源群不能收到自己那条消息的副本
    expect(fake.posts.some((post) => post.path === "/v2/groups/g1/messages")).toBe(false);
  });

  it("群消息里的图片先转存素材库，再以单条 Markdown 图文私聊转发", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { groups: ["g1"], allowPrivate: true, privateUsers: ["u1"] }, inbound);
    await fake.ready();

    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "g-img-1",
      group_openid: "g1",
      content: "看图",
      attachments: [{ content_type: "image/png", url: `${fake.apiBase}/images/a.png` }],
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "群图片入站");
    expect(inbound[0]?.text).toBe("看图 [图片]");
    await waitFor(() => fake.posts.length >= 1, "转发图片");

    // 先下载源图 → prepare → PUT → complete，换 qqbot-media:// 引用
    expect(fake.imageFetches()).toBe(1);
    expect(fake.mediaPrepares).toHaveLength(1);
    expect(fake.mediaPrepares[0]).toMatchObject({ content_type: "image/png" });
    expect(fake.mediaUploads).toHaveLength(1);
    expect(fake.mediaUploads[0]?.contentType).toBe("image/png");
    // 单条 Markdown：文字在前、图片在后；不需要 /files 富媒体上传
    expect(fake.files).toHaveLength(0);
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0]?.path).toBe("/v2/users/u1/messages");
    expect(fake.posts[0]?.body).toMatchObject({
      msg_type: 2,
      markdown: {
        content: "[群] 小A: 看图 ![图片 #1px #1px](qqbot-media://image/v1/upload-1)",
      },
    });
    expect(fake.posts.some((post) => post.path === "/v2/groups/g1/messages")).toBe(false);
    // 图片引用要保留：删早了客户端会退回 [图片] 占位
    expect(fake.mediaDeletes).toHaveLength(0);
  });

  it("Markdown 图片带上按比例缩放后的宽高提示", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { groups: ["g1"], allowPrivate: true, privateUsers: ["u1"] }, inbound);
    await fake.ready();

    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "g-img-wide",
      group_openid: "g1",
      content: "看图",
      attachments: [{ content_type: "image/png", url: `${fake.apiBase}/images/wide.png` }],
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "群图片入站");
    await waitFor(() => fake.posts.length >= 1, "转发图片");

    // 960x480 等比缩到最长边 480：480x240
    expect(fake.posts[0]?.body).toMatchObject({
      msg_type: 2,
      markdown: {
        content: "[群] 小A: 看图 ![图片 #480px #240px](qqbot-media://image/v1/upload-1)",
      },
    });
  });

  it("纯表情消息把贴纸并进同一条 Markdown 消息，不再补 [表情] 占位", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { groups: ["g1"], allowPrivate: true, privateUsers: ["u1"] }, inbound);
    await fake.ready();

    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "g-face-1",
      group_openid: "g1",
      content: '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">',
      attachments: [{ content_type: "image/png", url: `${fake.apiBase}/images/face.png` }],
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "群表情入站");
    expect(inbound[0]?.text).toBe("[表情] [图片]");
    await waitFor(() => fake.posts.length >= 1, "转发表情");

    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0]?.body).toMatchObject({
      msg_type: 2,
      markdown: { content: "[群] 小A: ![图片 #1px #1px](qqbot-media://image/v1/upload-1)" },
    });
  });

  it("forwardMedia=false 时只发文字占位", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(
      fake,
      { groups: ["g1"], allowPrivate: true, privateUsers: ["u1"], forwardMedia: false },
      inbound,
    );
    await fake.ready();

    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "g-img-2",
      group_openid: "g1",
      content: "看图",
      attachments: [{ content_type: "image/png", url: "https://cdn.test/a.png" }],
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "群图片入站");
    await waitFor(() => fake.posts.length >= 1, "镜像到私聊");

    expect(fake.files).toHaveLength(0);
    expect(fake.posts[0]?.body["content"]).toBe("[群] 小A: 看图 [图片]");
  });

  it("Markdown 图文发送失败时退回文本 + 富媒体上传", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { groups: ["g1"], allowPrivate: true, privateUsers: ["u1"] }, inbound);
    await fake.ready();
    fake.failNextWith(400, 40034002);

    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "g-img-3",
      group_openid: "g1",
      content: "看图",
      attachments: [{ content_type: "image/png", url: `${fake.apiBase}/images/a.png` }],
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "群图片入站");
    await waitFor(() => fake.files.length === 1 && fake.posts.length >= 3, "退回富媒体");

    // 第一条是失败的 Markdown 尝试，之后是标题文本 + 富媒体图片
    expect(fake.posts[0]?.body["msg_type"]).toBe(2);
    expect(fake.posts[1]?.body).toMatchObject({ msg_type: 0, content: "[群] 小A: 看图" });
    expect(fake.posts[2]?.body).toMatchObject({ msg_type: 7, media: { file_info: "fi-1" } });
  });

  it("素材库 prepare 失败时直接退回富媒体", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { groups: ["g1"], allowPrivate: true, privateUsers: ["u1"] }, inbound);
    await fake.ready();
    fake.failNextPrepare(400);

    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "g-img-4",
      group_openid: "g1",
      content: "看图",
      attachments: [{ content_type: "image/png", url: `${fake.apiBase}/images/a.png` }],
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "群图片入站");
    await waitFor(() => fake.files.length === 1 && fake.posts.length >= 2, "退回富媒体");

    expect(fake.mediaPrepares).toHaveLength(0);
    expect(fake.posts).toHaveLength(2);
    expect(fake.posts[0]?.body).toMatchObject({ msg_type: 0, content: "[群] 小A: 看图" });
    expect(fake.posts[1]?.body).toMatchObject({ msg_type: 7, media: { file_info: "fi-1" } });
    expect(fake.mediaDeletes).toHaveLength(0);
  });

  it("素材库满额时清理旧图后重试", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { groups: ["g1"], allowPrivate: true, privateUsers: ["u1"] }, inbound);
    await fake.ready();
    fake.failNextPrepare(400, 40035007);

    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "g-img-6",
      group_openid: "g1",
      content: "看图",
      attachments: [{ content_type: "image/png", url: `${fake.apiBase}/images/a.png` }],
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "群图片入站");
    await waitFor(() => fake.posts.length >= 1, "转发图片");

    expect(fake.mediaDeletes).toEqual(["/v2/media-images/old-1/delete"]);
    expect(fake.mediaPrepares).toHaveLength(1);
    expect(fake.posts[0]?.body).toMatchObject({
      msg_type: 2,
      markdown: {
        content: "[群] 小A: 看图 ![图片 #1px #1px](qqbot-media://image/v1/upload-1)",
      },
    });
  });

  it("纯表情贴纸按 160px 上限缩放，避免被放大", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { groups: ["g1"], allowPrivate: true, privateUsers: ["u1"] }, inbound);
    await fake.ready();

    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "g-face-wide",
      group_openid: "g1",
      content: '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">',
      attachments: [{ content_type: "image/png", url: `${fake.apiBase}/images/wide.png` }],
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "群表情入站");
    await waitFor(() => fake.posts.length >= 1, "转发表情");

    // 960x480 贴纸按最长边 160 等比缩放：160x80
    expect(fake.posts[0]?.body).toMatchObject({
      msg_type: 2,
      markdown: {
        content: "[群] 小A: ![图片 #160px #80px](qqbot-media://image/v1/upload-1)",
      },
    });
  });

  it("mediaMode=rich 时跳素材库，直接发单条富媒体", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(
      fake,
      {
        groups: ["g1"],
        allowPrivate: true,
        privateUsers: ["u1"],
        mediaMode: "rich",
      },
      inbound,
    );
    await fake.ready();

    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "g-img-5",
      group_openid: "g1",
      content: "看图",
      attachments: [{ content_type: "image/png", url: `${fake.apiBase}/images/a.png` }],
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "群图片入站");
    await waitFor(() => fake.files.length === 1 && fake.posts.length >= 2, "转发富媒体");

    expect(fake.imageFetches()).toBe(0);
    expect(fake.mediaPrepares).toHaveLength(0);
    // 富媒体卡片会把 content 渲染在图片之后：先发标题文本，再发图片
    expect(fake.posts[0]?.body).toMatchObject({ msg_type: 0, content: "[群] 小A: 看图" });
    expect(fake.posts[1]?.body).toMatchObject({ msg_type: 7, media: { file_info: "fi-1" } });
  });

  it("私聊消息镜像到群，且不回发来源私聊", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { groups: ["g1"], allowPrivate: true, privateUsers: ["u1"] }, inbound);
    await fake.ready();

    fake.dispatch("C2C_MESSAGE_CREATE", {
      id: "c2c-1",
      content: "私聊的话",
      author: { user_openid: "u1", username: "小A" },
    });
    await waitFor(() => inbound.length === 1, "私聊入站");
    await waitFor(() => fake.posts.length >= 1, "镜像到群");

    expect(fake.posts[0]?.path).toBe("/v2/groups/g1/messages");
    expect(fake.posts[0]?.body["content"]).toBe("[私聊] 小A: 私聊的话");
    expect(fake.posts.some((post) => post.path === "/v2/users/u1/messages")).toBe(false);
  });

  it("重启后仍把私聊镜像到上次记下的群（出站目标持久化）", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    // 插件重启后 host KV 里仍有上次记下的群：不必等群里先说话
    const kv = fakeKv();
    await kv.set("qq:targets", JSON.stringify({ v: 1, groups: ["gSaved"], users: [] }));
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { allowPrivate: true }, inbound, kv);
    await fake.ready();

    fake.dispatch("C2C_MESSAGE_CREATE", {
      id: "c2c-saved",
      content: "重启后的私聊",
      author: { user_openid: "u9", username: "小B" },
    });
    await waitFor(() => inbound.length === 1, "私聊入站");
    await waitFor(() => fake.posts.length >= 1, "镜像到记下的群");

    expect(fake.posts[0]?.path).toBe("/v2/groups/gSaved/messages");
    expect(fake.posts[0]?.body["content"]).toBe("[私聊] 小B: 重启后的私聊");
  });

  it("首次收到群消息时把群记进 KV，供下次启动使用", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const kv = fakeKv();
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, {}, inbound, kv);
    await fake.ready();

    fake.dispatch("GROUP_MESSAGE_CREATE", {
      id: "g-learn-1",
      group_openid: "gLearned",
      content: "先说一句",
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "群消息入站");

    const deadline = Date.now() + 3_000;
    let saved = "";
    while (Date.now() < deadline) {
      const raw = await kv.get("qq:targets");
      saved = raw === null ? "" : Buffer.from(raw).toString("utf8");
      if (saved.includes("gLearned")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(JSON.parse(saved)).toMatchObject({ groups: ["gLearned"] });
  });

  it("没有群目标时告警一次「私聊镜像发不到群」", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const log = fakeLog();
    const platform = new QqPlatform({
      log,
      settings: {
        appId: "app-1",
        clientSecret: "secret-1",
        apiBase: fake.apiBase,
        tokenUrl: fake.tokenUrl,
        sendIntervalMs: 0,
        allowPrivate: true,
      },
    });
    const abort = new AbortController();
    const inbound: PlatformInboundMessage[] = [];
    platform.start({ log, signal: abort.signal, inbound: (item) => inbound.push(item) });
    cleanup.push(async () => {
      abort.abort();
      await platform.stop("test");
    });
    await fake.ready();

    fake.dispatch("C2C_MESSAGE_CREATE", {
      id: "c2c-blind",
      content: "还没人开过群聊",
      author: { user_openid: "u9", username: "小B" },
    });
    await waitFor(() => inbound.length === 1, "私聊入站");
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(fake.posts).toHaveLength(0);
    const warnings = (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
      (call) => String(call[0]),
    );
    expect(warnings.filter((text) => text.includes("私聊镜像暂时发不到群"))).toHaveLength(1);
  });

  it("syncChannels=false 时不镜像", async () => {    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(
      fake,
      { groups: ["g1"], allowPrivate: true, privateUsers: ["u1"], syncChannels: false },
      inbound,
    );
    await fake.ready();

    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "g-msg-2",
      group_openid: "g1",
      content: "不同步",
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "群消息入站");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.posts).toHaveLength(0);
  });

  it("只有单一会话时不镜像，避免自我回发", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const inbound: PlatformInboundMessage[] = [];
    startPlatform(fake, { groups: ["g1"] }, inbound);
    await fake.ready();

    fake.dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "g-msg-3",
      group_openid: "g1",
      content: "只有群",
      author: { member_openid: "u1", member_nickname: "小A" },
    });
    await waitFor(() => inbound.length === 1, "群消息入站");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.posts).toHaveLength(0);
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

  it("跨平台转发：发给本平台会话，前缀标注来源平台与群/私聊", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const { platform } = startPlatform(fake, { groups: ["g1"] });
    await fake.ready();

    platform.relay({
      platform: "telegram",
      source: "Telegram",
      channel: { kind: "group", id: "-1001200" },
      author: { id: "7", name: "Bob" },
      text: "来自 \n Telegram 的话",
      messageId: "42",
    });

    await waitFor(() => fake.posts.length === 1, "跨平台转发");
    // 转发只走自己的出站队列，不会回流成本平台的入站消息
    expect(fake.posts[0]?.path).toBe("/v2/groups/g1/messages");
    expect(fake.posts[0]?.body["content"]).toBe("[Telegram 群] Bob: 来自 Telegram 的话");
  });

  it("跨平台转发：私聊来源带「私聊」前缀", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const { platform } = startPlatform(fake, { groups: ["g1"] });
    await fake.ready();

    platform.relay({
      platform: "telegram",
      source: "Telegram",
      channel: { kind: "private", id: "900" },
      author: { id: "7", name: "Bob" },
      text: "hello",
    });

    await waitFor(() => fake.posts.length === 1, "私聊来源转发");
    expect(fake.posts[0]?.body["content"]).toBe("[Telegram 私聊] Bob: hello");
  });

  it("401 时刷新 token 后重试成功", async () => {
    const fake = await startFakeQq({ appId: "app-1", clientSecret: "secret-1" });
    cleanup.push(() => fake.close());
    const { platform } = startPlatform(fake, { groups: ["g1"] });
    await fake.ready();
    expect(fake.tokenCalls()).toBe(1);

    fake.failNextWith(401);
    platform.deliver(message());
    // `apiRequest` 碰到 401 会在内部刷新 token 后立刻重发，所以「恰好 1 条」这个
    // 中间态只存在一两毫秒，等它会和重试竞态；直接等终态（第 2 条已发出）再断言。
    await waitFor(() => fake.posts.length >= 2, "401 后重试发送");
    expect(fake.tokenCalls()).toBe(2);
    expect(fake.posts[0]?.auth).toBe("QQBot tok-1");
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