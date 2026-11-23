import { describe, expect, it, vi } from "vitest";
import type { LogClient } from "mcsup-plugin";

import { LearnedTargets, type KvLike } from "../src/core/targets.js";

function fakeLog(): LogClient {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** 宿主 KV 的替身：按字符串存取，可注入写入失败 */
class FakeKv implements KvLike {
  public readonly data = new Map<string, Uint8Array>();
  public writes = 0;
  public failSet = false;

  public async get(key: string): Promise<Uint8Array | null> {
    return this.data.get(key) ?? null;
  }

  public async set(key: string, value: string | Uint8Array): Promise<void> {
    if (this.failSet) {
      throw new Error("kv down");
    }
    this.writes += 1;
    this.data.set(
      key,
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    );
  }
}

/** 落盘是 fire-and-forget：等一轮微任务再断言 */
async function flushed(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("出站目标记忆", () => {
  it("记住的群与私聊能跨实例读回，且保持首次出现顺序", async () => {
    const kv = new FakeKv();
    const first = new LearnedTargets({ key: "qq:targets", kv, log: fakeLog() });
    first.remember("group", "g1");
    first.remember("private", "u1");
    first.remember("group", "g2");
    await flushed();

    const second = new LearnedTargets({ key: "qq:targets", kv, log: fakeLog() });
    await second.load();
    expect(second.groups()).toEqual(["g1", "g2"]);
    expect(second.users()).toEqual(["u1"]);
    expect(second.size).toBe(3);
  });

  it("重复记住同一个会话不重复写盘", async () => {
    const kv = new FakeKv();
    const learned = new LearnedTargets({ key: "k", kv, log: fakeLog() });
    learned.remember("group", "g1");
    await flushed();
    expect(kv.writes).toBe(1);

    learned.remember("group", "g1");
    learned.remember("group", "g1");
    await flushed();
    expect(kv.writes).toBe(1);
    expect(learned.groups()).toEqual(["g1"]);
  });

  it("未授予 storage:kv 时退化为进程内记忆，不报错也不写盘", async () => {
    const learned = new LearnedTargets({ key: "k", log: fakeLog() });
    await learned.load();
    learned.remember("group", "g1");
    await flushed();
    expect(learned.groups()).toEqual(["g1"]);
  });

  it("记录损坏或版本不认识时按空处理并告警", async () => {
    const kv = new FakeKv();
    const log = fakeLog();
    kv.data.set("k", new TextEncoder().encode("{not json"));
    await new LearnedTargets({ key: "k", kv, log }).load();
    expect(log.warn).toHaveBeenCalledTimes(1);

    const older = new FakeKv();
    const log2 = fakeLog();
    older.data.set("k", new TextEncoder().encode(JSON.stringify({ v: 99, groups: ["g"] })));
    const learned = new LearnedTargets({ key: "k", kv: older, log: log2 });
    await learned.load();
    expect(learned.size).toBe(0);
    expect(log2.warn).toHaveBeenCalledTimes(1);
  });

  it("超过上限时丢最早学到的，落盘的也只保留最新一批", async () => {
    const kv = new FakeKv();
    const learned = new LearnedTargets({ key: "k", kv, log: fakeLog(), limit: 2 });
    learned.remember("group", "g1");
    learned.remember("group", "g2");
    learned.remember("group", "g3");
    await flushed();

    expect(learned.groups()).toEqual(["g2", "g3"]);
    const reloaded = new LearnedTargets({ key: "k", kv, log: fakeLog(), limit: 2 });
    await reloaded.load();
    expect(reloaded.groups()).toEqual(["g2", "g3"]);
  });

  it("被移出群后可以忘记该目标，并落盘", async () => {
    const kv = new FakeKv();
    const learned = new LearnedTargets({ key: "k", kv, log: fakeLog() });
    learned.remember("group", "g1");
    learned.remember("group", "g2");
    await flushed();

    learned.forget("group", "g1");
    await flushed();
    expect(learned.groups()).toEqual(["g2"]);

    const reloaded = new LearnedTargets({ key: "k", kv, log: fakeLog() });
    await reloaded.load();
    expect(reloaded.groups()).toEqual(["g2"]);
  });

  it("忘记不存在的目标不写盘", async () => {
    const kv = new FakeKv();
    const learned = new LearnedTargets({ key: "k", kv, log: fakeLog() });
    learned.remember("group", "g1");
    await flushed();
    expect(kv.writes).toBe(1);

    learned.forget("group", "nope");
    await flushed();
    expect(kv.writes).toBe(1);
  });

  it("写入失败只告警一次，本次会话仍可用", async () => {
    const kv = new FakeKv();
    kv.failSet = true;
    const log = fakeLog();
    const learned = new LearnedTargets({ key: "k", kv, log });
    learned.remember("group", "g1");
    await flushed();
    learned.remember("group", "g2");
    await flushed();

    expect(learned.groups()).toEqual(["g1", "g2"]);
    const warned = (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((call) => String(call[0]).includes("保存出站目标失败"));
    expect(warned).toHaveLength(1);
  });
});
