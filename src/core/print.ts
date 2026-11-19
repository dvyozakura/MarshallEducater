// 印刷用の HTML(問題冊子・解答用紙・解説)を作り、PDF に出す。PDF 化そのものは Electron の印刷機能(外から渡される)。
import { existsSync } from 'node:fs';
import { choiceMark } from '../shared/labels';
import { renderMarkdown, renderMarkdown as renderMd, svgToImgHtml } from '../shared/mdmath';
import { splitFigures } from '../shared/chapter';
import { DIFFICULTY_LABEL, MISTAKE_LABEL, PROBLEM_FORMAT_LABEL, type AnswerKey, type Chapter, type ChapterFigure, type Explanations, type Grading, type Reading, type Test } from '../shared/schema';
import { getReading } from './answers';
import type { AppCore } from './app';
import { effectiveScore, getAnswerKey, getGrading } from './grading';
import { getProject, getSubject, writingModeOf } from './projects';
import { Files, readData } from './store';
import { chapterFileId, getChapter, getTextbookView, textbookPaths } from './textbook';
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

export function htmlPage(title: string, body: string, vertical = false): string {
  return `<!doctype html><html lang="ja"${vertical ? ' class="tate"' : ''}><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="${KATEX_CSS_PLACEHOLDER}"><style>${CSS}${vertical ? TATE_CSS : ''}</style></head><body>${body}</body></html>`;
}

/**
 * 縦書き(国語)の印刷。ページ全体を縦書きにし、行は右から左、ページも右から左へ読む順(1ページ目が右端の行から)。
 * 記法(ルビ・傍線・返り点など)の見た目は画面と同じ。
 */
const TATE_CSS = `
  html.tate { writing-mode: vertical-rl; text-orientation: mixed; }
  html.tate body { line-height: 1.9; line-break: strict; }
  html.tate h1 { margin: 0 0 0 6pt; }
  html.tate .meta { margin: 0 0 0 8pt; }
  html.tate .inst { margin: 0 0 0 12pt; padding: 10pt 6pt; }
  html.tate .q { margin: 0 0 0 14pt; page-break-inside: auto; break-inside: auto; }
  html.tate .q-head { margin: 0 0 0 4pt; }
  html.tate .q p { margin: 0 0 0 2pt; text-indent: 1em; }
  html.tate .choices { margin: 0 0 0 4pt; }
  html.tate .choices li { margin: 0 0 0 2pt; display: block; }
  html.tate .choices li span:first-child { margin-bottom: 4pt; display: inline-block; }
  html.tate .choices li span + span p { display: inline; text-indent: 0; }
  html.tate .katex, html.tate .figure-svg, html.tate table { writing-mode: horizontal-tb; }
  html.tate .katex { display: inline-block; }
  .tcy { text-combine-upright: all; }
  .nt-line-text { text-decoration-line: underline; text-decoration-thickness: 0.8pt; text-underline-offset: 0.2em; text-underline-position: right; }
  .nt-line-wavy .nt-line-text { text-decoration-style: wavy; }
  .nt-line-double .nt-line-text { text-decoration-style: double; }
  .nt-label { font-size: 0.65em; font-family: 'Yu Gothic', 'MS Gothic', sans-serif; border: 0.6pt solid #000; padding: 0 1pt; margin: 2pt 0; text-combine-upright: all; text-indent: 0; }
  .nt-nobr, .kb-u, .nt-saidoku { white-space: nowrap; }
  .nt-dots { text-emphasis: filled sesame; -webkit-text-emphasis: filled sesame; text-emphasis-position: over right; -webkit-text-emphasis-position: over right; }
  .nt-blank { display: inline-block; inline-size: calc(var(--nt-len, 3) * 1em); border: 0.8pt solid #000; text-align: center; font-family: 'Yu Gothic', 'MS Gothic', sans-serif; font-weight: bold; text-orientation: upright; margin: 0 2pt; line-height: 1.4; text-indent: 0; }
  .nt-para { display: inline-block; font-size: 0.7em; border: 0.6pt solid #000; border-radius: 50%; text-align: center; text-combine-upright: all; margin: 0 0 3pt 0; text-indent: 0; }
  .nt-noteref { font-size: 0.6em; text-combine-upright: all; }
  .nt-notedef { font-size: 0.9em; }
  .kanbun { line-height: 2.4; letter-spacing: 0.1em; margin: 0 0 0 4pt; }
  .kb-ann { display: inline-flex; flex-direction: column; font-size: 0.5em; line-height: 1.15; letter-spacing: 0; text-indent: 0; }
  .kb-okuri, .kb-left { min-block-size: 1.15em; white-space: nowrap; position: relative; }
  .kb-okuri { left: 0.55em; }
  .kb-left { left: -0.55em; }
  /* 解答用紙 */
  html.tate .name { margin: 0 0 0 12pt; display: block; }
  html.tate .name span { border-bottom: none; border-left: 1px solid #000; min-width: 0; min-height: 40mm; }
  html.tate .a { margin: 0 0 0 6pt; display: block; border: 1px solid #000; }
  html.tate .a-no { width: auto; border-right: none; border-bottom: none; border-left: 1px solid #000; padding: 6pt 3pt; text-align: start; }
  html.tate .a-box { padding: 6pt 4pt; color: #000; }
  .marks { display: block; }
  .mark { display: inline-block; width: 7mm; height: 7mm; border: 0.8pt solid #000; border-radius: 50%; text-align: center; line-height: 7mm; font-size: 9pt; margin: 2pt 0; text-orientation: upright; font-family: 'Yu Gothic', 'MS Gothic', sans-serif; }
  .masu { display: block; block-size: auto; }
  .masu span { display: inline-block; width: 7.5mm; height: 7.5mm; border: 0.5pt solid #000; margin: 0 0 -0.5pt -0.5pt; box-sizing: border-box; }
  .rules { display: block; inline-size: 120mm; block-size: 60mm; background: repeating-linear-gradient(to left, transparent 0, transparent 9.5mm, #000 9.5mm, #000 10mm); border: 0.8pt solid #000; }
  .a-hint { font-size: 8.5pt; color: #444; }
  .a-count { font-size: 8.5pt; }
`;

