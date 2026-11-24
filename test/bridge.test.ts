import { describe, expect, it, vi } from "vitest";
import type { EventMeta, LogClient } from "mcsup-plugin";

import { ChatBridge, type BridgeConfig } from "../src/core/bridge.js";
import { CATEGORIES, type NormalizedMessage } from "../src/core/types.js";
import { createRegistry } from "../src/platforms/index.js";
import type { PlatformRegistry } from "../src/platforms/registry.js";
import type { ChatPlatform, PlatformFactory } from "../src/platforms/types.js";

const AT = "2026-11-21T12:00:00.000Z";

function fakeLog(): LogClient {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function meta(kind: string): EventMeta {
  return { kind, server: "survival", at: AT };
}

const BASE: BridgeConfig = {
  platforms: ["null"],
  forwardCategories: [...CATEGORIES],
  consoleForward: true,
  storeSize: 10,
  queueCapacity: 8,
  inbound: true,
  crossPlatform: true,
  inboundMaxLength: 200,
  injectMode: "tellraw",
  platformSettings: {},
};

function newBridge(config: BridgeConfig = BASE, registry: PlatformRegistry = createRegistry()): ChatBridge {
  return new ChatBridge({ log: fakeLog(), registry, config });
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

async function untilDelivered(bridge: ChatBridge, expected: number, timeoutMs = 2_000): Promise<void> {
  await until(() => (bridge.status().platforms[0]?.delivered ?? 0) >= expected, timeoutMs);
}

class Probe implements ChatPlatform {
  public readonly title: string;
  public readonly received: NormalizedMessage[] = [];
  public started = 0;
  public stopped = 0;

  public constructor(public readonly id: string) {
    this.title = id;
  }

  public start(): void {
    this.started += 1;
  }

  public deliver(message: NormalizedMessage): void {
    this.received.push(message);
  }

  public stop(): void {
    this.stopped += 1;
  }
}

function probeFactory(id: string, instances: Probe[]): PlatformFactory {
  return {
    id,
    title: id,
    create() {
      const probe = new Probe(id);
      instances.push(probe);
      return probe;
    },
  };
}

describe("ChatBridge", () => {
  it("采集、去重、入库", async () => {
    const bridge = newBridge();
    await bridge.start();

    bridge.ingest(
      "chat:message",
      { server: "survival", from: "Steve", text: "\u00a7a你好", at: AT },
      meta("chat:message"),
    );
    // 同一行的控制台投影不再丢弃，而是作为跨源重复被去重
    bridge.ingest(
      "console:line",
      { server: "survival", line: `[12:00:00] [Server thread/INFO]: <Steve> \u00a7a你好`, at: AT },
      meta("console:line"),
    );
    bridge.ingest("player:joined", { player: "Alex" }, meta("player:joined"));
    await untilDelivered(bridge, 2);

    const status = bridge.status();
    expect(status.started).toBe(true);
    expect(status.accepted).toBe(2);
    expect(status.skipped).toBe(0);
    expect(status.duplicates).toBe(1);
    expect(status.stored).toBe(2);
    expect(status.categories.chat).toBe(1);
    expect(status.categories.join).toBe(1);
    expect(status.platforms[0]).toMatchObject({ id: "null", delivered: 2, failed: 0 });

    const page = bridge.recent({ limit: 10 });
    expect(page.items.map((message) => message.category)).toEqual(["join", "chat"]);
    expect(page.items[1]?.text).toBe("你好");

    await bridge.stop("test");
  });

  it("离线模式：只有控制台聊天行时也正常入库并转发", async () => {
    const bridge = newBridge();
    await bridge.start();

    bridge.ingest(
      "console:line",
      {
        server: "survival",
        line: "[20:15:04] [Server thread/INFO]: [Not Secure] <Junhsiun> test",
        at: AT,
      },
      meta("console:line"),
    );
    await untilDelivered(bridge, 1);

    const status = bridge.status();
    expect(status.accepted).toBe(1);
    expect(status.duplicates).toBe(0);
    expect(status.skipped).toBe(0);
    expect(status.categories.chat).toBe(1);

    const page = bridge.recent({ limit: 5 });
    expect(page.items[0]).toMatchObject({
      category: "chat",
      source: "chat",
      from: "Junhsiun",
      text: "test",
    });
    await bridge.stop("test");
  });

  it("控制台投影先到、结构化聊天后到，也只保留一条", async () => {
    const bridge = newBridge();
    await bridge.start();

    bridge.ingest(
      "console:line",
      { server: "survival", line: "[12:00:00] [Server thread/INFO]: <Steve> 你好", at: AT },
      meta("console:line"),
    );
    bridge.ingest(
      "chat:message",
      { server: "survival", from: "Steve", text: "你好", at: AT },
      meta("chat:message"),
    );
    await untilDelivered(bridge, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const status = bridge.status();
    expect(status.accepted).toBe(1);
    expect(status.duplicates).toBe(1);
    expect(status.stored).toBe(1);
    expect(status.platforms[0]?.delivered).toBe(1);
    await bridge.stop("test");
  });

  it("玩家连发两条相同消息不会被跨源去重误伤", async () => {
    const bridge = newBridge();
    await bridge.start();

    for (let i = 0; i < 2; i += 1) {
      bridge.ingest(
        "chat:message",
        { server: "survival", from: "Steve", text: "test", at: `2026-11-21T12:00:0${i}.000Z` },
        meta("chat:message"),
      );
    }
    await untilDelivered(bridge, 2);
    expect(bridge.status().accepted).toBe(2);
    expect(bridge.status().duplicates).toBe(0);
    await bridge.stop("test");
  });

  it("启动前的事件只计入跳过", () => {
    const bridge = newBridge();
    bridge.ingest("chat:message", { server: "survival", from: "Steve", text: "x", at: AT }, meta("chat:message"));
    expect(bridge.status().skipped).toBe(1);
    expect(bridge.status().stored).toBe(0);
  });

  it("未知平台导致配置应用失败，旧平台继续工作", async () => {
    const bridge = newBridge();
    await bridge.start();

    await expect(
      bridge.applyConfig({ ...BASE, platforms: ["nope"], platformSettings: {} }),
    ).rejects.toThrow(/unknown chat platform/);
    expect(bridge.currentConfig.platforms).toEqual(["null"]);
    expect(bridge.status().platforms[0]?.id).toBe("null");

    bridge.ingest(
      "console:line",
      { server: "survival", line: "[12:00:00] [Server thread/WARN]: still alive", at: AT },
      meta("console:line"),
    );
    expect(bridge.status().accepted).toBe(1);
    await bridge.stop("test");
  });

  it("按类别过滤只影响转发，不影响入库", async () => {
    const bridge = newBridge();
    await bridge.start();
    await bridge.applyConfig({ ...BASE, forwardCategories: ["chat"] });

    bridge.ingest(
      "console:line",
      { server: "survival", line: "[12:00:00] [Server thread/WARN]: filtered", at: AT },
      meta("console:line"),
    );
    bridge.ingest(
      "chat:message",
      { server: "survival", from: "Steve", text: "forwarded", at: AT },
      meta("chat:message"),
    );
    await untilDelivered(bridge, 1);

    const status = bridge.status();
    expect(status.accepted).toBe(2);
    expect(status.filtered).toBe(1);
    expect(status.stored).toBe(2);
    expect(status.platforms[0]?.delivered).toBe(1);
    await bridge.stop("test");
  });

  it("consoleForward=false 时控制台消息不转发", async () => {
    const bridge = newBridge();
    await bridge.start();
    await bridge.applyConfig({ ...BASE, consoleForward: false });

    bridge.ingest(
      "console:line",
      { server: "survival", line: "[12:00:00] [Server thread/INFO]: Saving the game", at: AT },
      meta("console:line"),
    );
    const status = bridge.status();
    expect(status.accepted).toBe(1);
    expect(status.filtered).toBe(1);
    expect(status.platforms[0]?.delivered).toBe(0);
    await bridge.stop("test");
  });

  it("stop 幂等", async () => {
    const bridge = newBridge();
    await bridge.start();
    await bridge.stop("first");
    await bridge.stop("second");
    expect(bridge.running).toBe(false);
  });

  it("启动前应用配置只更新设置", async () => {
    const bridge = newBridge();
    await bridge.applyConfig({ ...BASE, storeSize: 3 });
    expect(bridge.currentConfig.storeSize).toBe(3);
    expect(bridge.running).toBe(false);

    await bridge.start();
    for (let i = 1; i <= 5; i += 1) {
      bridge.ingest(
        "chat:message",
        { server: "survival", from: "Steve", text: `m${i}`, at: AT },
        meta("chat:message"),
      );
    }
    await untilDelivered(bridge, 3);
    expect(bridge.status().stored).toBe(3);
    expect(bridge.recent({ limit: 10 }).items.map((message) => message.text)).toEqual([
      "m5",
      "m4",
      "m3",
    ]);
    await bridge.stop("test");
  });

  it("平台列表变化时先启动新平台再停旧平台", async () => {
    const a: Probe[] = [];
    const b: Probe[] = [];
    const registry = createRegistry([probeFactory("a", a), probeFactory("b", b)]);
    const bridge = newBridge({ ...BASE, platforms: ["a"] }, registry);
    await bridge.start();
    expect(a).toHaveLength(1);
    expect(a[0]?.started).toBe(1);

    bridge.ingest(
      "chat:message",
      { server: "survival", from: "Steve", text: "before", at: AT },
      meta("chat:message"),
    );
    await untilDelivered(bridge, 1);
    expect(a[0]?.received.map((message) => message.text)).toEqual(["before"]);

    await bridge.applyConfig({ ...BASE, platforms: ["b"] });
    expect(b).toHaveLength(1);
    expect(b[0]?.started).toBe(1);
    expect(a[0]?.stopped).toBe(1);
    expect(bridge.status().platforms.map((platform) => platform.id)).toEqual(["b"]);

    bridge.ingest(
      "chat:message",
      { server: "survival", from: "Steve", text: "after", at: AT },
      meta("chat:message"),
    );
    await untilDelivered(bridge, 1);
    expect(b[0]?.received.map((message) => message.text)).toEqual(["after"]);

    await bridge.stop("test");
    expect(b[0]?.stopped).toBe(1);
  });

  it("过滤配置不重建平台，队列容量变化才重建", async () => {
    const a: Probe[] = [];
    const bridge = newBridge(
      { ...BASE, platforms: ["a"] },
      createRegistry([probeFactory("a", a)]),
    );
    await bridge.start();
    await bridge.applyConfig({ ...BASE, platforms: ["a"], forwardCategories: ["chat"] });
    expect(a).toHaveLength(1);
    expect(a[0]?.started).toBe(1);
    expect(a[0]?.stopped).toBe(0);

    await bridge.applyConfig({ ...BASE, platforms: ["a"], queueCapacity: 7 });
    expect(a).toHaveLength(2);
    expect(a[1]?.started).toBe(1);
    expect(a[0]?.stopped).toBe(1);

    await bridge.stop("test");
  });
});