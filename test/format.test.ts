import { describe, expect, it } from "vitest";

import { formatRelay, splitText } from "../src/platform-kit/format.js";

describe("跨平台转发文本格式", () => {
  it("带上来源平台与群/私聊，接收方一眼看出说话的地方", () => {
    expect(
      formatRelay({
        source: "QQ",
        channel: { kind: "group" },
        author: { name: "小A" },
        text: "群里的话",
      }),
    ).toBe("[QQ 群] 小A: 群里的话");
    expect(
      formatRelay({
        source: "Telegram",
        channel: { kind: "private" },
        author: { name: "Bob" },
        text: "hi",
      }),
    ).toBe("[Telegram 私聊] Bob: hi");
  });

  it("折叠换行与连续空白，转发不会撑成多行", () => {
    expect(
      formatRelay({
        source: "QQ",
        channel: { kind: "group" },
        author: { name: "小A" },
        text: "第一行\n第二行  第三行",
      }),
    ).toBe("[QQ 群] 小A: 第一行 第二行 第三行");
  });

  it("昵称为空时用「未知」，媒体占位原样保留", () => {
    expect(
      formatRelay({
        source: "Telegram",
        channel: { kind: "group" },
        author: { name: "  " },
        text: "[图片]",
      }),
    ).toBe("[Telegram 群] 未知: [图片]");
  });
});

describe("分片", () => {
  it("按码点切分，不把 emoji 切成半个", () => {
    expect(splitText("😀😀😀", 2)).toEqual(["😀😀", "😀"]);
    expect(splitText("abc", 5)).toEqual(["abc"]);
  });
});