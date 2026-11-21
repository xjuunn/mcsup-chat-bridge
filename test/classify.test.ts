import { describe, expect, it } from "vitest";

import {
  classifyChat,
  classifyConsoleLine,
  classifyLifecycle,
  classifyPlayer,
  type ConsoleResult,
} from "../src/core/classify.js";

const AT = "2026-11-21T12:00:00.000Z";

function messageOf(result: ConsoleResult) {
  if (result.kind !== "message") {
    throw new Error(`预期消息，实际跳过：${result.reason}`);
  }
  return result.draft;
}

describe("聊天分类", () => {
  it("去掉颜色码并保留原文本", () => {
    const draft = classifyChat({ server: "survival", from: "Steve", text: "\u00a7a有人吗", at: AT });
    expect(draft.category).toBe("chat");
    expect(draft.source).toBe("chat");
    expect(draft.text).toBe("有人吗");
    expect(draft.raw).toBe("\u00a7a有人吗");
    expect(draft.from).toBe("Steve");
    expect(draft.rule).toBe("chat.message");
  });

  it("以 / 开头视为命令", () => {
    const draft = classifyChat({ server: "survival", from: "Steve", text: "/help", at: AT });
    expect(draft.category).toBe("command");
    expect(draft.rule).toBe("chat.command");
  });

  it("空发送者归一为 null", () => {
    const draft = classifyChat({ server: "survival", from: "  ", text: "hi", at: AT });
    expect(draft.from).toBeNull();
  });
});

