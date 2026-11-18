// 印刷用の HTML(問題冊子・解答用紙・解説)を作り、PDF に出す。PDF 化そのものは Electron の印刷機能(外から渡される)。
import { existsSync } from 'node:fs';
import { renderMarkdown, svgToImgHtml } from '../shared/mdmath';
import { DIFFICULTY_LABEL, PROBLEM_FORMAT_LABEL, type Test } from '../shared/schema';
import type { AppCore } from './app';
import { getProject, getSubject } from './projects';
import { getTest, testPaths } from './tests';

/** main 側が、KaTeX の CSS の場所に置き換える目印。 */
export const KATEX_CSS_PLACEHOLDER = '{{KATEX_CSS_HREF}}';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const CSS = `
  @page { size: A4; margin: 16mm 15mm; }
  body { font-family: 'Yu Mincho', 'MS Mincho', 'Hiragino Mincho ProN', serif; font-size: 11pt; line-height: 1.8; color: #000; }
  h1 { font-size: 16pt; margin: 0 0 4pt; }
  .meta { font-size: 10pt; margin-bottom: 8pt; }
  .inst { border: 1px solid #000; padding: 6pt 10pt; margin: 8pt 0 14pt; font-size: 10pt; }
  .q { margin: 0 0 16pt; page-break-inside: avoid; }
  .q-head { font-weight: bold; }
  .q-head .pts { font-weight: normal; font-size: 9.5pt; margin-left: 6pt; }
  .q p { margin: 2pt 0; }
  .choices { margin: 4pt 0 0 0; padding-left: 0; list-style: none; }
  .choices li { margin: 1pt 0; display: flex; gap: 6pt; }
  .choices li p { margin: 0; }
  .figure-svg { max-width: 80mm; max-height: 70mm; display: block; margin: 4pt 0; }
  table { border-collapse: collapse; } th, td { border: 1px solid #000; padding: 2pt 6pt; }
  .name { display: flex; gap: 18pt; margin: 6pt 0 12pt; font-size: 10.5pt; }
  .name span { border-bottom: 1px solid #000; min-width: 50mm; display: inline-block; }
  .a { border: 1px solid #000; margin: 0 0 8pt; page-break-inside: avoid; display: flex; }
  .a-no { width: 20mm; border-right: 1px solid #000; padding: 4pt 6pt; font-weight: bold; font-size: 10.5pt; }
  .a-box { flex: 1; padding: 4pt 8pt; font-size: 9pt; color: #444; }
  .a.choice .a-box, .a.short .a-box { height: 14mm; }
  .a.essay .a-box { height: 70mm; }
  .sec { margin: 0 0 14pt; page-break-inside: avoid; }
  .sec h2 { font-size: 12pt; margin: 0 0 2pt; border-bottom: 1px solid #000; }
  .sec h3 { font-size: 10.5pt; margin: 6pt 0 0; }
  .footer { font-size: 8.5pt; color: #444; margin-top: 12pt; }
`;

export function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="${KATEX_CSS_PLACEHOLDER}"><style>${CSS}</style></head><body>${body}</body></html>`;
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
export const choiceMark = (i: number) => CIRCLED[i] ?? `(${i + 1})`;

/** 問題冊子。答え・解説は入れない。 */
export function bookletHtml(test: Test, subjectName: string): string {
  const total = test.problems.reduce((n, p) => n + p.points, 0);
  const qs = test.problems
    .map(
      (p) => `<div class="q"><div class="q-head">${esc(p.number)}<span class="pts">(${p.points} 点・${PROBLEM_FORMAT_LABEL[p.format]}・${DIFFICULTY_LABEL[p.difficulty]})</span></div>
      ${renderMarkdown(p.body)}
      ${p.figureSvg ? svgToImgHtml(p.figureSvg) : ''}
      ${p.choices.length ? `<ul class="choices">${p.choices.map((c, i) => `<li><span>${choiceMark(i)}</span><span>${renderMarkdown(c)}</span></li>`).join('')}</ul>` : ''}
      </div>`,
    )
    .join('\n');
  return htmlPage(
    test.title,
    `<h1>${esc(test.title)}</h1>
    <div class="meta">科目: ${esc(subjectName)} / 制限時間: ${test.timeLimitMin} 分 / 問題数: ${test.problems.length} 問 / 満点: ${total} 点</div>
    <div class="inst">${esc(test.instructions || '解答は解答用紙に書くこと。')}<br>選択式は番号で、短答は答えだけを、記述は考え方も書くこと。</div>
    ${qs}
    <div class="footer">MarshallEducater で作成(問題は Claude が作り、検算したものです)</div>`,
  );
}

/** 解答用紙。設問ごとの解答欄(形式に合わせた大きさ)。 */
export function answerSheetHtml(test: Test, subjectName: string): string {
  const boxes = test.problems
    .map((p) => {
      const hint = p.format === 'choice' ? `選んだ番号(${choiceMark(0)}〜${choiceMark(p.choices.length - 1)})` : p.format === 'short' ? '答え' : '考え方と答え';
      return `<div class="a ${p.format}"><div class="a-no">${esc(p.number)}</div><div class="a-box">${hint}</div></div>`;
    })
    .join('\n');
  return htmlPage(
    `${test.title} 解答用紙`,
    `<h1>${esc(test.title)} 解答用紙</h1>
    <div class="meta">科目: ${esc(subjectName)} / 制限時間: ${test.timeLimitMin} 分</div>
    <div class="name">実施日 <span>&nbsp;</span> かかった時間 <span>&nbsp;</span></div>
    ${boxes}
    <div class="footer">設問の番号の欄の中に、はっきり書いてください。書き終えたらスキャンか撮影をして、アプリの「紙の答案を出す」から取り込みます。</div>`,
  );
}

export type TestPdfKind = 'booklet' | 'answer_sheet';

/** 問題冊子・解答用紙を PDF にして、テストのフォルダに保存する。保存した場所を返す。 */
export async function exportTestPdf(core: AppCore, projectId: string, subjectId: string, testId: string, which: TestPdfKind): Promise<{ path: string }> {
  if (!core.printPdf) throw new Error('PDF の出力は、アプリの中でだけ使えます。');
  const test = getTest(core, projectId, subjectId, testId);
  const subjectName = getSubject(getProject(core, projectId), subjectId).name;
  const tp = testPaths(core, projectId, subjectId, testId);
  const out = which === 'booklet' ? tp.bookletPdf : tp.answerSheetPdf;
  await core.printPdf(which === 'booklet' ? bookletHtml(test, subjectName) : answerSheetHtml(test, subjectName), out);
  if (!existsSync(out)) throw new Error('PDF を保存できませんでした。');
  return { path: out };
}
