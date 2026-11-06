/**
 * llama-server を子プロセスとして起動・停止する。翻訳サービスからは TranslationBackend として使う。
 *
 * - 初めて使われたときに起動する（空いているポートを自動で選ぶので、他のアプリとポートが衝突しない）
 * - 一定時間使われなければ止めて、モデルが使っているメモリを空ける。次に使われたら起動し直す
 * - 短時間に何度も異常終了したら、起動し直すのをやめて理由を返す（壊れた状態で起動を繰り返さないため）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { LlamaClient, type ProbeResult } from '../core/llama-client.ts';
import type { TranslateRequest } from '../core/pfml3.ts';

export interface ManagedServerOptions {
  /** 使う llama-server のパス。用意できていなければ undefined */
  serverPath: () => Promise<string | undefined>;
  /** 使うモデル（GGUF）のパス。用意できていなければ undefined */
  modelPath: () => Promise<string | undefined>;
  /** 同時に処理するリクエスト数（llama-server の -np） */
  parallel: number;
  /** 最後に使われてから止めるまでの時間。0 なら止めない */
  idleTimeoutMs: number;
  log: (line: string) => void;
  /** モデルの読み込みを待つ上限 */
  startTimeoutMs?: number;
}

export class NotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotReadyError';
  }
}

const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES = 3;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ManagedServer {
  private readonly opts: ManagedServerOptions;
  private proc: ChildProcess | undefined;
  private client: LlamaClient | undefined;
  private starting: Promise<LlamaClient> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = 0;
  private crashes: number[] = [];
  private disposed = false;
  private readonly expectedExits = new WeakSet<ChildProcess>();

  constructor(opts: ManagedServerOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return this.client !== undefined;
  }

  /** 起動していなければ起動してから、状態を返す */
  async probe(): Promise<ProbeResult> {
    try {
      const client = await this.ensureStarted();
      return await client.probe();
    } catch (e) {
      return { status: 'unavailable', message: e instanceof Error ? e.message : String(e) };
    }
  }

  async translate(req: TranslateRequest, opts?: { signal?: AbortSignal }): Promise<{ text: string }> {
    const client = await this.ensureStarted();
    this.inFlight++;
    this.clearIdle();
    try {
      return await client.translate(req, opts);
    } finally {
      this.inFlight--;
      this.armIdle();
    }
  }

  /** 止める（次に使われたら起動し直す） */
  async stop(): Promise<void> {
    this.clearIdle();
    const proc = this.proc;
    this.proc = undefined;
    this.client = undefined;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    this.expectedExits.add(proc);
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    proc.kill();
    const killed = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
    if (!killed) proc.kill('SIGKILL');
  }

  /** 異常終了の記録を消して起動し直す（「再起動」コマンド用） */
  async restart(): Promise<ProbeResult> {
    this.crashes = [];
    await this.stop();
    return this.probe();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  private ensureStarted(): Promise<LlamaClient> {
    if (this.disposed) return Promise.reject(new NotReadyError('翻訳サーバーは停止しました'));
    if (this.client) return Promise.resolve(this.client);
    this.starting ??= this.start().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async start(): Promise<LlamaClient> {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    if (this.crashes.length >= MAX_CRASHES) {
      throw new NotReadyError('翻訳サーバーが短時間に何度も異常終了したため、起動を止めています。ログを確認してから再起動してください');
    }
    const server = await this.opts.serverPath();
    if (!server) throw new NotReadyError('llama-server がまだ用意されていません。セットアップを実行してください');
    const model = await this.opts.modelPath();
    if (!model) throw new NotReadyError('翻訳モデルがまだダウンロードされていません。セットアップを実行してください');

    const port = await freePort();
    const parallel = Math.max(1, this.opts.parallel);
    const args = [
      '-m', model,
      '--host', '127.0.0.1',
      '--port', String(port),
      '-c', String(4096 * parallel),
      '-np', String(parallel),
      '--alias', path.basename(model, '.gguf'),
    ];
    this.opts.log(`起動: ${server} ${args.join(' ')}`);
    // 共有ライブラリを llama-server と同じディレクトリから読ませるため、cwd もそこにする
    const proc = spawn(server, args, { cwd: path.dirname(server), stdio: ['ignore', 'pipe', 'pipe'] });
    const forward = (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim()) this.opts.log(line);
    };
    proc.stdout?.on('data', forward);
    proc.stderr?.on('data', forward);

    let spawnError: Error | undefined;
    proc.once('error', (e) => {
      spawnError = e;
      this.opts.log(`起動できませんでした: ${e.message}`);
    });
    proc.once('exit', (code, signal) => {
      this.opts.log(`終了しました（コード ${code ?? '-'}、シグナル ${signal ?? '-'}）`);
      if (!this.expectedExits.has(proc)) this.crashes.push(Date.now());
      if (this.proc === proc) {
        this.proc = undefined;
        this.client = undefined;
        this.clearIdle();
      }
    });

    const client = new LlamaClient(`http://127.0.0.1:${port}`);
    const deadline = Date.now() + (this.opts.startTimeoutMs ?? 180_000);
    for (;;) {
      if (spawnError) throw new NotReadyError(`llama-server を起動できません: ${spawnError.message}`);
      if (proc.exitCode !== null || proc.signalCode !== null) {
        throw new NotReadyError(`llama-server が起動直後に終了しました（コード ${proc.exitCode ?? proc.signalCode}）。ログを確認してください`);
      }
      const probe = await client.probe();
      if (probe.status === 'ok') break;
      if (Date.now() > deadline) {
        this.expectedExits.add(proc);
        proc.kill('SIGKILL');
        throw new NotReadyError('llama-server の起動がタイムアウトしました。ログを確認してください');
      }
      await sleep(250);
    }
    if (this.disposed) {
      this.expectedExits.add(proc);
      proc.kill();
      throw new NotReadyError('翻訳サーバーは停止しました');
    }
    this.proc = proc;
    this.client = client;
    this.armIdle();
    return client;
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.opts.idleTimeoutMs <= 0 || this.inFlight > 0 || !this.client) return;
    this.idleTimer = setTimeout(() => {
      this.opts.log('しばらく使われていないため停止します');
      void this.stop();
    }, this.opts.idleTimeoutMs);
    this.idleTimer.unref?.();
  }
}
