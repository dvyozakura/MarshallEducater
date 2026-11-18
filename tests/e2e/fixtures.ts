// テスト用の資料(PDF・画像)を、その場で自作する。実在の入試問題や教材の文章は使わない。
import type { ElectronApplication } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const page = (body: string, extraCss = '') => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>
  body { font-family: 'Yu Mincho', 'MS Mincho', serif; font-size: 13pt; line-height: 1.9; margin: 18mm; color: #000; background: #fff; }
  h1 { font-size: 16pt; } .q { margin: 0 0 14pt; } .frac { display: inline-block; text-align: center; vertical-align: middle; }
  .frac span { display: block; padding: 0 4px; } .frac .num { border-bottom: 1px solid #000; }
  .break { page-break-after: always; } ${extraCss}
</style></head><body>${body}</body></html>`;

/** 数式と図を含む、数学の問題(1ページ)。 */
export const MATH_HTML = page(`
  <h1>ダミー模試 数学(自作)</h1>
  <div class="q"><b>第1問</b>(配点 20) 2次方程式 x<sup>2</sup> − 5x + 6 = 0 を解け。</div>
  <div class="q"><b>第2問</b>(配点 30) 数列 {a<sub>n</sub>} が a<sub>1</sub> = 1, a<sub>n+1</sub> = 2a<sub>n</sub> + 1 を満たすとき、一般項を求めよ。</div>
  <div class="q"><b>第3問</b>(配点 50) 下の図の直角三角形 ABC で、AB = 3, BC = 4 のとき、
    sin A の値は <span class="frac"><span class="num">ア</span><span>イ</span></span> である。ア、イに当てはまる数を答えよ。
    <div><svg width="260" height="190" viewBox="0 0 260 190" xmlns="http://www.w3.org/2000/svg">
      <polygon points="30,160 230,160 230,30" fill="none" stroke="#000" stroke-width="2"/>
      <rect x="214" y="144" width="16" height="16" fill="none" stroke="#000"/>
      <text x="14" y="176" font-size="16">A</text><text x="236" y="176" font-size="16">B</text><text x="236" y="26" font-size="16">C</text>
      <text x="120" y="180" font-size="14">3</text><text x="238" y="100" font-size="14">4</text>
    </svg></div>
  </div>`);

/** 縦書きの国語(1ページ)。文章は自作。 */
export const KOKUGO_HTML = page(
  `
  <div class="tate">
    <p><b>第一問</b> 次の文章を読んで、後の問いに答えよ。</p>
    <p>朝の市場には、まだ名前のついていない一日が並んでいる。魚屋の主人は氷の上に銀色の魚を置きながら、今日の天気を客より先に決めてしまう。「昼から晴れるよ」と言えば、通りの人々は傘をたたむ。予報が外れても誰も怒らない。信じたのは空ではなく、その声だったからである。</p>
    <p>問一 傍線部「信じたのは空ではなく、その声だった」とはどういうことか。四十字以内で説明せよ。</p>
    <p>問二 筆者の考えに最も近いものを、次のア〜エから一つ選べ。 ア 天気予報は正確であるべきだ イ 人は言葉の主を信頼する ウ 市場は朝が最もにぎわう エ 傘は常に持ち歩くべきだ</p>
  </div>`,
  `.tate { writing-mode: vertical-rl; height: 235mm; }`,
);

const PARA = [
  'The small library at the edge of the town opened only three days a week, yet it was the busiest place Mika knew. People did not come merely to borrow books; they came to leave notes inside them. A reader who finished a novel would slip a short message between the last pages, and the next reader would answer it.',
  'Over the years these notes grew into slow conversations between strangers. One exchange about a gardening manual lasted eleven years and ended with an invitation to a wedding. The librarian, an old man named Mr. Arai, never removed a single note. He believed that a book was unfinished until someone had replied to it.',
  'When the town council proposed replacing the library with a digital kiosk, Mika collected two hundred notes and read them aloud at the meeting. Nobody spoke for a long time afterwards. The kiosk was installed in the end, but it stands inside the old library, and beside it there is a wooden box labelled: replies.',
];

/** 英文の長文(3ページ)。文章は自作。 */
export const ENGLISH_HTML = page(
  [1, 2, 3]
    .map(
      (n) => `<div class="${n < 3 ? 'break' : ''}">
        <h1>Dummy Reading Test (original text) — Page ${n}</h1>
        ${PARA.map((p) => `<p>${p}</p>`).join('')}
        ${PARA.map((p) => `<p>${p}</p>`).join('')}
        <p><b>Question ${n}.</b> According to the passage, why did people visit the library? Choose the best answer from (A) to (D).</p>
      </div>`,
    )
    .join(''),
  `body { font-family: 'Times New Roman', serif; font-size: 12pt; line-height: 1.6; }`,
);

/** 手書きの答案に見立てた画像のもと。 */
export function answerHtml(lines: string[]): string {
  return page(
    `<h1>解答用紙</h1>${lines.map((l) => `<div class="q">${l}</div>`).join('')}`,
    `body { font-family: 'Segoe Script', 'Yu Gothic', cursive; font-size: 20pt; margin: 10mm; }`,
  );
}

/** HTML を PDF にして保存する(Electron の印刷機能)。 */
export async function makePdf(app: ElectronApplication, html: string, outPath: string): Promise<string> {
  const base64 = await app.evaluate(async ({ BrowserWindow }, h) => {
    const win = new BrowserWindow({ show: false, width: 900, height: 1200 });
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(h)}`);
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
    win.destroy();
    return pdf.toString('base64');
  }, html);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(base64, 'base64'));
  return outPath;
}

