/**
 * llama-server のネイティブ API (/completion) クライアント。
 * OpenAI 互換の /v1/completions ではなくこちらを使うのは、timings（prefill / 生成の内訳）が取れるため。
 */
import { STOP_SEQUENCES, buildPrompt, cleanOutput, type TranslateRequest } from './pfml3.ts';

export interface Timings {
  promptTokens: number;
  promptMs: number;
  predictedTokens: number;
  predictedMs: number;
  predictedPerSecond: number;
}

export interface TranslateResult {
  text: string;
  /** クライアントから見た往復時間 */
  wallMs: number;
  timings: Timings;
  /** n_predict に達して打ち切られた */
  truncated: boolean;
}

interface CompletionResponse {
  content: string;
  stop_type?: string;
  timings?: {
    prompt_n?: number;
    prompt_ms?: number;
    predicted_n?: number;
    predicted_ms?: number;
    predicted_per_second?: number;
  };
}

/** 接続先の状態 */
export type ProbeResult =
  | { status: 'ok'; model: string }
  /** llama-server だがモデルを読み込み中（/health が 503） */
  | { status: 'loading' }
  /** 応答はあるが llama-server ではない（同じポートを別のアプリが使っている） */
  | { status: 'not-llama' }
  | { status: 'unreachable' }
  /** 自動管理モードで、サーバーを用意できない（未セットアップ、起動失敗など）。message は利用者向けの説明 */
  | { status: 'unavailable'; message: string };

export class LlamaClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /**
   * 接続先が llama-server として使えるかを確かめる。
   * /health が {"status":"ok"} を返し、/props にモデルのパスがあるときだけ ok とする。
   */
  async probe(): Promise<ProbeResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    } catch {
      return { status: 'unreachable' };
    }
    const body = (await res.json().catch(() => undefined)) as { status?: unknown; error?: unknown } | undefined;
    if (res.status === 503 && body?.error !== undefined) return { status: 'loading' };
    if (!res.ok || body?.status !== 'ok') return { status: 'not-llama' };
    const model = await this.modelName();
    return model ? { status: 'ok', model } : { status: 'not-llama' };
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: signal ?? AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 読み込まれているモデルのファイル名（結果のラベルに使う） */
  async modelName(): Promise<string | undefined> {
    try {
      const res = await fetch(`${this.baseUrl}/props`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return undefined;
      const props = (await res.json()) as { model_path?: string };
      return props.model_path?.split(/[\\/]/).pop()?.replace(/\.gguf$/, '');
    } catch {
      return undefined;
    }
  }

  async translate(req: TranslateRequest, opts: { nPredict?: number; signal?: AbortSignal } = {}): Promise<TranslateResult> {
    const prompt = buildPrompt(req);
    // 出力トークン数の上限。言語ペアによって文字数とトークン数の比が変わるので、多めに見積もる。
    const nPredict = opts.nPredict ?? Math.min(2048, 64 + req.text.length * 2);

    const started = performance.now();
    const res = await fetch(`${this.baseUrl}/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        n_predict: nPredict,
        temperature: 0,
        stop: STOP_SEQUENCES,
        cache_prompt: true,
        stream: false,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(`llama-server ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as CompletionResponse;
    const wallMs = performance.now() - started;
    const t = body.timings ?? {};

    return {
      text: cleanOutput(body.content),
      wallMs,
      truncated: body.stop_type === 'limit',
      timings: {
        promptTokens: t.prompt_n ?? 0,
        promptMs: t.prompt_ms ?? 0,
        predictedTokens: t.predicted_n ?? 0,
        predictedMs: t.predicted_ms ?? 0,
        predictedPerSecond: t.predicted_per_second ?? 0,
      },
    };
  }
}
