/** 终端二维码生成器的类型声明（供 test/*.ts 引用 scripts/lib/qr.mjs） */

/** 生成 QR 矩阵；`true` 为深色模块 */
export function qrMatrix(text: string): boolean[][];

export interface RenderOptions {
  /** 静默区宽度，单位为模块，默认 4 */
  quiet?: number;
}

/** 把矩阵渲染成带 ANSI 颜色与上下半块的终端文本 */
export function renderQrTerminal(matrix: boolean[][], options?: RenderOptions): string;

/** 文本 → 终端二维码 */
export function qrTerminal(text: string): string;