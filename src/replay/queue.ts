import { createLogger } from '../logger';

const log = createLogger('queue');

type Job = { name: string; run: () => Promise<void> };

/**
 * 解析ジョブのシンプルなインメモリキュー。
 * 解析自体は子プロセスで行われるためイベントループはブロックされないが、
 * CPU/メモリ負荷を抑えるため同時実行数を制限する。
 */
export class JobQueue {
  private queue: Job[] = [];
  private running = 0;

  constructor(private readonly concurrency: number) {}

  get pending(): number {
    return this.queue.length;
  }

  /** キューに追加し、待ち順（0 = すぐ実行）を返す */
  push(name: string, run: () => Promise<void>): number {
    this.queue.push({ name, run });
    const position = this.queue.length - 1 + Math.max(0, this.running - this.concurrency + 1);
    this.drain();
    return position;
  }

  private drain(): void {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      log.info(`start job ${job.name}`);
      job
        .run()
        .catch((e) => log.error(`job ${job.name} failed`, e))
        .finally(() => {
          this.running--;
          log.info(`end job ${job.name}`);
          this.drain();
        });
    }
  }
}
