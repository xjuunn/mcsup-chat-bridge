/**
 * 把扫码登录脚本复制进产物目录。
 *
 * `mcsup-plugin build` 只编译 TypeScript 并生成 manifest / descriptor，不会
 * 带走仓库里的 `.mjs`。安装向导要拉起插件的登录脚本，因此构建后再把
 * `scripts/weixin-login.mjs` 与它依赖的 `scripts/lib/qr.mjs` 复制到
 * `build/setup/`，保持相对路径 `./lib/qr.mjs` 不变。
 */

import { cpSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "build", "setup");

mkdirSync(path.join(out, "lib"), { recursive: true });
cpSync(path.join(root, "scripts", "weixin-login.mjs"), path.join(out, "weixin-login.mjs"));
cpSync(path.join(root, "scripts", "lib", "qr.mjs"), path.join(out, "lib", "qr.mjs"));