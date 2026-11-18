// 教材の章の本文を、文章と図に分ける(画面と PDF 用の HTML の両方で使う)。
import type { ChapterFigure } from './schema';

export type BodyPart = { type: 'text'; text: string } | { type: 'figure'; figure: ChapterFigure };

/**
 * 本文の中の、その行だけの `[[図ID]]` を図に置き換える。
 * 図が見つからない目印は消す(図が捨てられた場合)。
 */
export function splitFigures(text: string, figures: ChapterFigure[]): BodyPart[] {
  const parts: BodyPart[] = [];
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join('\n').trim();
    if (t) parts.push({ type: 'text', text: t });
    buf = [];
  };
  for (const line of (text ?? '').split('\n')) {
    const m = line.match(/^[ \t]*\[\[([A-Za-z0-9_-]+)\]\][ \t]*$/);
    if (!m) {
      buf.push(line);
      continue;
    }
    const figure = figures.find((f) => f.id === m[1]);
    if (figure) {
      flush();
      parts.push({ type: 'figure', figure });
    }
  }
  flush();
  return parts;
}
