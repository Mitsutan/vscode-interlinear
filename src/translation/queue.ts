/**
 * 優先度付きの実行キュー。
 * - 同時実行数をサーバーのスロット数に合わせて制限する
 * - 同じキーのタスクは1つにまとめる（同じ段落を二重に訳さない）
 * - 優先度の高い要求が来たら、待機中のタスクの優先度を引き上げる
 * - 取り消しは「待機中」のタスクだけ。実行中のものは最後まで走らせて結果をキャッシュに残す
 */

export const Priority = {
  /** ホバーなど、ユーザーが結果を待っている */
  Interactive: 0,
  /** 画面に表示されているコメントの先読み */
  Visible: 1,
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

interface Task<T> {
  key: string;
  priority: Priority;
  seq: number;
  run: (signal: AbortSignal) => Promise<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  controller: AbortController;
  refs: number;
  state: 'queued' | 'running';
}

export interface TaskHandle<T> {
  readonly promise: Promise<T>;
  /** この要求を取り消す。同じキーを待っている要求が他になく、まだ始まっていなければタスクも取り消す */
  cancel(): void;
}

export class TaskQueue {
  private concurrency: number;
  private readonly tasks = new Map<string, Task<unknown>>();
  private readonly queued: Task<unknown>[] = [];
  private running = 0;
  private seq = 0;
  private readonly listeners = new Set<() => void>();

  constructor(concurrency: number) {
    this.concurrency = Math.max(1, concurrency);
  }

  /** 待機中 + 実行中のタスク数 */
  get pending(): number {
    return this.tasks.size;
  }

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, n);
    this.pump();
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  run<T>(key: string, priority: Priority, fn: (signal: AbortSignal) => Promise<T>): TaskHandle<T> {
    let task = this.tasks.get(key) as Task<T> | undefined;
    if (task) {
      task.refs++;
      if (priority < task.priority) task.priority = priority;
    } else {
      let resolve!: (value: T) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // 誰も待っていない状態で失敗しても unhandled rejection にしない
      promise.catch(() => {});
      task = { key, priority, seq: this.seq++, run: fn, promise, resolve, reject, controller: new AbortController(), refs: 1, state: 'queued' };
      this.tasks.set(key, task as Task<unknown>);
      this.queued.push(task as Task<unknown>);
      this.emit();
    }
    this.pump();

    const t = task;
    let cancelled = false;
    return {
      promise: t.promise,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        t.refs--;
        if (t.refs <= 0 && t.state === 'queued') {
          const i = this.queued.indexOf(t as Task<unknown>);
          if (i >= 0) this.queued.splice(i, 1);
          this.tasks.delete(t.key);
          t.reject(new CancelledError());
          this.emit();
        }
      },
    };
  }

  /** すべて取り消す（設定変更時など）。実行中のものも中断する */
  clear(): void {
    for (const t of this.tasks.values()) {
      t.controller.abort();
      t.reject(new CancelledError());
    }
    this.tasks.clear();
    this.queued.length = 0;
    this.emit();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queued.length > 0) {
      let best = 0;
      for (let i = 1; i < this.queued.length; i++) {
        const a = this.queued[i]!;
        const b = this.queued[best]!;
        if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
      }
      const task = this.queued.splice(best, 1)[0]!;
      task.state = 'running';
      this.running++;
      // run が同期的に例外を投げても reject として扱う
      Promise.resolve()
        .then(() => task.run(task.controller.signal))
        .then(task.resolve, task.reject)
        .finally(() => {
          this.running--;
          // clear() 後に終わった古いタスクが、同じキーの新しいタスクを消さないようにする
          if (this.tasks.get(task.key) === task) this.tasks.delete(task.key);
          this.emit();
          this.pump();
        });
    }
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
