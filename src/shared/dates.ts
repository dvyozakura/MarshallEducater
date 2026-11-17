// 日付まわりの計算。日付は端末の時刻での "YYYY-MM-DD" 文字列で扱う(時刻・時差のずれを避ける)。

const pad = (n: number) => String(n).padStart(2, '0');

export function toDateString(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 今日。テストでは環境変数 ME_TODAY(YYYY-MM-DD)で差し替えられる。 */
export function todayString(): string {
  const fake = typeof process !== 'undefined' ? process.env?.ME_TODAY : undefined;
  if (fake && /^\d{4}-\d{2}-\d{2}$/.test(fake)) return fake;
  return toDateString(new Date());
}

export function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function toUtcDay(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

/** from から to までの日数(to が後なら正)。 */
export function daysBetween(from: string, to: string): number {
  return toUtcDay(to) - toUtcDay(from);
}

export function addDays(s: string, n: number): string {
  const dt = new Date(toUtcDay(s) * 86400000 + n * 86400000);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** 試験までの残り日数の表示。 */
export function daysLeftLabel(today: string, examDate: string): string {
  const n = daysBetween(today, examDate);
  if (n > 0) return `試験まであと ${n} 日`;
  if (n === 0) return '今日が試験日です';
  return `試験日を ${-n} 日過ぎています`;
}

export interface WeekRange {
  index: number;
  start: string;
  end: string;
}

/**
 * start(含む)から試験の前日(含む)までを、7日ごとの週に切る。最後の週は短くなることがある。
 * 試験日が今日以前なら、週は無い。
 */
export function splitWeeks(start: string, examDate: string, maxWeeks = 60): WeekRange[] {
  const weeks: WeekRange[] = [];
  const last = addDays(examDate, -1);
  let s = start;
  let i = 0;
  while (daysBetween(s, last) >= 0 && i < maxWeeks) {
    const e = daysBetween(addDays(s, 6), last) >= 0 ? addDays(s, 6) : last;
    weeks.push({ index: i, start: s, end: e });
    s = addDays(e, 1);
    i++;
  }
  return weeks;
}

export function formatDateJa(s: string): string {
  if (!isValidDateString(s)) return s;
  const [y, m, d] = s.split('-').map(Number);
  const w = ['日', '月', '火', '水', '木', '金', '土'][new Date(y, m - 1, d).getDay()];
  return `${y}年${m}月${d}日(${w})`;
}

/** 経過時間の表示(例: 1分05秒)。 */
export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) return `${Math.floor(m / 60)}時間${pad(m % 60)}分`;
  return m > 0 ? `${m}分${pad(s)}秒` : `${s}秒`;
}
