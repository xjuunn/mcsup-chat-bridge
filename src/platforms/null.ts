/**
 * 空平台：只采集、不投递
 *
 * 用它可以验证分类与查询，而不产生日志噪音；也是「先接采集，后接平台」
 * 的默认占位。
 */

import type { ChatPlatform, PlatformFactory } from "./types.js";

export const nullPlatformFactory: PlatformFactory = {
  id: "null",
  title: "空平台",
  description: "丢弃所有投递，仅保留采集与查询",
  create() {
    return {
      id: "null",
      title: "空平台",
      start() {},
      deliver() {},
      stop() {},
    } satisfies ChatPlatform;
  },
};