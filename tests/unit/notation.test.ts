import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/shared/mdmath';
import { applyTcy, isKokugoSubject, notationErrors, protectNotation, subjectWritingMode } from '../../src/shared/notation';

const html = (s: string, vertical = false) => renderMarkdown(s, { vertical });

describe('組み方向', () => {
  it('国語系は既定で縦書き、ほかは横書き。設定があればそれに従う', () => {
    for (const n of ['現代文', '古文', '漢文', '国語', '古典(古文・漢文)']) expect(subjectWritingMode({ name: n })).toBe('vertical');
    for (const n of ['数学II・B・C', '英語リーディング', '世界史']) expect(subjectWritingMode({ name: n })).toBe('horizontal');
    expect(subjectWritingMode({ name: '現代文', writingMode: 'horizontal' })).toBe('horizontal');
    expect(subjectWritingMode({ name: '物理', writingMode: 'vertical' })).toBe('vertical');
    expect(isKokugoSubject('化学')).toBe(false);
  });
});

describe('縦中横', () => {
  it('2桁までの数字だけを縦中横にする。3桁以上・英字・小数はそのまま', () => {
    const out = applyTcy('<p>7時12分、2026年、v2、3.14、Science</p>');
    expect(out).toContain('<span class="tcy">7</span>時<span class="tcy">12</span>分');
    expect(out).toContain('2026年');
    expect(out).not.toContain('<span class="tcy">20</span>');
    expect(out).toContain('v2');
    expect(out).toContain('3.14');
  });
  it('タグの属性・文字参照・KaTeX の中は触らない', () => {
    const out = applyTcy('<span class="nt-blank" style="--nt-len:5">A</span>&#39;<span class="katex" data-tex="x^2"><span>2</span></span>後に3');
    expect(out).toContain('style="--nt-len:5"');
    expect(out).toContain('&#39;');
    expect(out).toContain('<span>2</span></span>後に<span class="tcy">3</span>');
  });
  it('!? を縦中横に', () => {
    expect(applyTcy('<p>本当!?</p>')).toContain('<span class="tcy">!?</span>');
  });
  it('横書きでは縦中横にしない', () => {
    expect(html('午前7時')).not.toContain('tcy');
    expect(html('午前7時', true)).toContain('<span class="tcy">7</span>');
  });
});

