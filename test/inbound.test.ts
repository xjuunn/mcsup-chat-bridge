import { describe, expect, it, vi } from "vitest";
import type { LogClient } from "mcsup-plugin";

import { ChatBridge, type BridgeConfig } from "../src/core/bridge.js";
import { CATEGORIES } from "../src/core/types.js";
import { createRegistry } from "../src/platforms/index.js";
import type { ChatPlatform, GamePort, PlatformContext } from "../src/platforms/types.js";

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
    inboundMaxLength: 40,
    platformSettings: {},
    ...overrides,
  };
}

interface Harness {
  readonly bridge: ChatBridge;
  readonly sent: Array<{ readonly server: string; readonly text: string }>;
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
  const sent: Array<{ server: string; text: string }> = [];
  const game: GamePort = {
    async sendChat(server, text) {
      sent.push({ server, text });
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
    expect(test.sent[0]).toEqual({ server: "creative", text: "[QQ] Alice: 大家好" });
    expect(test.bridge.status().inbound).toMatchObject({
      received: 1,
      delivered: 1,
      failed: 0,
      duplicates: 0,
    });
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

  it("全局关闭入站时丢弃并计数", async () => {
    const test = await harness({ cfg: config({ inbound: false }) });
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