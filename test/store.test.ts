import { describe, expect, it } from "vitest";

import { MAX_RAW, MAX_TEXT, MessageStore } from "../src/core/store.js";
import type { MessageCategory, MessageDraft } from "../src/core/types.js";

const AT = "2026-11-21T12:00:00.000Z";

function draft(overrides: Partial<MessageDraft> = {}): MessageDraft {
  return {
    category: "chat",
    source: "chat",
    server: "survival",
    at: AT,
    from: "Steve",
    text: "hi",
    raw: "hi",
    rule: "chat.message",
    ...overrides,
  };
}

function fill(store: MessageStore, count: number, overrides: Partial<MessageDraft> = {}): void {
  for (let i = 1; i <= count; i += 1) {
    store.add(draft({ text: `m${i}`, raw: `m${i}`, ...overrides }));
  }
}

describe("MessageStore", () => {
  it("同内容只入库一次，seq 只对入库消息递增", () => {
    const store = new MessageStore(10);
    const first = store.add(draft());
    const second = store.add(draft());
    expect(first?.seq).toBe(1);
    expect(second).toBeNull();
    expect(store.size).toBe(1);

    const third = store.add(draft({ text: "other", raw: "other" }));
    expect(third?.seq).toBe(2);
  });

  it("容量淘汰最旧消息，但累计计数保留", () => {
    const store = new MessageStore(2);
    fill(store, 3);
    expect(store.size).toBe(2);
    const page = store.recent();
    expect(page.items.map((m) => m.seq)).toEqual([3, 2]);
    expect(store.counts().chat).toBe(3);

    store.resize(1);
    expect(store.recent().items.map((m) => m.seq)).toEqual([3]);
  });

  it("按 seq 倒序分页，游标不重复", () => {
    const store = new MessageStore(10);
    fill(store, 5);

    const first = store.recent({ limit: 2 });
    expect(first.items.map((m) => m.seq)).toEqual([5, 4]);
    expect(first.next).toBe("4");

    const second = store.recent({ limit: 2, cursor: first.next });
    expect(second.items.map((m) => m.seq)).toEqual([3, 2]);
    expect(second.next).toBe("2");

    const third = store.recent({ limit: 2, cursor: second.next });
    expect(third.items.map((m) => m.seq)).toEqual([1]);
    expect(third.next).toBeUndefined();
  });

  it("支持类别、来源与服务器过滤", () => {
    const store = new MessageStore(10);
    store.add(draft({ category: "chat" as MessageCategory, text: "c1", raw: "c1" }));
    store.add(
      draft({ category: "warning", source: "console", server: "creative", text: "w1", raw: "w1" }),
    );
    store.add(draft({ category: "warning", source: "console", text: "w2", raw: "w2" }));

    expect(store.recent({ category: "warning" }).items.map((m) => m.text)).toEqual(["w2", "w1"]);
    expect(store.recent({ source: "console" }).items.map((m) => m.text)).toEqual(["w2", "w1"]);
    expect(store.recent({ server: "creative" }).items.map((m) => m.text)).toEqual(["w1"]);
  });

  it("非法游标按从最新开始处理", () => {
    const store = new MessageStore(10);
    fill(store, 2);
    expect(store.recent({ limit: 1, cursor: "not-a-number" }).items.map((m) => m.seq)).toEqual([2]);
    expect(store.recent({ limit: 1, cursor: "0" }).items.map((m) => m.seq)).toEqual([2]);
  });

  it("非法 limit 回退默认值，超大 limit 被截断", () => {
    const store = new MessageStore(300);
    fill(store, 250);
    expect(store.recent({ limit: Number.NaN }).items.length).toBe(50);
    expect(store.recent({ limit: Number.POSITIVE_INFINITY }).items.length).toBe(50);
    expect(store.recent({ limit: 10_000 }).items.length).toBe(200);
  });

  it("超长文本与原始行入库时截断", () => {
    const store = new MessageStore(10);
    const huge = "x".repeat(10_000);
    const message = store.add(draft({ text: huge, raw: huge }));
    expect(message?.text.length).toBe(MAX_TEXT);
    expect(message?.text.endsWith("…")).toBe(true);
    expect(message?.raw?.length).toBe(MAX_RAW);
    expect(message?.raw?.endsWith("…")).toBe(true);
  });

  it("持续写入大量消息仍只保留容量内的条数", () => {
    const store = new MessageStore(10);
    for (let i = 0; i < 10_000; i += 1) {
      store.add(draft({ text: `m${i}`, raw: `m${i}` }));
    }
    expect(store.size).toBe(10);
    const page = store.recent({ limit: 10 });
    expect(page.items.map((message) => message.text)).toEqual([
      "m9999",
      "m9998",
      "m9997",
      "m9996",
      "m9995",
      "m9994",
      "m9993",
      "m9992",
      "m9991",
      "m9990",
    ]);
    expect(store.counts().chat).toBe(10_000);
  });

  it("满页最长中文消息仍在 1 MB 帧预算内", () => {
    const store = new MessageStore(300);
    const longText = "测".repeat(1_500);
    const longName = "玩家".repeat(60);
    for (let i = 0; i < 200; i += 1) {
      store.add(
        draft({
          server: longName,
          from: longName,
          text: `${longText}${i}`,
          raw: longText,
          rule: "rule".repeat(20),
        }),
      );
    }

    const page = store.recent({ limit: 200 });
    const output = page.items.map((message) => ({
      id: message.id,
      seq: message.seq,
      category: message.category,
      source: message.source,
      server: message.server,
      at: message.at,
      from: message.from ?? "",
      text: message.text,
      rule: message.rule,
    }));
    expect(output.length).toBe(200);
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThan(1_048_576);
  });
});