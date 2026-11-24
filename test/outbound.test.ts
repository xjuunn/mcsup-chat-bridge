import { describe, expect, it, vi } from "vitest";
import type { LogClient } from "mcsup-plugin";

import { LearnedTargets } from "../src/core/targets.js";
import {
  OutboundQueue,
  TargetBook,
  type OutboundTarget,
  type QueueItem,
} from "../src/platforms/shared/outbound.js";
import type { KvLike } from "../src/core/targets.js";

function fakeLog(): LogClient & {
  warns: string[];
} {
  const warns: string[] = [];
  return {
    warns,
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message: string) => {
      warns.push(message);
    },
    error: vi.fn(),
  };
}

function fakeKv(): KvLike {
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

function book(log: LogClient, options: {
  groups?: readonly string[];
  users?: readonly string[];
  learned?: LearnedTargets;
} = {}): TargetBook {
  const learned =
    options.learned ??
    new LearnedTargets({ key: "test:targets", kv: fakeKv(), log });
  return new TargetBook({
    label: "test",
    log,
    learned,
    groups: options.groups ?? [],
    users: options.users ?? [],
    syncChannels: true,
    noTargetHint: "收到消息后自动补齐",
    noMirrorHint: "在群里发一条消息",
  });
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) {
      throw new Error(`等待超时：${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Item extends QueueItem {
  readonly prepared?: string;
}

/** 建队列：记录发送顺序与每次准备的结果 */
function queue(options: {
  targets: TargetBook;
  log: LogClient;
  limit?: number;
  stopping?: () => boolean;
  prepare?: (pending: Item) => Promise<string>;
  fail?: (target: OutboundTarget) => boolean;
}): {
  outbound: OutboundQueue<Item, string>;
  sent: string[];
  prepares: string[];
} {
  const sent: string[] = [];
  const prepares: string[] = [];
  const outbound = new OutboundQueue<Item, string>({
    label: "test",
    title: "Test",
    limit: options.limit ?? 8,
    log: options.log,
    targets: options.targets,
    isStopping: options.stopping ?? (() => false),
    prepare: async (pending) => {
      const value = options.prepare === undefined ? "" : await options.prepare(pending);
      prepares.push(`${pending.id}:${value}`);
      return value;
    },
    send: async (target, pending, prepared) => {
      if (options.fail?.(target) === true) {
        throw new Error(`send failed: ${target.id}`);
      }
      sent.push(`${target.kind}/${target.id}/${pending.id}/${prepared}`);
    },
  });
  return { outbound, sent, prepares };
}

describe("TargetBook", () => {
  it("显式配置优先于学到的会话", () => {
    const log = fakeLog();
    const learned = new LearnedTargets({ key: "k", log });
    learned.remember("group", "learned-g");
    learned.remember("private", "learned-u");
    const targets = book(log, { learned, groups: ["cfg-g"], users: ["cfg-u"] }).targets();
    expect(targets).toEqual([
      { kind: "group", id: "cfg-g" },
      { kind: "private", id: "cfg-u" },
    ]);
  });

  it("配置留空时按首次出现顺序使用学到的会话", () => {
    const log = fakeLog();
    const learned = new LearnedTargets({ key: "k", log });
    learned.remember("private", "u1");
    learned.remember("group", "g1");
    expect(book(log, { learned }).targets()).toEqual([
      { kind: "group", id: "g1" },
      { kind: "private", id: "u1" },
    ]);
  });

  it("没有任何会话时才告警一次「还没有可用的会话目标」", () => {
    const log = fakeLog();
    const targets = book(log);
    targets.warnNoTarget();
    targets.warnNoTarget();
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]).toContain("还没有可用的会话目标（收到消息后自动补齐）");
  });

  it("已有会话时不告警，避免把 exclude 过滤误报成缺目标", () => {
    const log = fakeLog();
    book(log, { groups: ["g1"] }).warnNoTarget();
    expect(log.warns).toHaveLength(0);
  });

  it("私聊镜像缺群目标只告警一次，且群消息不告警", () => {
    const log = fakeLog();
    const targets = book(log);
    targets.warnNoMirrorTarget(true);
    expect(log.warns).toHaveLength(0);
    targets.warnNoMirrorTarget(false);
    targets.warnNoMirrorTarget(false);
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]).toContain("私聊镜像暂时发不到群");
  });

  it("已有群目标后不再告警", () => {
    const log = fakeLog();
    const learned = new LearnedTargets({ key: "k", log });
    learned.remember("group", "g1");
    book(log, { learned }).warnNoMirrorTarget(false);
    expect(log.warns).toHaveLength(0);
  });
});

describe("OutboundQueue", () => {
  it("串行发到所有目标，并带上准备结果", async () => {
    const log = fakeLog();
    const targets = book(log, { groups: ["g1"], users: ["u1"] });
    const { outbound, sent, prepares } = queue({
      targets,
      log,
      prepare: async (pending) => `prepared-${pending.id}`,
    });
    outbound.push({ id: "m1", text: "hello" });
    await waitFor(() => sent.length === 2, "两条目标发送完成");
    expect(prepares).toEqual(["m1:prepared-m1"]);
    expect(sent).toEqual(["group/g1/m1/prepared-m1", "private/u1/m1/prepared-m1"]);
  });

  it("exclude 跳过来源会话，其余目标仍收到", async () => {
    const log = fakeLog();
    const targets = book(log, { groups: ["g1"] });
    const { outbound, sent } = queue({ targets, log });
    outbound.push({ id: "mirror", text: "echo", exclude: "group:g1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toEqual([]);
    // 唯一目标被 exclude 过滤掉不算「真没目标」
    expect(log.warns).toHaveLength(0);
  });

  it("积压超过上限丢最旧并告警", async () => {
    const log = fakeLog();
    const targets = book(log, { groups: ["g1"] });
    let stopping = false;
    const releases: Array<() => void> = [];
    const outbound = new OutboundQueue<Item>({
      label: "test",
      title: "Test",
      limit: 2,
      log,
      targets,
      isStopping: () => stopping,
      send: async () => {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      },
    });
    // 第一条进入发送（挂起），后面三条排队，第 4 条触发丢最旧
    outbound.push({ id: "m1", text: "1" });
    outbound.push({ id: "m2", text: "2" });
    outbound.push({ id: "m3", text: "3" });
    outbound.push({ id: "m4", text: "4" });
    expect(outbound.size).toBe(2);
    expect(log.warns[0]).toContain("出站积压超过 2 条");
    stopping = true;
    for (const release of releases) {
      release();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("空文本不入队，停止后也不再接收", async () => {
    const log = fakeLog();
    const targets = book(log, { groups: ["g1"] });
    let stopping = false;
    const { outbound, sent } = queue({ targets, log, stopping: () => stopping });
    outbound.push({ id: "empty", text: "" });
    expect(outbound.size).toBe(0);
    stopping = true;
    outbound.push({ id: "later", text: "later" });
    expect(outbound.size).toBe(0);
    expect(sent).toEqual([]);
  });

  it("单个目标失败只记日志，其他目标照常收到", async () => {
    const log = fakeLog();
    const targets = book(log, { groups: ["g1"], users: ["u1"] });
    const { outbound, sent } = queue({
      targets,
      log,
      fail: (target) => target.kind === "group",
    });
    outbound.push({ id: "m1", text: "hello" });
    await waitFor(() => sent.length === 1, "私聊目标发送完成");
    expect(log.warns.some((text) => text.includes("发送到 group:g1 失败"))).toBe(true);
    expect(sent).toEqual(["private/u1/m1/"]);
  });

  it("全部目标失败时收口为告警，不产生未处理的 rejection", async () => {
    const log = fakeLog();
    const targets = book(log, { groups: ["g1"] });
    const { outbound } = queue({
      targets,
      log,
      fail: () => true,
    });
    outbound.push({ id: "m1", text: "hello" });
    await waitFor(
      () => log.warns.some((text) => text.includes("出站队列异常")),
      "全部失败后收口",
    );
    expect(
      log.warns.some((text) => text.includes("Test 所有目标均发送失败（m1）")),
    ).toBe(true);
  });
});