import { describe, expect, it } from "vitest";
import type { EventMeta } from "mcsup-plugin";

import { normalizeEvent } from "../src/events/normalize.js";

const AT = "2026-11-21T12:00:00.000Z";

function meta(kind: string, server?: string): EventMeta {
  return server === undefined ? { kind, at: AT } : { kind, server, at: AT };
}

describe("事件归一化", () => {
  it("聊天事件转成 chat 草稿，颜色码被清理", () => {
    const result = normalizeEvent(
      "chat:message",
      { server: "survival", from: "Steve", text: "\u00a7a你好", at: AT },
      meta("chat:message"),
    );
    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.draft.category).toBe("chat");
      expect(result.draft.text).toBe("你好");
      expect(result.draft.at).toBe("2026-11-21T12:00:00.000Z");
    }
  });

  it("负载缺字段时不抛错，返回 invalid", () => {
    const result = normalizeEvent("chat:message", { from: "Steve" }, meta("chat:message"));
    expect(result.kind).toBe("invalid");
  });

  it("at 非法时回退到 meta.at", () => {
    const result = normalizeEvent(
      "chat:message",
      { server: "survival", from: "Steve", text: "hi", at: "not-a-time" },
      meta("chat:message"),
    );
    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.draft.at).toBe("2026-11-21T12:00:00.000Z");
    }
  });

  it("负载与 meta 都没有服务器名时用 unknown", () => {
    const result = normalizeEvent("player:joined", { player: "Alex" }, meta("player:joined"));
    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.draft.server).toBe("unknown");
      expect(result.draft.category).toBe("join");
    }
  });

  it("真实信封：server 只在 meta 顶层、data 不带 server 时仍能归一化", () => {
    // 宿主线格式：{"kind":"chat:message","server":"test1","at":...,
    //              "data":{"from":"Steve","text":"你好","at":...}}
    const result = normalizeEvent(
      "chat:message",
      { from: "Steve", text: "你好", at: AT },
      meta("chat:message", "test1"),
    );
    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.draft.category).toBe("chat");
      expect(result.draft.server).toBe("test1");
      expect(result.draft.from).toBe("Steve");
    }
  });

  it("真实信封：console:line 的 data 只有 line/at", () => {
    const result = normalizeEvent(
      "console:line",
      { line: "[12:00:00] [Server thread/WARN]: slow", at: AT },
      meta("console:line", "test1"),
    );
    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.draft.category).toBe("warning");
      expect(result.draft.server).toBe("test1");
    }
  });

  it("真实信封：player:joined 不带 at，时间回退到 meta", () => {
    const result = normalizeEvent("player:joined", { player: "Alex" }, meta("player:joined", "test1"));
    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.draft.server).toBe("test1");
      expect(result.draft.at).toBe("2026-11-21T12:00:00.000Z");
    }
  });

  it("备份事件与未知事件被跳过", () => {
    expect(normalizeEvent("backup:completed", {}, meta("backup:completed")).kind).toBe("skip");
    expect(normalizeEvent("mystery", {}, meta("mystery")).kind).toBe("skip");
  });
});