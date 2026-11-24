/**
 * 微信 Bot Token 的交互式安装字段
 *
 * 微信只能手机扫码签发 token，没有后台复制入口。安装向导遇到这个字段时不
 * 弹输入框，而是继承终端拉起插件（SDK 的 setup 模式），这里再以同一个 node
 * 运行打包后的登录脚本：
 *
 * - 脚本照常绘制终端二维码，扫码、PIN 输入都在当前终端完成；
 * - token 写进本函数自建的 0600 临时文件（脚本的 `--emit-token`），不打印；
 * - 返回值交给 SDK，由 SDK 写入宿主给的密钥文件。
 *
 * 插件本身仍然不落盘密钥：临时目录用完即删，配置由宿主写入。
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { SetupInteractiveContext } from "mcsup-plugin";

/** 打包后的登录脚本路径：`build/setup/weixin-login.mjs` */
export function weixinLoginScript(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // 构建后：build/dist/setup/weixin.js → build/setup/weixin-login.mjs
  return path.resolve(here, "..", "..", "setup", "weixin-login.mjs");
}

/** 拉起登录脚本，返回扫码签发的 token */
export function weixinInteractiveSetup(_ctx: SetupInteractiveContext): string {
  const script = weixinLoginScript();
  const dir = mkdtempSync(path.join(tmpdir(), "mcsup-weixin-"));
  const tokenFile = path.join(dir, "token");
  try {
    // stdio 继承：二维码必须直接画在用户终端上，PIN 也要能读键盘
    const result = spawnSync(
      process.execPath,
      [script, "--emit-token", `--token-file=${tokenFile}`],
      { stdio: "inherit" },
    );
    if (result.error !== undefined) {
      throw new Error(`无法运行微信登录脚本 ${script}：${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`微信登录未完成（退出码 ${result.status ?? "被信号终止"}）`);
    }
    const token = readFileSync(tokenFile, "utf8").trim();
    if (token === "") {
      throw new Error("微信登录脚本没有返回 token");
    }
    return token;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}