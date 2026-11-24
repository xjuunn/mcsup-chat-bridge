import { describe, expect, it, vi } from "vitest";
import type { LogClient } from "mcsup-plugin";

import { ChatBridge, type BridgeConfig } from "../src/core/bridge.js";
import { CATEGORIES } from "../src/core/types.js";
import { createRegistry } from "../src/platforms/index.js";
import type {
  ChatPlatform,
  GamePort,
  InjectMode,
  PlatformContext,
  PlatformRelayMessage,
} from "../src/platforms/types.js";

const AT = "2026-11-21T12:00:00.000Z";

function fakeLog(): LogClient {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    platforms: ["fake"],
    forwardCategories: [...CATEGORIES],
    consoleForward: true,
    storeSize: 10,
    queueCapacity: 4,
    inbound: true,
    crossPlatform: true,
    privateSync: false,
    inboundMaxLength: 40,
    injectMode: "tellraw",
    platformSettings: {},
    ...overrides,
  };
}

interface Harness {
  readonly bridge: ChatBridge;
  readonly sent: Array<{ readonly server: string; readonly text: string; readonly mode?: InjectMode }>;
  readonly ctx: () => PlatformContext;
}

async function harness(
  options: {
    readonly cfg?: BridgeConfig;
    readonly game?: GamePort | null;
  } = {},
): Promise<Harness> {
  let captured: PlatformContext | undefined;
  const platform: ChatPlatform = {
    id: "fake",
    title: "fake",
    start(ctx) {
      captured = ctx;
    },
    deliver() {},
    stop() {},
  };
  const registry = createRegistry([
    {
      id: "fake",
      title: "fake",
      create() {
        return platform;
      },
    },
  ]);
  const sent: Array<{ server: string; text: string; mode?: InjectMode }> = [];
  const game: GamePort = {
    async sendChat(server, text, mode) {
      sent.push({ server, text, mode });
    },
    async resolveServer(preferred) {
      return preferred ?? "survival";
    },
  };
  const bridge = new ChatBridge({
    log: fakeLog(),
    registry,
    config: options.cfg ?? config(),
    ...(options.game === null ? {} : { game: options.game ?? game }),
  });
  await bridge.start();
  return {
    bridge,
    sent,
    ctx() {
      if (captured === undefined) {
        throw new Error("平台未启动");
      }
      return captured;
    },
  };
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("等待条件超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("入站：平台 → 游戏", () => {
  it("格式化并注入游戏，使用 inboundServer 与平台标签", async () => {
    const test = await harness({ cfg: config({ inboundServer: "creative" }) });
    test.ctx().inbound({
      platform: "qq",
      channel: { kind: "group", id: "123" },
      author: { id: "42", name: "Alice" },
      text: "大家好",
      label: "QQ",
      messageId: "m1",
    });

    await until(() => test.sent.length === 1);
    expect(test.sent[0]).toEqual({ server: "creative", text: "[QQ] Alice: 大家好", mode: "tellraw" });
    expect(test.bridge.status().inbound).toMatchObject({
      received: 1,
      delivered: 1,
      failed: 0,
      duplicates: 0,
    });
    await test.bridge.stop("test");
  });

  it("injectMode 会透传给 GamePort（say 用于写入服务器日志）", async () => {
    const test = await harness({ cfg: config({ injectMode: "say" }) });
    test.ctx().inbound({
      platform: "qq",
      channel: { kind: "group", id: "123" },
      author: { id: "42", name: "Alice" },
      text: "写日志",
      label: "QQ",
      messageId: "say-1",
    });

    await until(() => test.sent.length === 1);
    expect(test.sent[0]).toMatchObject({ text: "[QQ] Alice: 写日志", mode: "say" });
    await test.bridge.stop("test");
  });

  it("重复的平台消息 id 只注入一次", async () => {
    const test = await harness();
    const message = {
      platform: "qq",
      channel: { kind: "group" as const, id: "123" },
      author: { id: "42", name: "Alice" },
      text: "重复",
      messageId: "same-id",
    };
    test.ctx().inbound(message);
    test.ctx().inbound(message);
    await until(() => test.sent.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(test.sent).toHaveLength(1);
    expect(test.bridge.status().inbound.duplicates).toBe(1);
    await test.bridge.stop("test");
  });

  it("超长文本被截断，空白被折叠", async () => {
    const test = await harness();
    test.ctx().inbound({
      platform: "qq",
      channel: { kind: "group", id: "123" },
      author: { id: "42", name: "Alice" },
      text: `  ${"x".repeat(100)}\n换行  `,
    });
    await until(() => test.sent.length === 1);
    const text = test.sent[0]?.text ?? "";
    expect(text.startsWith("[QQ] Alice: ")).toBe(true);
    expect(text).not.toContain("\n");
    expect(text.endsWith("…")).toBe(true);
    expect(text.length).toBeLessThanOrEqual("[QQ] Alice: ".length + 40);
    await test.bridge.stop("test");
  });

  it("入站与跨平台都关闭时丢弃并计数", async () => {
    const test = await harness({ cfg: config({ inbound: false, crossPlatform: false }) });
    test.ctx().inbound({
      platform: "qq",
      channel: { kind: "group", id: "123" },
      author: { id: "42", name: "Alice" },
      text: "不该出现",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(test.sent).toHaveLength(0);
    expect(test.bridge.status().inbound).toMatchObject({ received: 1, dropped: 1 });
    await test.bridge.stop("test");
  });

  it("未授予 console:write 时降级为计数失败，不假装成功", async () => {
    const test = await harness({ game: null });
    test.ctx().inbound({
      platform: "qq",
      channel: { kind: "group", id: "123" },
      author: { id: "42", name: "Alice" },
      text: "没有写入能力",
    });
    await until(() => test.bridge.status().inbound.failed === 1);
    expect(test.bridge.status().inbound.delivered).toBe(0);
    await test.bridge.stop("test");
  });

  it("注入文本回流时被回声抑制，不会再次入库或转发", async () => {
    const test = await harness();
    test.ctx().inbound({
      platform: "qq",
      channel: { kind: "group", id: "123" },
      author: { id: "42", name: "Alice" },
      text: "回流测试",
    });
    await until(() => test.sent.length === 1);
    const injected = test.sent[0]?.text ?? "";

    test.bridge.ingest(
      "chat:message",
      { server: "survival", from: "Server", text: injected, at: AT },
      { kind: "chat:message", server: "survival", at: AT },
    );
    const status = test.bridge.status();
    expect(status.suppressed).toBe(1);
    expect(status.accepted).toBe(0);
    expect(status.stored).toBe(0);
    await test.bridge.stop("test");
  });
});

interface RelayRecorder {
  readonly id: string;
  readonly ctx: PlatformContext;
  readonly relayed: PlatformRelayMessage[];
}

async function relayHarness(cfg: BridgeConfig): Promise<{
  readonly bridge: ChatBridge;
  readonly sent: Array<{ readonly server: string; readonly text: string; readonly mode?: InjectMode }>;
  readonly platforms: Readonly<Record<string, RelayRecorder>>;
}> {
  const contexts = new Map<string, PlatformContext>();
  const defs = [
    { id: "alpha", withRelay: true },
    { id: "beta", withRelay: true },
    // 日志平台收不到转发：它没有实现 `relay`
    { id: "gamma", withRelay: false },
  ];
  // 列表必须先建好：适配器会往里 push，harness 返回的是同一个数组
  const relayed = new Map<string, PlatformRelayMessage[]>(
    defs.map((def) => [def.id, []]),
  );
  const registry = createRegistry(
    defs.map((def) => ({
      id: def.id,
      title: def.id,
      create() {
        return {
          id: def.id,
          title: def.id,
          start(ctx: PlatformContext) {
            contexts.set(def.id, ctx);
          },
          deliver() {},
          ...(def.withRelay
            ? {
                relay(message: PlatformRelayMessage) {
                  relayed.get(def.id)?.push(message);
                },
              }
            : {}),
          stop() {},
        } satisfies ChatPlatform;
      },
    })),
  );
  const sent: Array<{ server: string; text: string; mode?: InjectMode }> = [];
  const bridge = new ChatBridge({
    log: fakeLog(),
    registry,
    config: cfg,
    game: {
      async sendChat(server, text, mode) {
        sent.push({ server, text, mode });
      },
      async resolveServer(preferred) {
        return preferred ?? "survival";
      },
    },
  });
  await bridge.start();
  const platforms: Record<string, RelayRecorder> = {};
  for (const def of defs) {
    if (!cfg.platforms.includes(def.id)) {
      continue;
    }
    const ctx = contexts.get(def.id);
    if (ctx === undefined) {
      throw new Error(`平台 ${def.id} 未启动`);
    }
    platforms[def.id] = { id: def.id, ctx, relayed: relayed.get(def.id) ?? [] };
  }
  return { bridge, sent, platforms };
}

describe("跨平台同步：平台 → 平台", () => {
  it("一个平台收到的消息转给其它平台，不回流来源", async () => {
    const test = await relayHarness(config({ platforms: ["alpha", "beta", "gamma"] }));
    const alpha = test.platforms["alpha"]!;
    const beta = test.platforms["beta"]!;
    // 没实现 `relay` 的平台只与游戏互通，收不到转发
    const gamma = test.platforms["gamma"]!;

    alpha.ctx.inbound({
      platform: "alpha",
      channel: { kind: "group", id: "g1" },
      author: { id: "42", name: "Alice" },
      text: "群里的话",
      label: "QQ",
      messageId: "m1",
    });

    await until(() => beta.relayed.length === 1);
    expect(beta.relayed[0]).toMatchObject({
      platform: "alpha",
      source: "QQ",
      channel: { kind: "group", id: "g1" },
      text: "群里的话",
      messageId: "m1",
    });
    // 来源平台不接收自己的消息，未实现 relay 的平台也不接收
    expect(alpha.relayed).toHaveLength(0);
    expect(gamma.relayed).toHaveLength(0);
    // 同一份消息仍照常注入游戏
    await until(() => test.sent.length === 1);
    expect(test.sent[0]?.text).toBe("[QQ] Alice: 群里的话");
    expect(test.bridge.status().inbound).toMatchObject({ received: 1, relayed: 1, delivered: 1 });
    await test.bridge.stop("test");
  });

  it("私聊来源同样可以被转发", async () => {
    const test = await relayHarness(config({ platforms: ["alpha", "beta"] }));
    test.platforms["beta"]!.ctx.inbound({
      platform: "beta",
      channel: { kind: "private", id: "900" },
      author: { id: "7", name: "Bob" },
      text: "私聊内容",
      label: "Telegram",
    });

    await until(() => test.platforms["alpha"]!.relayed.length === 1);
    expect(test.platforms["alpha"]!.relayed[0]).toMatchObject({
      platform: "beta",
      source: "Telegram",
      channel: { kind: "private", id: "900" },
      text: "私聊内容",
    });
    expect(test.platforms["beta"]!.relayed).toHaveLength(0);
    await test.bridge.stop("test");
  });

  it("crossPlatform=false 时平台之间不串，仍各自与游戏互通", async () => {
    const test = await relayHarness(
      config({ platforms: ["alpha", "beta"], crossPlatform: false }),
    );
    test.platforms["alpha"]!.ctx.inbound({
      platform: "alpha",
      channel: { kind: "group", id: "g1" },
      author: { id: "42", name: "Alice" },
      text: "只进游戏",
      label: "QQ",
    });

    await until(() => test.sent.length === 1);
    expect(test.sent[0]?.text).toBe("[QQ] Alice: 只进游戏");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(test.platforms["beta"]!.relayed).toHaveLength(0);
    expect(test.bridge.status().inbound).toMatchObject({ received: 1, relayed: 0 });
    await test.bridge.stop("test");
  });

  it("inbound=false 时平台之间仍同步", async () => {
    const test = await relayHarness(config({ platforms: ["alpha", "beta"], inbound: false }));
    test.platforms["alpha"]!.ctx.inbound({
      platform: "alpha",
      channel: { kind: "group", id: "g1" },
      author: { id: "42", name: "Alice" },
      text: "不进游戏",
      label: "QQ",
    });

    await until(() => test.platforms["beta"]!.relayed.length === 1);
    expect(test.sent).toHaveLength(0);
    await test.bridge.stop("test");
  });

  it("平台自己的 inbound=false 只停注入，跨平台同步照常", async () => {
    const test = await relayHarness(config({ platforms: ["alpha", "beta"] }));
    test.platforms["alpha"]!.ctx.inbound({
      platform: "alpha",
      channel: { kind: "group", id: "g1" },
      author: { id: "42", name: "Alice" },
      text: "只同步",
      label: "QQ",
      inject: false,
    });

    await until(() => test.platforms["beta"]!.relayed.length === 1);
    expect(test.sent).toHaveLength(0);
    expect(test.bridge.status().inbound).toMatchObject({ received: 1, relayed: 1, delivered: 0 });
    await test.bridge.stop("test");
  });

  it("没有可接收平台时不计 relayed，只告警一次", async () => {
    const test = await relayHarness(config({ platforms: ["alpha"] }));
    test.platforms["alpha"]!.ctx.inbound({
      platform: "alpha",
      channel: { kind: "group", id: "g1" },
      author: { id: "42", name: "Alice" },
      text: "只有自己",
      label: "QQ",
    });

    await until(() => test.sent.length === 1);
    expect(test.bridge.status().inbound.relayed).toBe(0);
    await test.bridge.stop("test");
  });
});
