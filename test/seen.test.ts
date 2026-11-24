import { describe, expect, it } from "vitest";

import { DEFAULT_SEEN_LIMIT, MessageSeen } from "../src/platforms/shared/seen.js";

describe("MessageSeen", () => {
  it("记住的消息才算见过", () => {
    const seen = new MessageSeen();
    expect(seen.has("m1")).toBe(false);
    seen.remember("m1");
    expect(seen.has("m1")).toBe(true);
    expect(seen.size).toBe(1);
  });

  it("重复记住不增长", () => {
    const seen = new MessageSeen();
    seen.remember("m1");
    seen.remember("m1");
    expect(seen.size).toBe(1);
  });

  it("超过窗口时丢最旧", () => {
    const seen = new MessageSeen(2);
    seen.remember("m1");
    seen.remember("m2");
    seen.remember("m3");
    expect(seen.size).toBe(2);
    expect(seen.has("m1")).toBe(false);
    expect(seen.has("m2")).toBe(true);
    expect(seen.has("m3")).toBe(true);
  });

  it("默认窗口为 1000 条", () => {
    expect(DEFAULT_SEEN_LIMIT).toBe(1_000);
    const seen = new MessageSeen();
    for (let index = 0; index < DEFAULT_SEEN_LIMIT + 1; index += 1) {
      seen.remember(`m${index}`);
    }
    expect(seen.size).toBe(DEFAULT_SEEN_LIMIT);
    expect(seen.has("m0")).toBe(false);
  });
});