import { createMockHost } from "mcsup-plugin/testing";
import type { CallResult } from "mcsup-plugin/testing";
import { describe, expect, it } from "vitest";

import plugin from "../src/index.js";

interface MessageItem {
  readonly id: string;
  readonly seq: number;
  readonly category: string;
  readonly source: string;
  readonly server: string;
  readonly at: string;
  readonly from: string;
  readonly text: string;
  readonly rule: string;
}

interface MessagePage {
  readonly items: MessageItem[];
  readonly next?: string;
}

interface StatusView {
  readonly started: boolean;
  readonly uptimeSecs: number;
  readonly accepted: number;
  readonly duplicates: number;
  readonly skipped: number;
  readonly filtered: number;
  readonly stored: number;
  readonly suppressed: number;
  readonly categories: Record<string, number>;
  readonly platforms: Array<{
    readonly id: string;
    readonly title: string;
    readonly queued: number;
    readonly delivered: number;
    readonly failed: number;
    readonly dropped: number;
  }>;
  readonly inbound: {
    readonly received: number;
    readonly delivered: number;
    readonly dropped: number;
    readonly duplicates: number;
    readonly failed: number;
  };
}

function unwrap<T>(result: CallResult): T {
  if (!result.ok) {
    throw new Error(`调用失败：${result.error.code} ${result.error.message}`);
  }
  return result.output as T;
}

const AT = "2026-11-21T12:00:00.000Z";

describe("插件（MockHost 全链路）", () => {
  it("握手声明能力与订阅", async () => {
    const host = createMockHost(plugin, { config: { platforms: ["null"] } });
    await host.start();

    const hello = host.frames.find((frame) => frame.type === "hello");
    expect(hello).toBeDefined();
    if (hello?.type === "hello") {
      expect(hello.plugin_id).toBe("chat-bridge");
      expect(hello.requested).toEqual([
        "events",
        "console:read",
        "console:write",
        "server:read",
      ]);
      expect(hello.subscriptions).toContain("chat:message");
      expect(hello.subscriptions).toContain("console:line");
      expect(hello.subscriptions).toContain("player:joined");
    }
    await host.shutdown(1_000);
  });

  it("事件 → 分类 → 入库 → 查询，配置热更新生效", async () => {
    const host = createMockHost(plugin, { config: { platforms: ["null"] } });
    await host.start();

    await host.emit("chat:message", {
      server: "survival",
      from: "Steve",
      text: "\u00a7a你好",
      at: AT,
    });
    await host.emit("console:line", {
      server: "survival",
      line: `[12:00:00] [Server thread/INFO]: <Steve> \u00a7a你好`,
      at: AT,
    });
    await host.emit("console:line", {
      server: "survival",
      line: "[12:00:01] [Server thread/WARN]: Can't keep up!",
      at: AT,
    });
    await host.emit("player:joined", { player: "Alex" });

    const page = unwrap<MessagePage>(await host.callOp("messages", { limit: 10 }));
    expect(page.items.map((item) => item.category).sort()).toEqual(["chat", "join", "warning"]);
    expect(page.items.find((item) => item.category === "chat")?.text).toBe("你好");

    let status = unwrap<StatusView>(await host.callOp("status"));
    expect(status.started).toBe(true);
    expect(status.accepted).toBe(3);
    expect(status.skipped).toBe(1);
    expect(status.stored).toBe(3);
    expect(status.categories.chat).toBe(1);
    expect(status.categories.join).toBe(1);
    expect(status.categories.warning).toBe(1);
    expect(status.platforms[0]?.id).toBe("null");
    let waited = Date.now() + 2_000;
    while (status.platforms[0]?.delivered !== 3 && Date.now() < waited) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = unwrap<StatusView>(await host.callOp("status"));
    }
    expect(status.platforms[0]?.delivered).toBe(3);

    const changed = await host.changeConfig(2, {
      platforms: ["null"],
      forwardCategories: ["chat"],
    });
    expect(changed.ok).toBe(true);

    await host.emit("console:line", {
      server: "survival",
      line: "[12:00:02] [Server thread/WARN]: 只入库不转发",
      at: AT,
    });
    status = unwrap<StatusView>(await host.callOp("status"));
    expect(status.accepted).toBe(4);
    expect(status.filtered).toBe(1);
    expect(status.stored).toBe(4);

    expect(await host.shutdown(2_000)).toBe(0);
  });

  it("未知平台在启动阶段以配置错误退出", async () => {
    const host = createMockHost(plugin, { config: { platforms: ["nope"] } });
    await host.start();
    expect(await host.waitExit(2_000)).toBe(3);
  });

  it("非法配置热更新被拒绝，旧配置继续工作", async () => {
    const host = createMockHost(plugin, { config: { platforms: ["null"] } });
    await host.start();

    const bad = await host.changeConfig(2, { platforms: ["nope"] });
    expect(bad.ok).toBe(false);
    if (bad.ok === false) {
      expect(bad.error.code).toBe("invalid_input");
    }

    await host.emit("chat:message", {
      server: "survival",
      from: "Steve",
      text: "still works",
      at: AT,
    });
    const page = unwrap<MessagePage>(await host.callOp("messages", { limit: 10 }));
    expect(page.items.map((item) => item.text)).toEqual(["still works"]);

    const status = unwrap<StatusView>(await host.callOp("status"));
    expect(status.platforms[0]?.id).toBe("null");
    expect(await host.shutdown(1_000)).toBe(0);
  });
});