const KANSUJI: Record<string, number> = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 漢数字(四十、百二十、二百 など)を数にする。読めなければ NaN。 */
export function kanjiNumber(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let cur = 0;
  for (const ch of s) {
    if (ch in KANSUJI) cur = cur * 10 + KANSUJI[ch];
    else if (ch === '十' || ch === '百') {
      const unit = ch === '十' ? 10 : 100;
      total += (cur || 1) * unit;
      cur = 0;
    } else return NaN;
  }
  return total + cur;
}

/** 設問の文から、字数指定(「四十字以内」「80字程度」など)を読む。無ければ null。 */
export function charLimit(text: string): number | null {
  const m = text.normalize('NFKC').match(/([0-9]+|[〇一二三四五六七八九十百]+)字(?:以内|以上|程度|前後|で|まで)/);
  if (!m) return null;
  const n = kanjiNumber(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 1000 ? n : null;
}


/** 問題冊子。答え・解説は入れない。 */
export function bookletHtml(test: Test, subjectName: string, vertical = false): string {
  const total = test.problems.reduce((n, p) => n + p.points, 0);
  const md = (t: string) => renderMarkdown(t, { vertical });
  const qs = test.problems
    .map(
      (p) => `<div class="q"><div class="q-head">${esc(p.number)}<span class="pts">(${p.points} 点・${PROBLEM_FORMAT_LABEL[p.format]}・${DIFFICULTY_LABEL[p.difficulty]})</span></div>
      ${md(p.body)}
      ${p.figureSvg ? svgToImgHtml(p.figureSvg) : ''}
      ${p.choices.length ? `<ul class="choices">${p.choices.map((c, i) => `<li><span>${choiceMark(i)}</span><span>${md(c)}</span></li>`).join('')}</ul>` : ''}
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
    vertical,
  );
}

/** 縦書きの解答用紙の1欄: 選択式はマーク欄、字数指定のある記述はそのマス目、指定なしは罫線。 */
function tateAnswerBox(p: Test['problems'][number]): string {
  let inner: string;
  if (p.format === 'choice') {
    const n = Math.max(2, p.choices.length);
    inner = `<div class="a-hint">マーク欄(一つ塗る)</div><div class="marks">${Array.from({ length: n }, (_x, i) => `<span class="mark">${i + 1}</span>`).join('')}</div>`;
  } else {
    const limit = charLimit(p.body);
    if (limit !== null) {
      const cols = Math.ceil(limit / 20);
      inner = `<div class="a-count">${limit}字</div><div class="masu" data-cells="${cols * 20}" style="height:${20 * 7.5}mm">${'<span></span>'.repeat(cols * 20)}</div>`;
    } else {
      inner = `<div class="a-hint">${p.format === 'short' ? '答え' : '考え方と答え'}</div><div class="rules" style="${p.format === 'short' ? 'inline-size:60mm;block-size:20mm' : ''}"></div>`;
    }
  }
  return `<div class="a ${p.format}"><div class="a-no">${esc(p.number)}</div><div class="a-box">${inner}</div></div>`;
}

/** 解答用紙。設問ごとの解答欄(形式に合わせた大きさ)。縦書き(国語)ならマーク欄・マス目・罫線。 */
export function answerSheetHtml(test: Test, subjectName: string, vertical = false): string {
  if (vertical) {
    return htmlPage(
      `${test.title} 解答用紙`,
      `<h1>${esc(test.title)} 解答用紙</h1>
      <div class="meta">科目: ${esc(subjectName)} / 制限時間: ${test.timeLimitMin} 分</div>
      <div class="name">実施日 <span>&nbsp;</span> かかった時間 <span>&nbsp;</span></div>
      ${test.problems.map(tateAnswerBox).join('\n')}
      <div class="footer">設問の欄の中に、はっきり書いてください。マス目は右の行の上から書きます。書き終えたらスキャンか撮影をして、アプリの「紙の答案を出す」から取り込みます。</div>`,
      true,
    );
  }
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

/** 解説(間違えた問題ごとに、問題・自分の答案・正解・考え方・解き方・一言)。 */
export function explanationsHtml(test: Test, subjectName: string, grading: Grading, key: AnswerKey, reading: Reading | null, ex: Explanations): string {
  const label = (p: Test['problems'][number], answer: string) => {
    if (!answer.trim()) return '(未解答)';
    const n = Number(answer.normalize('NFKC').match(/\d+/)?.[0] ?? NaN);
    return p.format === 'choice' && Number.isFinite(n) && p.choices[n - 1] !== undefined ? `${choiceMark(n - 1)} ${p.choices[n - 1]}` : answer;
  };
  const total = grading.items.reduce((n, i) => n + effectiveScore(i), 0);
  const max = grading.items.reduce((n, i) => n + i.max, 0);
  const secs = test.problems
    .map((p) => {
      const e = ex.items.find((i) => i.problemId === p.id);
      const g = grading.items.find((i) => i.problemId === p.id);
      if (!e || !g) return '';
      const k = key.items.find((i) => i.problemId === p.id);
      const answer = reading?.answers.find((a) => a.problemId === p.id)?.answer ?? '';
      return `<div class="sec"><h2>${esc(p.number)}(${esc(p.unitName)}・${effectiveScore(g)} / ${g.max} 点${g.mistake ? `・${MISTAKE_LABEL[g.mistake]}` : ''})</h2>
      ${renderMarkdown(p.body)}
      ${p.figureSvg ? svgToImgHtml(p.figureSvg) : ''}
      ${p.choices.length ? `<ul class="choices">${p.choices.map((c, i) => `<li><span>${choiceMark(i)}</span><span>${renderMarkdown(c)}</span></li>`).join('')}</ul>` : ''}
      <h3>あなたの答案</h3>${renderMarkdown(label(p, answer))}
      <h3>正解</h3>${renderMarkdown(label(p, k?.answer ?? ''))}
      <h3>考え方</h3>${renderMarkdown(e.thinking)}
      <h3>解き方</h3>${renderMarkdown(e.solution)}
      <h3>同じミスを防ぐ一言</h3>${renderMarkdown(e.tip)}
      </div>`;
    })
    .join('\n');
  return htmlPage(
    `${test.title} 解説`,
    `<h1>${esc(test.title)} 解説</h1>
    <div class="meta">科目: ${esc(subjectName)} / 得点: ${total} / ${max} 点 / 解説のある設問: ${ex.items.length} 問</div>
    ${secs}
    <div class="footer">MarshallEducater で作成(解説は Claude が書いたものです)</div>`,
  );
}

// ───────── 教材 ─────────

function bodyHtml(text: string, figures: ChapterFigure[], vertical = false): string {
  return splitFigures(text, figures)
    .map((part) => (part.type === 'text' ? renderMd(part.text, { vertical }) : `${svgToImgHtml(part.figure.svg, part.figure.caption || '図')}${part.figure.caption ? `<div class="cap">${esc(part.figure.caption)}</div>` : ''}`))
    .join('\n');
}

/** 教材の1章ぶん(導入 → 要点 → 例題 → よくある誤り →(補足)→ 確認問題)。 */
function chapterSectionHtml(ch: Chapter, no: number, vertical = false): string {
  const renderMarkdown = (t: string) => renderMd(t, { vertical });
  const name = ch.title.split(' > ').at(-1) ?? ch.title;
  const choices = (list: string[]) => (list.length ? `<ul class="choices">${list.map((c, i) => `<li><span>${choiceMark(i)}</span><span>${renderMarkdown(c)}</span></li>`).join('')}</ul>` : '');
  const answer = (e: Chapter['examples'][number]) => {
    const n = Number(e.answer.normalize('NFKC').match(/\d+/)?.[0] ?? NaN);
    return e.format === 'choice' && Number.isFinite(n) && e.choices[n - 1] !== undefined ? `${choiceMark(n - 1)} ${e.choices[n - 1]}` : e.answer;
  };
  const examples = ch.examples
    .map(
      (e, i) => `<div class="ex"><div class="q-head">例題${i + 1}<span class="pts">(${DIFFICULTY_LABEL[e.difficulty]}・${PROBLEM_FORMAT_LABEL[e.format]})</span></div>
      ${e.focus.trim() ? `<div class="focus">ねらい: ${esc(e.focus.trim())}</div>` : ''}
      ${renderMarkdown(e.body)}${e.figureSvg ? svgToImgHtml(e.figureSvg) : ''}${choices(e.choices)}
      <h3>解答</h3>${renderMarkdown(answer(e))}
      <h3>解説</h3>${renderMarkdown(e.solution || '(解説なし)')}</div>`,
    )
    .join('\n');
  const supplements = ch.supplements.length
    ? `<h2>補足(質問から)</h2>${ch.supplements.map((s) => `<h3>${esc(s.title)}</h3>${renderMarkdown(s.markdown)}`).join('\n')}`
    : '';
  const quiz = ch.quiz.length
    ? ch.quiz
        .map(
          (q, i) => `<div class="q"><div class="q-head">確認問題 ${i + 1}<span class="pts">(${q.points} 点・${PROBLEM_FORMAT_LABEL[q.format]}・${DIFFICULTY_LABEL[q.difficulty]})</span></div>
          ${renderMarkdown(q.body)}${q.figureSvg ? svgToImgHtml(q.figureSvg) : ''}${choices(q.choices)}</div>`,
        )
        .join('\n')
    : '<p>(この版には、確認問題がありません)</p>';
  return `<article class="chapter">
    <h1>${no > 0 ? `第${no}章 ` : ''}${esc(name)}</h1>
    <div class="meta">${esc(ch.title)} / 第 ${ch.chapterVersion} 版(${esc(ch.updatedAt.slice(0, 10))})</div>
    <h2>導入</h2>${bodyHtml(ch.intro, ch.figures, vertical)}
    <h2>要点</h2>${bodyHtml(ch.points, ch.figures, vertical)}
    <h2>例題</h2>${examples}
    <h2>よくある誤り</h2>${bodyHtml(ch.pitfalls, ch.figures, vertical)}
    ${supplements}
    <h2>確認問題</h2>${quiz}
    <div class="footer">確認問題の答え合わせは、アプリの「確認問題を解く」から行います(採点して苦手マップに反映します)。</div>
  </article>`;
}

const TEXTBOOK_CSS = `
  .chapter { page-break-after: always; }
  .chapter:last-of-type { page-break-after: auto; }
  .chapter h2 { font-size: 13pt; margin: 14pt 0 4pt; border-bottom: 1px solid #000; }
  .chapter h3 { font-size: 11pt; margin: 8pt 0 2pt; }
  .ex { border: 1px solid #000; padding: 6pt 10pt; margin: 0 0 10pt; }
  .focus { font-size: 9.5pt; color: #333; }
  .cap { font-size: 9pt; color: #333; margin: 0 0 6pt; }
  .toc { margin: 0 0 14pt; padding-left: 0; list-style: none; page-break-after: always; }
  html.tate .chapter h2 { border-bottom: none; border-left: 1px solid #000; margin: 0 0 0 6pt; padding-left: 3pt; }
  html.tate .chapter h3 { margin: 0 0 0 3pt; }
  html.tate .ex { margin: 0 0 0 8pt; padding: 8pt 6pt; }
  html.tate .toc { margin: 0; }
`;

/** 教材の章(1章だけ、または科目全体)を、印刷用の HTML にする。 */
export function textbookHtml(subjectName: string, chapters: Array<{ chapter: Chapter; no: number }>, whole: boolean, vertical = false): string {
  const title = whole ? `${subjectName} 教材` : `${subjectName} 教材 ${chapters[0] ? `第${chapters[0].no}章` : ''}`;
  const toc = whole
    ? `<h1>${esc(subjectName)} 教材</h1><div class="meta">作成済みの章: ${chapters.length} 章</div><ul class="toc">${chapters.map((c) => `<li>第${c.no}章 ${esc(c.chapter.title)}</li>`).join('')}</ul>`
    : '';
  return htmlPage(title, `<style>${TEXTBOOK_CSS}</style>${toc}${chapters.map((c) => chapterSectionHtml(c.chapter, c.no, vertical)).join('\n')}<div class="footer">MarshallEducater で作成(本文は Claude が書き、別の呼び出しで点検したものです。例題と確認問題は検算済みです)</div>`, vertical);
}

/** 教材を PDF にして、textbook/pdf/ に保存する。unitId を渡すとその章だけ、null なら作成済みの章すべて。保存した場所を返す。 */
export async function exportTextbookPdf(core: AppCore, projectId: string, subjectId: string, unitId: string | null): Promise<{ path: string; chapters: number }> {
  if (!core.printPdf) throw new Error('PDF の出力は、アプリの中でだけ使えます。');
  const view = getTextbookView(core, projectId, subjectId);
  const tb = textbookPaths(core, projectId, subjectId);
  const rows = view.chapters.filter((c) => c.chapterVersion > 0 && (unitId === null ? !c.orphan : c.unitId === unitId));
  const chapters = rows
    .map((r) => ({ chapter: getChapter(core, projectId, subjectId, r.unitId), no: r.no }))
    .filter((c): c is { chapter: Chapter; no: number } => c.chapter !== null);
  if (chapters.length === 0) throw new Error(unitId === null ? 'まだ作った章がありません。先に章を作ってください。' : 'この章は、まだ作っていません。');
  const out = unitId === null ? tb.allPdf : tb.chapterPdf(chapterFileId(unitId));
  await core.printPdf(textbookHtml(view.subjectName, chapters, unitId === null, writingModeOf(core, projectId, subjectId) === 'vertical'), out);
  if (!existsSync(out)) throw new Error('PDF を保存できませんでした。');
  return { path: out, chapters: chapters.length };
}

export type TestPdfKind = 'booklet' | 'answer_sheet' | 'explanations';

/** 問題冊子・解答用紙を PDF にして、テストのフォルダに保存する。保存した場所を返す。 */
export async function exportTestPdf(core: AppCore, projectId: string, subjectId: string, testId: string, which: TestPdfKind): Promise<{ path: string }> {
  if (!core.printPdf) throw new Error('PDF の出力は、アプリの中でだけ使えます。');
  const test = getTest(core, projectId, subjectId, testId);
  const subjectName = getSubject(getProject(core, projectId), subjectId).name;
  const tp = testPaths(core, projectId, subjectId, testId);
  let html: string;
  let out: string;
  if (which === 'explanations') {
    const grading = getGrading(core, projectId, subjectId, testId);
    if (!grading || !existsSync(tp.explanationsJson)) throw new Error('解説がまだありません。採点のあとに、解説を作ってください。');
    html = explanationsHtml(test, subjectName, grading, getAnswerKey(core, projectId, subjectId, testId), getReading(core, projectId, subjectId, testId), readData(tp.explanationsJson, Files.explanations));
    out = tp.explanationsPdf;
  } else {
    const vertical = writingModeOf(core, projectId, subjectId) === 'vertical';
    html = which === 'booklet' ? bookletHtml(test, subjectName, vertical) : answerSheetHtml(test, subjectName, vertical);
    out = which === 'booklet' ? tp.bookletPdf : tp.answerSheetPdf;
  }
  await core.printPdf(html, out);
  if (!existsSync(out)) throw new Error('PDF を保存できませんでした。');
  return { path: out };
}
