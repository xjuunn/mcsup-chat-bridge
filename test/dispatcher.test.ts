import { describe, expect, it, vi } from "vitest";

import { PlatformDispatcher } from "../src/core/dispatcher.js";
import type { NormalizedMessage } from "../src/core/types.js";
import type { ChatPlatform, PlatformRelayMessage } from "../src/platforms/types.js";
import type { LogClient } from "mcsup-plugin";

const AT = "2026-11-21T12:00:00.000Z";

function fakeLog(): LogClient {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function message(seq: number): NormalizedMessage {
  return {
    id: `m${seq}`,
    seq,
    category: "chat",
    source: "chat",
    server: "survival",
    at: AT,
    from: "Steve",
    text: `m${seq}`,
    raw: null,
    rule: "test",
  };
}

class Recorder implements ChatPlatform {
  public readonly id: string;
  public readonly title: string;
  public readonly received: NormalizedMessage[] = [];
  public readonly relayed: PlatformRelayMessage[] = [];
  public started = 0;
  public stopped = 0;
  public stopReason = "";
  public inFlight = 0;
  public gate: Promise<void> | undefined;
  public failing = false;
  public failStart = false;
  public failRelay = false;

  public constructor(id = "rec") {
    this.id = id;
    this.title = id;
  }

  public start(): void {
    this.started += 1;
    if (this.failStart) {
      throw new Error("boom-start");
    }
  }

  public async deliver(msg: NormalizedMessage): Promise<void> {
    this.inFlight += 1;
    try {
      if (this.gate !== undefined) {
        await this.gate;
      }
      if (this.failing) {
        throw new Error("boom");
      }
      this.received.push(msg);
    } finally {
      this.inFlight -= 1;
    }
  }

  public relay(msg: PlatformRelayMessage): void {
    if (this.failRelay) {
      throw new Error("boom-relay");
    }
    this.relayed.push(msg);
  }

  public stop(reason: string): void {
    this.stopped += 1;
    this.stopReason = reason;
  }
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

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("PlatformDispatcher", () => {
  it("按到达顺序投递并统计", async () => {
    const platform = new Recorder();
    const dispatcher = new PlatformDispatcher([platform], { capacity: 8, log: fakeLog(), onInbound: () => {} });
    await dispatcher.start();
    expect(platform.started).toBe(1);

    dispatcher.deliver(message(1));
    dispatcher.deliver(message(2));
    dispatcher.deliver(message(3));

    await until(() => platform.received.length === 3);
    expect(platform.received.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(dispatcher.stats()[0]).toMatchObject({ delivered: 3, failed: 0, dropped: 0, queued: 0 });

    await dispatcher.stop("done");
    expect(platform.stopped).toBe(1);
    expect(platform.stopReason).toBe("done");
  });

  it("单平台故障不影响其他平台", async () => {
    const bad = new Recorder();
    bad.failing = true;
    const good = new Recorder();
    const log = fakeLog();
    const dispatcher = new PlatformDispatcher([bad, good], { capacity: 8, log, onInbound: () => {} });
    await dispatcher.start();

    dispatcher.deliver(message(1));
    await until(() => good.received.length === 1);
    await until(() => dispatcher.stats()[0]?.failed === 1);
    expect(good.received.map((m) => m.seq)).toEqual([1]);
    expect(log.warn).toHaveBeenCalled();

    await dispatcher.stop("done");
  });

  it("慢平台不阻塞快平台", async () => {
    const slow = new Recorder();
    const gate = deferred();
    slow.gate = gate.promise;
    const fast = new Recorder();
    const dispatcher = new PlatformDispatcher([slow, fast], { capacity: 8, log: fakeLog(), onInbound: () => {} });
    await dispatcher.start();

    dispatcher.deliver(message(1));
    dispatcher.deliver(message(2));

    await until(() => fast.received.length === 2);
    expect(slow.received.length).toBe(0);
    expect(dispatcher.stats()[0]?.queued).toBeLessThanOrEqual(2);

    gate.resolve();
    await until(() => slow.received.length === 2);
    expect(slow.received.map((m) => m.seq)).toEqual([1, 2]);
    await dispatcher.stop("done");
  });

  it("队列满时丢最旧消息", async () => {
    const slow = new Recorder();
    const gate = deferred();
    slow.gate = gate.promise;
    const dispatcher = new PlatformDispatcher([slow], { capacity: 1, log: fakeLog(), onInbound: () => {} });
    await dispatcher.start();

    dispatcher.deliver(message(1));
    await until(() => slow.inFlight === 1);
    dispatcher.deliver(message(2));
    dispatcher.deliver(message(3));
    expect(dispatcher.stats()[0]?.dropped).toBe(1);

    gate.resolve();
    await until(() => slow.received.length === 2);
    expect(slow.received.map((m) => m.seq)).toEqual([1, 3]);
    await dispatcher.stop("done");
  });

  it("停止时先排空队列再调用 stop", async () => {
    const platform = new Recorder();
    const dispatcher = new PlatformDispatcher([platform], {
      capacity: 8,
      log: fakeLog(),
      onInbound: () => {},
      stopTimeoutMs: 1_000,
    });
    await dispatcher.start();

    dispatcher.deliver(message(1));
    dispatcher.deliver(message(2));
    await dispatcher.stop("shutdown");

    expect(platform.received.map((m) => m.seq)).toEqual([1, 2]);
    expect(platform.stopped).toBe(1);
  });

  it("停止后不再接收投递", async () => {
    const platform = new Recorder();
    const dispatcher = new PlatformDispatcher([platform], { capacity: 8, log: fakeLog(), onInbound: () => {} });
    await dispatcher.start();
    await dispatcher.stop("done");

    dispatcher.deliver(message(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(platform.received.length).toBe(0);
  });

  it("持续溢出时队列保持有界并丢最旧", async () => {
    const slow = new Recorder();
    const gate = deferred();
    slow.gate = gate.promise;
    const dispatcher = new PlatformDispatcher([slow], { capacity: 2, log: fakeLog(), onInbound: () => {} });
    await dispatcher.start();

    dispatcher.deliver(message(1));
    await until(() => slow.inFlight === 1);
    for (let seq = 2; seq <= 100; seq += 1) {
      dispatcher.deliver(message(seq));
    }

    expect(dispatcher.stats()[0]).toMatchObject({ queued: 2, dropped: 97 });
    expect(dispatcher.pending()).toBe(2);

    gate.resolve();
    await until(() => slow.received.length === 3);
    expect(slow.received.map((m) => m.seq)).toEqual([1, 99, 100]);
    await dispatcher.stop("done");
  });

  it("平台 start 失败时回滚已启动平台", async () => {
    const first = new Recorder("first");
    const second = new Recorder("second");
    second.failStart = true;
    const dispatcher = new PlatformDispatcher([first, second], {
      capacity: 8,
      log: fakeLog(),
      onInbound: () => {},
    });

    await expect(dispatcher.start()).rejects.toThrow("boom-start");
    expect(first.started).toBe(1);
    expect(first.stopped).toBe(1);
    expect(first.stopReason).toBe("start failed");
    expect(second.stopped).toBe(0);

    dispatcher.deliver(message(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(first.received.length).toBe(0);
  });
});

const RELAY: PlatformRelayMessage = {
  platform: "qq",
  source: "QQ",
  channel: { kind: "group", id: "g1" },
  author: { id: "u1", name: "小A" },
  text: "群里的话",
};

describe("跨平台转发队列", () => {
  it("投给除来源平台之外、实现了 relay 的平台", async () => {
    const qq = new Recorder("qq");
    const telegram = new Recorder("telegram");
    // 日志平台不实现 relay：内核不该给它建转发队列，也不该接收转发
    const logPlatform: ChatPlatform = {
      id: "log",
      title: "log",
      start() {},
      deliver() {},
      stop() {},
    };
    const dispatcher = new PlatformDispatcher([qq, telegram, logPlatform], {
      capacity: 8,
      log: fakeLog(),
      onInbound: () => {},
    });
    await dispatcher.start();

    expect(dispatcher.relay(RELAY)).toBe(1);
    await until(() => telegram.relayed.length === 1);
    expect(telegram.relayed[0]).toEqual(RELAY);
    expect(qq.relayed).toHaveLength(0);

    const stats = dispatcher.stats();
    expect(stats[1]).toMatchObject({ relayed: 1, relayDropped: 0 });
    expect(stats[0]?.relayed).toBe(0);
    expect(stats[2]?.relayed).toBe(0);

    await dispatcher.stop("done");
  });

  it("没有可接收平台时返回 0", async () => {
    const qq = new Recorder("qq");
    const dispatcher = new PlatformDispatcher([qq], {
      capacity: 8,
      log: fakeLog(),
      onInbound: () => {},
    });
    await dispatcher.start();
    expect(dispatcher.relay(RELAY)).toBe(0);
    await dispatcher.stop("done");
  });

  it("转发失败只计数，不中断队列", async () => {
    const bad = new Recorder("bad");
    bad.failRelay = true;
    const log = fakeLog();
    const dispatcher = new PlatformDispatcher([bad], { capacity: 8, log, onInbound: () => {} });
    await dispatcher.start();

    expect(dispatcher.relay(RELAY)).toBe(1);
    const warned = (): boolean =>
      ((log.warn as unknown as { mock?: { calls: unknown[][] } }).mock?.calls ?? []).some((args) =>
        String(args[0]).includes("跨平台转发失败"),
      );
    await until(warned);
    expect(dispatcher.stats()[0]).toMatchObject({ relayed: 0, relayFailed: 1 });
    expect(dispatcher.pending()).toBe(0);

    await dispatcher.stop("done");
  });

  it("转发队列溢出时丢最旧并计数", async () => {
    const slow = new Recorder("slow");
    const gate = deferred();
    slow.gate = gate.promise;
    const dispatcher = new PlatformDispatcher([slow], { capacity: 2, log: fakeLog(), onInbound: () => {} });
    await dispatcher.start();

    // 先把消费者卡在一条出站消息上，转发只能排队
    dispatcher.deliver(message(1));
    await until(() => slow.inFlight === 1);
    for (let seq = 1; seq <= 5; seq += 1) {
      dispatcher.relay({ ...RELAY, messageId: `r${seq}` });
    }
    expect(dispatcher.stats()[0]).toMatchObject({ relayDropped: 3 });

    gate.resolve();
    await until(() => slow.relayed.length === 2);
    expect(slow.relayed.map((item) => item.messageId)).toEqual(["r4", "r5"]);
    await dispatcher.stop("done");
  });
});