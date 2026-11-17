import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from '../fsutil';

/** 端末の日付(YYYY-MM-DD)。 */
export function localDateString(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 1日あたりの Claude 呼び出し回数を数える。数は `usage.json` に残し、アプリを起動し直しても続きから数える。
 */
export class DailyLimiter {
  constructor(
    private readonly file: string,
    private readonly getLimit: () => number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private read(): { date: string; count: number } {
    const today = localDateString(this.now());
    if (existsSync(this.file)) {
      try {
        const v = JSON.parse(readFileSync(this.file, 'utf8'));
        if (v && v.date === today && Number.isFinite(v.count)) return { date: today, count: v.count };
      } catch {
        /* 壊れていたら 0 から数え直す */
      }
    }
    return { date: today, count: 0 };
  }

  /** 今日これまでに使った回数。 */
  used(): number {
    return this.read().count;
  }

  limit(): number {
    return this.getLimit();
  }

  /** 1回ぶん使う。上限に達していたら false(数は増やさない)。 */
  tryConsume(): boolean {
    const s = this.read();
    if (s.count >= this.getLimit()) return false;
    writeFileAtomic(this.file, JSON.stringify({ date: s.date, count: s.count + 1 }));
    return true;
  }
}
