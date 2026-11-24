/**
 * 平台适配器共用的运行时工具：退避抖动、可中断等待、错误文案
 *
 * 适配器都在「连不上就退避重连」的循环里跑，抖动与可中断 sleep 的语义必须
 * 一致，否则停止插件时某些平台会多等一个完整的退避周期。
 */

/** 退避抖动：±20%，避免多平台同时重连或同时重试打满出口 */
export function jitter(ms: number): number {
  return ms * (0.8 + Math.random() * 0.4);
}

/** 不可中断的延时；只用于「停止时给循环一个上限」这类场合 */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 可中断等待：任一 `signal` abort 时立即返回，不 reject。
 *
 * 适配器用它做退避等待，这样插件停止不需要等到退避结束。
 */
export async function abortableSleep(ms: number, ...signals: Array<AbortSignal | undefined>): Promise<void> {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.some((signal) => signal.aborted)) {
    return;
  }
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      for (const signal of active) {
        signal.removeEventListener("abort", done);
      }
      resolve();
    };
    timer = setTimeout(done, ms);
    timer.unref?.();
    for (const signal of active) {
      signal.addEventListener("abort", done, { once: true });
    }
  });
}

/**
 * 是不是 AbortSignal 引起的错误。
 *
 * 停止插件与请求超时都用 abort 打断 fetch，错误名分别是 `AbortError` 与
 * `TimeoutError`。这类错误必须原样抛出，不能被平台包装成「网络错误 status 0」
 * 再去重试：停止时重试只会拖住队列，超时重试又会再等满一个超时周期。
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError" || error.name === "TimeoutError";
}

/**
 * 错误文案。
 *
 * `fetch`（undici）的网络错误只有一句 `fetch failed`，真正原因（ENOTFOUND /
 * ECONNRESET / 证书错误）在 `cause` 里。日志里带上它，才能区分「没网」与
 * 「token / API 被拒绝」。
 */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message !== error.message) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code === undefined
      ? `${error.message}（${cause.message}）`
      : `${error.message}（${code}: ${cause.message}）`;
  }
  return error.message;
}