describe('縦書きの記法', () => {
  it('ルビ', () => {
    expect(html('{漢字|かんじ}を読む')).toContain('<ruby class="nt-ruby">漢字<rt>かんじ</rt></ruby>を読む');
  });
  it('傍線・波線・二重傍線(記号つき・なし)', () => {
    const h = html('{{傍線:ア|最初の線}}と{{波線:a|波の線}}と{{二重傍線:1|二重の線}}と{{傍線|記号なし}}');
    // 記号と1文字目は改行で離さない
    expect(h).toContain('nt-line nt-line-solid" data-label="ア"><span class="nt-nobr"><span class="nt-label">ア</span><span class="nt-line-text">最</span></span><span class="nt-line-text">初の線</span>');
    expect(h).toContain('nt-line-wavy');
    expect(h).toContain('nt-line-double');
    expect(h).toContain('data-label=""><span class="nt-line-text">記号なし');
  });
  it('傍線の中のルビ・傍点(入れ子)', () => {
    const h = html('{{傍線:イ|{夕暮|ゆうぐ}れの{{傍点|空}}}}');
    expect(h).toContain('<span class="nt-label">イ</span><span class="nt-line-text"><ruby class="nt-ruby">夕暮<rt>ゆうぐ</rt></ruby></span></span><span class="nt-line-text">れの<span class="nt-dots">空</span></span>');
  });
  it('傍点・空欄(字数つき)・段落番号・語注・縦中横', () => {
    const h = html('{{段落:3}}{{傍点|ここ}}に{{空欄:A}}と{{空欄:B:5}}。{{注:1|語}}がある。{{縦中横|!!}}\n\n{{注記:1|語の説明。}}');
    expect(h).toContain('<span class="nt-para">3</span>');
    expect(h).toContain('<span class="nt-dots">ここ</span>');
    expect(h).toContain('data-len="3" style="--nt-len:3">A</span>');
    expect(h).toContain('data-len="5" style="--nt-len:5">B</span>');
    expect(h).toContain('<span class="nt-noted">語<span class="nt-noteref">*1</span></span>');
    expect(h).toContain('<span class="nt-notedef"><span class="nt-noteref">*1</span> 語の説明。</span>');
    expect(h).toContain('<span class="tcy">!!</span>');
  });
  it('漢文: 訓読文の送り仮名・返り点、再読文字、白文・書き下し文の区別', () => {
    // 自作の短文
    const src = [':::漢文 訓読文', '{{再読:未|いまダ|ず}}[^三]見[_ル][^二]春[_ノ]山[_ヲ][^一]。夜[_ニ]登[_ル][^レ]楼[_ニ]。', ':::', '', ':::漢文 白文', '夜登楼', ':::', '', ':::漢文 書き下し文', '夜に{楼|ろう}に登る。', ':::'].join('\n');
    const h = html(src, true);
    expect(h).toContain('<div class="kanbun kanbun-kundoku" data-kind="訓読文">');
    expect(h).toContain('<span class="kb-u">夜<span class="kb-ann"><span class="kb-okuri">ニ</span><span class="kb-left kb-kaeri"></span></span></span>');
    expect(h).toContain('<span class="kb-u">登<span class="kb-ann"><span class="kb-okuri">ル</span><span class="kb-left kb-kaeri">レ</span></span></span>');
    expect(h).toContain('<span class="kb-left kb-kaeri">一</span>');
    expect(h).toContain('<span class="nt-saidoku"><ruby class="nt-ruby">未<rt>いまダ</rt></ruby>');
    expect(h).toContain('<span class="kb-left">ず</span>');
    expect(h).toContain('data-kind="白文">夜登楼</div>');
    expect(h).toContain('data-kind="書き下し文">夜に<ruby class="nt-ruby">楼<rt>ろう</rt></ruby>に登る');
    // 漢文の div は <p> で包まない
    expect(h).not.toMatch(/<p>\s*<div class="kanbun/);
  });
  it('訓読文の外の [_..] [^..] は記法として扱わない', () => {
    expect(html('配列 a[_i] と x[^2]')).toContain('a[_i]');
  });
  it('横書きでも同じ記法が壊れずに出る', () => {
    const h = html('{{傍線:ア|本文}}と{漢字|かんじ}');
    expect(h).toContain('nt-line-text');
    expect(h).toContain('<rt>かんじ</rt>');
    expect(h).not.toContain('{{');
  });
  it('数式の中の {a|b} は記法にしない', () => {
    const h = html('集合 $\\{x|x>0\\}$ を考える');
    expect(h).not.toContain('nt-ruby');
    expect(h).toContain('katex');
  });
});

describe('壊れた記法', () => {
  it('閉じていない・知らない種類・中身の不足は元の文字のまま出す(落ちない)', () => {
    expect(html('{{傍線:ア|閉じていない')).toContain('{{傍線:ア|閉じていない');
    expect(html('{{太字|知らない}}')).toContain('{{太字|知らない}}');
    expect(html('{{傍線:ア}}')).toContain('{{傍線:ア}}');
    expect(html('{{再読:未|いまダ}}')).toContain('{{再読:未|いまダ}}');
    expect(html(':::漢文 訓読文\n学[_ブ]\n(閉じていない)')).toContain('学[_ブ]');
    expect(html(':::漢文 知らない\n学\n:::')).toContain(':::漢文 知らない');
    expect(() => html('{{{{}}}}{|}{{|}}:::漢文\n:::')).not.toThrow();
  });
  it('notationErrors で見つける(正しいものは0件)', () => {
    expect(notationErrors('{{傍線:ア|正しい}}{漢字|かんじ}\n\n:::漢文 訓読文\n学[_ブ]\n:::')).toEqual([]);
    expect(notationErrors('{{傍線:ア|閉じていない').length).toBe(1);
    expect(notationErrors('{{太字|知らない}}')[0]).toContain('知らない記法');
    expect(notationErrors(':::漢文 訓読文\n学')[0]).toContain('閉じていない');
    expect(notationErrors('学[_ブ]')[0]).toContain('訓読文');
    expect(notationErrors('数式 $\\{\\{x\\}\\}$ は対象外')).toEqual([]);
  });
  it('protectNotation は目印と部品の数が合う', () => {
    const p = protectNotation('{a|b}{{傍点|c}}');
    expect(p.pieces.length).toBe(2);
    expect(p.text).toBe('MENOTE0ENDMENOTE1END');
  });
});
