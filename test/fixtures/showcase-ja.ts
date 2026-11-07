/**
 * 非同期の処理を、指数バックオフで再試行する。
 *
 * 待ち時間は `baseDelayMs` から始まり、失敗するたびに 2 倍になる。
 * 多数のクライアントが一斉に再試行しないよう、ランダムな揺らぎを加える。
 *
 * @param operation - 呼び出す関数。例外を投げる間は再試行する。
 * @param maxAttempts - あきらめるまでに試す回数。
 * @param baseDelayMs - 最初の再試行までの待ち時間（ミリ秒）。
 * @returns 最初に成功したときの戻り値。
 * @throws すべて失敗した場合は、最後のエラー。
 */
export async function retry<T>(operation: () => Promise<T>, maxAttempts = 5, baseDelayMs = 200): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      // 最後の試行の後は待たない。もう再試行しないため。
      if (attempt === maxAttempts - 1) break;
      const jitter = Math.random() * baseDelayMs; // 多数のクライアントの再試行をばらけさせる
      await sleep(baseDelayMs * 2 ** attempt + jitter);
    }
  }
  throw lastError;
}

/** 指定したミリ秒が経ったら解決する。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 設定は JSON でログに出す。バグ報告にそのまま貼り付けられるように。
export function describeSettings(settings: Record<string, unknown>): string {
  return JSON.stringify(settings, null, 2); // インデントを 2 にすると、ログが読みやすい
}
