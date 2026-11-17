// Markdown+数式(LaTeX)を HTML にする。画面(renderer)と、PDF 用の HTML を作る main の両方で使う。
import katex from 'katex';
import { Marked } from 'marked';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // Claude や PDF 由来の文章に混ざった生の HTML は、実行させずに文字として見せる
    html(token) {
      return escapeHtml(token.text);
    },
    // リンクは画面を移動させない(文字として見せる)
    link(token) {
      const text = escapeHtml(token.text || token.href);
      return token.href && token.href !== token.text ? `${text} <span class="md-href">(${escapeHtml(token.href)})</span>` : text;
    },
    image(token) {
      return `<span class="md-image">[画像: ${escapeHtml(token.text || token.href)}]</span>`;
    },
  },
});

export interface MathSegment {
  tex: string;
  display: boolean;
}

/** 数式を1つ HTML にする。書き方が誤っていても例外にせず、赤字で元の式を見せる。 */
export function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: 'ignore', output: 'html' });
  } catch (e) {
    const msg = e instanceof Error ? e.message.replace(/^KaTeX parse error: /, '') : String(e);
    return `<span class="math-error" title="${escapeHtml(msg)}">${escapeHtml(display ? `$$${tex}$$` : `$${tex}$`)}</span>`;
  }
}

/**
 * 本文から数式を抜き出して目印に置き換える。コード(``` や `)の中は数式として扱わない。
 */
export function extractMath(src: string): { text: string; segments: MathSegment[] } {
  const segments: MathSegment[] = [];
  const keep: string[] = [];
  // コードを先に退避
  let text = src.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => {
    keep.push(m);
    return `\u0000K${keep.length - 1}\u0000`;
  });
  const put = (tex: string, display: boolean) => {
    segments.push({ tex: tex.trim(), display });
    return `MEMATHSEG${segments.length - 1}END`;
  };
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => put(tex, true));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex: string) => put(tex, true));
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex: string) => put(tex, false));
  text = text.replace(/(?<![\\$])\$(?!\s)([^$\n]+?)(?<![\s\\])\$(?!\d)/g, (_m, tex: string) => put(tex, false));
  text = text.replace(/\u0000K(\d+)\u0000/g, (_m, i: string) => keep[Number(i)]);
  return { text, segments };
}

/** Markdown+数式を HTML にする。 */
export function renderMarkdown(src: string): string {
  const { text, segments } = extractMath(src ?? '');
  let html = marked.parse(text, { async: false }) as string;
  html = html.replace(/MEMATHSEG(\d+)END/g, (_m, i: string) => {
    const seg = segments[Number(i)];
    return seg ? renderMath(seg.tex, seg.display) : '';
  });
  return html;
}

/** 数式の書き方の誤りを調べる(補正画面で使う)。誤りがあれば説明の一覧を返す。 */
export function mathErrors(src: string): string[] {
  const errors: string[] = [];
  for (const seg of extractMath(src ?? '').segments) {
    try {
      katex.renderToString(seg.tex, { displayMode: seg.display, throwOnError: true, strict: 'ignore' });
    } catch (e) {
      errors.push(`${seg.tex.slice(0, 40)}: ${e instanceof Error ? e.message.replace(/^KaTeX parse error: /, '') : String(e)}`);
    }
  }
  return errors;
}

/** Claude が描いた SVG を、スクリプトが動かない形(img の data URL)で埋め込む HTML にする。 */
export function svgToImgHtml(svg: string, alt = '図'): string {
  const cleaned = svg.trim();
  if (!/^<svg[\s>]/i.test(cleaned) || !/<\/svg>\s*$/i.test(cleaned)) return '';
  const encoded = encodeURIComponent(cleaned).replace(/'/g, '%27');
  return `<img class="figure-svg" alt="${escapeHtml(alt)}" src="data:image/svg+xml;charset=utf-8,${encoded}" />`;
}

/** SVG として最低限まともか(問題の図の検査に使う)。 */
export function isUsableSvg(svg: string | null | undefined): boolean {
  if (!svg) return false;
  const s = svg.trim();
  if (s.length < 20 || s.length > 200000) return false;
  if (!/^<svg[\s>]/i.test(s) || !/<\/svg>\s*$/i.test(s)) return false;
  if (/<script|onload=|onerror=|javascript:/i.test(s)) return false;
  return true;
}
