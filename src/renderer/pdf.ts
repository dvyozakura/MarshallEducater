// PDF・画像を、ページごとの PNG にする(画面側の canvas で描く)。
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** ページ画像の長い辺の大きさ(ピクセル)。Claude が読むのに十分で、大きすぎない値。暫定。 */
export const PAGE_LONG_SIDE = 1800;

export interface PageImage {
  pageNo: number;
  png: Uint8Array;
  /** PDF に文字の層があれば、その文字(読み取りの助け)。 */
  text: string;
  width: number;
  height: number;
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('ページ画像を作れませんでした');
  return new Uint8Array(await blob.arrayBuffer());
}

const assetBase = new URL('./pdfjs/', document.baseURI).toString();

/** PDF の各ページを PNG にして、1枚できるたびに onPage に渡す。戻り値はページ数。 */
export async function renderPdf(data: Uint8Array, onPage: (page: PageImage, total: number) => Promise<void>): Promise<number> {
  const task = pdfjs.getDocument({
    data: data.slice(),
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    wasmUrl: `${assetBase}wasm/`,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'PasswordException') throw new Error('パスワードのかかった PDF は取り込めません。パスワードを外してから取り込んでください。');
    throw new Error(`PDF を開けませんでした(壊れているか、PDF ではないファイルです): ${(e as Error).message}`);
  }
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = PAGE_LONG_SIDE / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('描画の準備ができませんでした');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      let text = '';
      try {
        const content = await page.getTextContent();
        text = content.items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('');
      } catch {
        /* 文字の層が読めなくても画像はある */
      }
      const png = await canvasToPng(canvas);
      await onPage({ pageNo: n, png, text, width: canvas.width, height: canvas.height }, doc.numPages);
      page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    }
    return doc.numPages;
  } finally {
    void task.destroy();
  }
}

/** 画像ファイル(JPG/PNG)を、1ページぶんの PNG にする。大きすぎる画像は縮める。 */
export async function renderImage(file: Blob, pageNo: number): Promise<PageImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('画像を開けませんでした(JPG か PNG のファイルを選んでください)');
  }
  const scale = Math.min(1, (PAGE_LONG_SIDE * 1.2) / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('描画の準備ができませんでした');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const png = await canvasToPng(canvas);
  return { pageNo, png, text: '', width: canvas.width, height: canvas.height };
}

export function isPdfFile(file: File): boolean {
  return /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
}
export function isImageFile(file: File): boolean {
  return /\.(png|jpe?g)$/i.test(file.name) || /^image\/(png|jpeg)$/.test(file.type);
}
