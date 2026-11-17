import { describe, expect, it } from 'vitest';
import { extractMath, isUsableSvg, mathErrors, renderMarkdown, svgToImgHtml } from '../../src/shared/mdmath';

describe('Markdown+数式の表示', () => {
  it('文中の数式 $...$ と、独立した数式 $$...$$ を KaTeX にする', () => {
    const html = renderMarkdown('漸化式 $a_{n+1} = 2a_n + 1$ を解け。\n\n$$\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$$');
    expect(html).toContain('class="katex"');
    expect(html).toContain('katex-display');
    expect(html).not.toContain('MEMATHSEG');
    expect(html).not.toContain('$a_{n+1}');
    expect((html.match(/class="katex"/g) ?? []).length).toBe(2);
  });

  it('\\( \\) と \\[ \\] の書き方も読める', () => {
    const { segments } = extractMath('値は \\(x^2\\) で、\\[ y = x + 1 \\]');
    expect(segments).toEqual([
      { tex: 'y = x + 1', display: true },
      { tex: 'x^2', display: false },
    ]);
  });

  it('Markdown の記号(_ や *)が数式を壊さない', () => {
    const html = renderMarkdown('$a_1 * b_2 * c_3$ と **太字** と $x_i$');
    expect(html).toContain('<strong>太字</strong>');
    expect(html).not.toContain('<em>');
    expect((html.match(/class="katex"/g) ?? []).length).toBe(2);
  });

  it('コードの中の $ は数式にしない。金額の $ も数式にしない', () => {
    expect(extractMath('`$x$` と\n```\n$y$\n```').segments).toHaveLength(0);
    expect(extractMath('It costs $5 and $10 in total.').segments).toHaveLength(0);
    expect(extractMath('価格は$100です').segments).toHaveLength(0);
  });

  it('誤った数式は例外にせず、赤字で元の式を見せる', () => {
    const html = renderMarkdown('これは $\\frac{1}{$ です');
    expect(html).toContain('math-error');
    expect(html).toContain('\\frac{1}{');
    expect(mathErrors('正しい $x^2$ と、誤り $\\frac{1}{$')).toHaveLength(1);
    expect(mathErrors('正しい $x^2$ だけ')).toHaveLength(0);
  });

  it('生の HTML は実行させずに文字として見せる。リンクは移動させない', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[リンク](https://example.com)');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a ');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('example.com');
  });

  it('表・箇条書き・改行が使える', () => {
    const html = renderMarkdown('1行目\n2行目\n\n- あ\n- い\n\n| x | y |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<br>');
    expect(html).toContain('<li>あ</li>');
    expect(html).toContain('<table>');
  });

  it('空や null でも落ちない', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null as unknown as string)).toBe('');
  });
});

describe('図(SVG)', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
  it('img の data URL として埋め込む(スクリプトが動かない)', () => {
    const html = svgToImgHtml(svg);
    expect(html.startsWith('<img')).toBe(true);
    expect(html).toContain('data:image/svg+xml');
    expect(html).not.toContain('<svg');
  });
  it('使える SVG かどうかの検査', () => {
    expect(isUsableSvg(svg)).toBe(true);
    expect(isUsableSvg(null)).toBe(false);
    expect(isUsableSvg('<svg>途中で切れた')).toBe(false);
    expect(isUsableSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')).toBe(false);
    expect(isUsableSvg('図は省略')).toBe(false);
    expect(svgToImgHtml('図は省略')).toBe('');
  });
});