describe("控制台分类", () => {
  it("控制台聊天行（离线模式的 [Not Secure]）也产出聊天消息，并标记为投影", () => {
    const result = classifyConsoleLine({
      server: "survival",
      line: "[12:00:00] [Server thread/INFO]: <Steve> \u00a7a有人吗",
      at: AT,
    });
    expect(result).toMatchObject({
      kind: "message",
      projection: true,
      draft: {
        category: "chat",
        source: "chat",
        from: "Steve",
        text: "有人吗",
        rule: "chat.message",
      },
    });

    const offline = classifyConsoleLine({
      server: "survival",
      line: "[20:15:04] [Server thread/INFO]: [Not Secure] <Junhsiun> test",
      at: AT,
    });
    expect(offline).toMatchObject({
      kind: "message",
      projection: true,
      draft: { category: "chat", from: "Junhsiun", text: "test" },
    });
  });

  it("以 / 开头的控制台聊天行归为命令", () => {
    const result = classifyConsoleLine({
      server: "survival",
      line: "[12:00:00] [Server thread/INFO]: <Steve> /help",
      at: AT,
    });
    expect(result).toMatchObject({
      kind: "message",
      projection: true,
      draft: { category: "command", from: "Steve", text: "/help" },
    });
  });

  it("跳过玩家加入 / 离开行", () => {
    expect(
      classifyConsoleLine({ server: "survival", line: "Alex joined the game", at: AT }),
    ).toEqual({ kind: "skip", reason: "structured:join" });
    expect(
      classifyConsoleLine({
        server: "survival",
        line: "[12:00:00] [Server thread/INFO]: Alex left the game",
        at: AT,
      }),
    ).toEqual({ kind: "skip", reason: "structured:leave" });
  });

  it("识别 WARN 与 ERROR 级别", () => {
    const warning = messageOf(
      classifyConsoleLine({
        server: "survival",
        line: "[12:00:00] [Server thread/WARN]: Can't keep up!",
        at: AT,
      }),
    );
    expect(warning.category).toBe("warning");
    expect(warning.text).toBe("Can't keep up!");
    expect(warning.rule).toBe("console.warning");

    const error = messageOf(
      classifyConsoleLine({
        server: "survival",
        line: "[12:00:00] [Server thread/ERROR]: Failed to load chunk",
        at: AT,
      }),
    );
    expect(error.category).toBe("error");
    expect(error.rule).toBe("console.error");
  });

  it("识别异常栈（即使级别是 INFO）", () => {
    const draft = messageOf(
      classifyConsoleLine({
        server: "survival",
        line: "[12:00:00] [Server thread/INFO]: java.lang.NullPointerException: boom",
        at: AT,
      }),
    );
    expect(draft.category).toBe("error");
    expect(draft.rule).toBe("console.stack");
  });

  it("识别命令、死亡与进度", () => {
    const command = messageOf(
      classifyConsoleLine({ server: "survival", line: "Steve issued server command: /home", at: AT }),
    );
    expect(command.category).toBe("command");
    expect(command.from).toBe("Steve");
    expect(command.text).toBe("/home");

    const death = messageOf(
      classifyConsoleLine({ server: "survival", line: "Steve was slain by Zombie", at: AT }),
    );
    expect(death.category).toBe("death");
    expect(death.from).toBe("Steve");

    const squashed = messageOf(
      classifyConsoleLine({ server: "survival", line: "Alex was squashed by a falling anvil", at: AT }),
    );
    expect(squashed.category).toBe("death");

    const advancement = messageOf(
      classifyConsoleLine({
        server: "survival",
        line: "Alex has made the advancement [Stone Age]",
        at: AT,
      }),
    );
    expect(advancement.category).toBe("advancement");
    expect(advancement.from).toBe("Alex");
  });

  it("服务器状态行归为 system，DEBUG 噪声归为 other", () => {
    const system = messageOf(
      classifyConsoleLine({
        server: "survival",
        line: "[12:00:00] [Server thread/INFO]: Saving the game",
        at: AT,
      }),
    );
    expect(system.category).toBe("system");
    expect(system.rule).toBe("console.system");

    const starting = messageOf(
      classifyConsoleLine({
        server: "survival",
        line: "[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.20.1",
        at: AT,
      }),
    );
    expect(starting.category).toBe("system");
    expect(starting.rule).toBe("console.system");

    const other = messageOf(
      classifyConsoleLine({
        server: "survival",
        line: "[12:00:00] [Server thread/DEBUG]: packet dump",
        at: AT,
      }),
    );
    expect(other.category).toBe("other");
    expect(other.rule).toBe("console.other");
  });

  it("去掉 ANSI 转义、控制字符与空行", () => {
    const draft = messageOf(
      classifyConsoleLine({
        server: "survival",
        line: "\u001b[31m[12:00:00] [Server thread/WARN]: \u001b[0mbad thing",
        at: AT,
      }),
    );
    expect(draft.category).toBe("warning");
    expect(draft.text).toBe("bad thing");

    const control = messageOf(
      classifyConsoleLine({
        server: "survival",
        line: "[12:00:00] [Server thread/WARN]: bad\u0007thing",
        at: AT,
      }),
    );
    expect(control.text).toBe("bad thing");

    expect(classifyConsoleLine({ server: "survival", line: "   ", at: AT })).toEqual({
      kind: "skip",
      reason: "empty",
    });
  });

  it("未识别的 INFO 行进 system（便于后续过滤）", () => {
    const draft = messageOf(
      classifyConsoleLine({
        server: "survival",
        line: "[12:00:00] [Server thread/INFO]: Player Steve moved too quickly",
        at: AT,
      }),
    );
    expect(draft.category).toBe("system");
  });
});

describe("结构化事件分类", () => {
  it("生命周期映射为 system", () => {
    const draft = classifyLifecycle("server:started", "survival", AT);
    expect(draft).not.toBeNull();
    expect(draft?.category).toBe("system");
    expect(draft?.source).toBe("event");
    expect(draft?.text).toBe("服务器已就绪");
    expect(classifyLifecycle("backup:completed", "survival", AT)).toBeNull();
  });

  it("玩家加入 / 离开", () => {
    const joined = classifyPlayer("player:joined", "Alex", "survival", AT);
    expect(joined.category).toBe("join");
    expect(joined.from).toBe("Alex");
    expect(joined.text).toBe("Alex 加入了游戏");

    const left = classifyPlayer("player:left", "Alex", "survival", AT);
    expect(left.category).toBe("leave");
    expect(left.text).toBe("Alex 离开了游戏");
  });
});