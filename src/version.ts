/**
 * 插件版本（单一来源）
 *
 * 发布时只改这里与 `package.json`，适配器的 User-Agent 跟着它走，避免出现
 * 「插件 0.1.27、QQ 适配器还报 0.1.15」这种漂移。构建产物里的版本仍由
 * `package.json` 决定（SDK 打包时读取），因此两处必须一致，测试会校验。
 */

export const PLUGIN_VERSION = "0.1.0";