/** HTML を画像(PNG か JPG)にして保存する。 */
export async function makeImage(app: ElectronApplication, html: string, outPath: string): Promise<string> {
  const jpeg = /\.jpe?g$/i.test(outPath);
  const base64 = await app.evaluate(
    async ({ BrowserWindow }, { h, asJpeg }) => {
      const win = new BrowserWindow({ show: false, x: -20000, y: -20000, width: 800, height: 1000, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
      win.showInactive();
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(h)}`);
      await new Promise((r) => setTimeout(r, 300));
      const img = await win.webContents.capturePage();
      win.destroy();
      return (asJpeg ? img.toJPEG(90) : img.toPNG()).toString('base64');
    },
    { h: html, asJpeg: jpeg },
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, Buffer.from(base64, 'base64'));
  return outPath;
}

/** 保存された PNG の大きさと、白紙でないか(暗い画素があるか)を調べる。 */
export async function inspectPng(app: ElectronApplication, file: string): Promise<{ width: number; height: number; darkRatio: number }> {
  return app.evaluate(({ nativeImage }, f) => {
    const img = nativeImage.createFromPath(f);
    const { width, height } = img.getSize();
    const bmp = img.toBitmap();
    let dark = 0;
    const step = 4 * 7;
    let n = 0;
    for (let i = 0; i + 2 < bmp.length; i += step) {
      n++;
      if (bmp[i] + bmp[i + 1] + bmp[i + 2] < 300) dark++;
    }
    return { width, height, darkRatio: n ? dark / n : 0 };
  }, file);
}

/** PDF のページ数と、中の文字を取り出す(pdf.js)。 */
export async function pdfInfo(file: string): Promise<{ pages: number; text: string }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { readFileSync } = await import('node:fs');
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), useSystemFonts: true });
  const doc = await task.promise;
  let text = '';
  for (let n = 1; n <= doc.numPages; n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    text += `${content.items.map((it) => ('str' in it ? it.str : '')).join('')} `;
  }
  const pages = doc.numPages;
  await task.destroy();
  // PDF の中では「力」などが部首用の別の文字コードになることがあるので、ならしておく
  return { pages, text: text.normalize('NFKC') };
}
