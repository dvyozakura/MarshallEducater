// 国語の縦書きのための Markdown の拡張記法(DECISIONS.md「縦書きの記法」)。読み取りはこのファイルだけで行う。
// 壊れた記法(閉じていない・知らない種類)は、元の文字のまま残す(落ちない)。
//
//   ルビ           {漢字|かんじ}
//   傍線           {{傍線:ア|本文}}      記号は省略可 {{傍線|本文}}
//   波線           {{波線:a|本文}}
//   二重傍線       {{二重傍線:1|本文}}
//   傍点           {{傍点|本文}}
//   空欄           {{空欄:A}}           字数つき {{空欄:A:5}}
//   段落番号       {{段落:1}}
//   語注(本文側)   {{注:1|語}}
//   語注(注の文)   {{注記:1|説明}}
//   縦中横(明示)   {{縦中横|!?}}         2桁までの数字は縦書きのとき自動
//   再読文字       {{再読:未|いまダ|ず}}  右に1回目の読み、左に2回目の読み
//   漢文の区切り   :::漢文 白文 / :::漢文 訓読文 / :::漢文 書き下し文  …  :::
//   (訓読文の中だけ) 字[_送り仮名] 字[^返り点]   例: 登[_リ][^レ]山[_ニ]
//
// 使い方: protectNotation で記法を目印に置き換え → Markdown を HTML にする → restoreNotation で目印を HTML に戻す。

export const KANBUN_KINDS = ['白文', '訓読文', '書き下し文'] as const;
export type KanbunKind = (typeof KANBUN_KINDS)[number];

const LINE_KINDS: Record<string, string> = { 傍線: 'solid', 波線: 'wavy', 二重傍線: 'double' };
const KNOWN = new Set(['傍線', '波線', '二重傍線', '傍点', '空欄', '段落', '注', '注記', '縦中横', '再読']);

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface Protected {
  text: string;
  /** 目印の番号 → HTML(中にほかの目印を含むことがある)。 */
  pieces: string[];
}

const mark = (pieces: string[], html: string) => {
  pieces.push(html);
  return `MENOTE${pieces.length - 1}END`;
};

/** 中身の文字列を HTML に(目印はそのまま残す)。 */
const inner = (s: string) => escapeHtml(s);

/** ルビの置き換え。base・ruby とも改行・波かっこ・縦棒を含まない。 */
function protectRuby(text: string, pieces: string[]): string {
  return text.replace(/(?<!\{)\{([^{}|\n]{1,30})\|([^{}|\n]{1,40})\}/g, (_m, base: string, rt: string) =>
    mark(pieces, `<ruby class="nt-ruby">${inner(base)}<rt>${inner(rt)}</rt></ruby>`),
  );
}

function renderDouble(kind: string, label: string | undefined, rest: string | undefined, raw: string, pieces: string[]): string {
  const body = rest ?? '';
  switch (kind) {
    case '傍線':
    case '波線':
    case '二重傍線': {
      if (!rest) return raw;
      const open = `<span class="nt-line nt-line-${LINE_KINDS[kind]}" data-label="${escapeHtml(label ?? '')}">`;
      if (!label) return mark(pieces, `${open}<span class="nt-line-text">${inner(body)}</span></span>`);
      // 記号と本文の1文字目は改行で離さない
      const m = /^(MENOTE\d+END|[\s\S])([\s\S]*)$/u.exec(body)!;
      return mark(
        pieces,
        `${open}<span class="nt-nobr"><span class="nt-label">${inner(label)}</span><span class="nt-line-text">${inner(m[1])}</span></span>${m[2] ? `<span class="nt-line-text">${inner(m[2])}</span>` : ''}</span>`,
      );
    }
    case '傍点':
      if (!rest) return raw;
      return mark(pieces, `<span class="nt-dots">${inner(body)}</span>`);
    case '空欄': {
      if (rest !== undefined) return raw;
      const [name, len] = (label ?? '').split(':');
      const n = Math.max(1, Math.min(40, Number(len) || 3));
      return mark(pieces, `<span class="nt-blank" data-len="${n}" style="--nt-len:${n}">${inner(name ?? '')}</span>`);
    }
    case '段落':
      if (!label || rest !== undefined) return raw;
      return mark(pieces, `<span class="nt-para">${inner(label)}</span>`);
    case '注':
      if (!label || !rest) return raw;
      return mark(pieces, `<span class="nt-noted">${inner(body)}<span class="nt-noteref">*${inner(label)}</span></span>`);
    case '注記':
      if (!label || !rest) return raw;
      return mark(pieces, `<span class="nt-notedef"><span class="nt-noteref">*${inner(label)}</span> ${inner(body)}</span>`);
    case '縦中横':
      if (!rest) return raw;
      return mark(pieces, `<span class="tcy">${inner(body)}</span>`);
    case '再読': {
      // {{再読:未|いまダ|ず}} → label = 未、rest = 「いまダ|ず」
      const parts = (rest ?? '').split('|');
      if (!label || parts.length !== 2 || !parts[0] || !parts[1]) return raw;
      return mark(
        pieces,
        `<span class="nt-saidoku"><ruby class="nt-ruby">${inner(label)}<rt>${inner(parts[0])}</rt></ruby><span class="kb-ann"><span class="kb-okuri"></span><span class="kb-left">${inner(parts[1])}</span></span></span>`,
      );
    }
    default:
      return raw;
  }
}

/** {{種類:記号|本文}} の置き換え(内側から順に。入れ子のルビ・傍点などは先に目印になっている)。 */
function protectDouble(text: string, pieces: string[]): string {
  let prev = '';
  let cur = text;
  // 入れ子({{傍線:ア|{{傍点|ここ}}を}})のため、変わらなくなるまで繰り返す
  for (let i = 0; i < 5 && cur !== prev; i++) {
    prev = cur;
    cur = cur.replace(/\{\{([^{}:|\n]+)(?::([^{}|\n]*))?(?:\|([^{}\n]*))?\}\}/g, (raw, kind: string, label: string | undefined, rest: string | undefined) => {
      if (!KNOWN.has(kind.trim())) return raw;
      return renderDouble(kind.trim(), label?.trim() || undefined, rest, raw, pieces);
    });
  }
  return cur;
}

/** 訓読文の1行を HTML に。字のあとの [_送り仮名] [^返り点] を、その字の注記にまとめる。 */
function kundokuLine(line: string): string {
  const tokens = line.match(/MENOTE\d+END|\[_[^\]\n]*\]|\[\^[^\]\n]*\]|[\s\S]/gu) ?? [];
  const units: Array<{ base: string; okuri: string; kaeri: string }> = [];
  for (const t of tokens) {
    const ok = /^\[_([^\]]*)\]$/.exec(t);
    const ka = /^\[\^([^\]]*)\]$/.exec(t);
    if (ok || ka) {
      if (units.length === 0) units.push({ base: '', okuri: '', kaeri: '' });
      const u = units[units.length - 1];
      if (ok) u.okuri += ok[1];
      else u.kaeri += ka![1];
    } else {
      units.push({ base: t, okuri: '', kaeri: '' });
    }
  }
  return units
    .map((u) => {
      const base = /^MENOTE\d+END$/.test(u.base) ? u.base : escapeHtml(u.base);
      if (!u.okuri && !u.kaeri) return base;
      return `<span class="kb-u">${base}<span class="kb-ann"><span class="kb-okuri">${escapeHtml(u.okuri)}</span><span class="kb-left kb-kaeri">${escapeHtml(u.kaeri)}</span></span></span>`;
    })
    .join('');
}

/** :::漢文 種類 … ::: の区切りを目印に。閉じていなければそのまま。 */
function protectKanbun(text: string, pieces: string[]): string {
  return text.replace(/(^|\n):::漢文[ \t]*([^\n]*)\n([\s\S]*?)\n:::[ \t]*(?=\n|$)/g, (raw, lead: string, kindRaw: string, body: string) => {
    const kind = kindRaw.trim().replace(/^書き下し$/, '書き下し文').replace(/^訓読$/, '訓読文') as KanbunKind;
    if (!(KANBUN_KINDS as readonly string[]).includes(kind)) return raw;
    const cls = kind === '白文' ? 'hakubun' : kind === '訓読文' ? 'kundoku' : 'kakikudashi';
    const lines = body.split('\n').map((l) => (kind === '訓読文' ? kundokuLine(l) : escapeHtml(l).replace(/MENOTE(\d+)END/g, 'MENOTE$1END')));
    const html = `<div class="kanbun kanbun-${cls}" data-kind="${kind}">${lines.join('<br>')}</div>`;
    return `${lead}\n\n${mark(pieces, html)}\n\n`;
  });
}

/** 記法を目印に置き換える(数式・コードは先に退避してあること)。 */
export function protectNotation(text: string): Protected {
  const pieces: string[] = [];
  let t = protectRuby(text, pieces);
  t = protectDouble(t, pieces);
  t = protectKanbun(t, pieces);
  return { text: t, pieces };
}

/** HTML の中の目印を元に戻す(入れ子も)。 */
export function restoreNotation(html: string, pieces: string[]): string {
  // 単独の段落になった漢文は <p> を外す
  let out = html.replace(/<p>\s*(MENOTE(\d+)END)\s*<\/p>/g, (m, tok: string, i: string) => (pieces[Number(i)]?.startsWith('<div') ? tok : m));
  for (let k = 0; k < 8 && /MENOTE\d+END/.test(out); k++) {
    out = out.replace(/MENOTE(\d+)END/g, (_m, i: string) => pieces[Number(i)] ?? '');
  }
  return out;
}

/** 記法の誤り(閉じていない・知らない種類・漢文の区切りの閉じ忘れ)。型検証のやり直しに使う。 */
export function notationErrors(text: string): string[] {
  const errors: string[] = [];
  if (!text) return errors;
  // 数式は対象外
  const src = text.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/g, '');
  const { text: rest } = protectNotation(src);
  for (const m of rest.matchAll(/\{\{([^{}\n]{0,30})/g)) {
    const kind = m[1].split(/[:|]/)[0].trim();
    if (!KNOWN.has(kind)) errors.push(`知らない記法「{{${kind}」(使えるのは ${[...KNOWN].join('・')})`);
    else errors.push(`記法「{{${m[1].slice(0, 20)}」の書き方が違います(閉じ忘れ・記号や本文の不足)`);
  }
  const opens = (rest.match(/(^|\n):::漢文/g) ?? []).length;
  if (opens > 0) errors.push('「:::漢文 種類」の区切りが閉じていないか、種類(白文・訓読文・書き下し文)が違います');
  // 訓読文の外の [_…] [^…] は誤りにしない(解説の中で「登[^レ]山」のように引用することがあり、表示は元の文字のまま)
  return [...new Set(errors)];
}

/**
 * 縦書き用: 2桁までの半角数字と「!?」などを縦中横にする。タグの中・KaTeX の中は触らない。
 */
export function applyTcy(html: string): string {
  const parts = html.split(/(<[^>]+>)/);
  let skipDepth = 0;
  let inTcy = 0;
  return parts
    .map((p) => {
      if (p.startsWith('<')) {
        if (skipDepth > 0) {
          if (/^<span\b/.test(p)) skipDepth++;
          else if (/^<\/span>/.test(p)) skipDepth--;
          return p;
        }
        if (/^<span\b[^>]*class="[^"]*\b(katex|math-error)\b/.test(p)) skipDepth = 1;
        if (/^<span\b[^>]*class="tcy"/.test(p)) inTcy++;
        else if (inTcy > 0 && /^<\/span>/.test(p)) inTcy--;
        return p;
      }
      if (skipDepth > 0 || inTcy > 0) return p;
      return p
        .replace(/(?<![0-9A-Za-z.,#&])([0-9]{1,2})(?![0-9A-Za-z.,;])/g, '<span class="tcy">$1</span>')
        .replace(/([!?]{2})/g, '<span class="tcy">$1</span>');
    })
    .join('');
}

// ───────── 組み方向 ─────────
export type WritingMode = 'vertical' | 'horizontal';

/** 国語系の科目(既定で縦書き)。 */
export function isKokugoSubject(name: string): boolean {
  return /国語|現代文|古文|漢文|古典/.test(name);
}

/** 科目の組み方向(設定が無ければ、国語系は縦書き・ほかは横書き)。 */
export function subjectWritingMode(subject: { name: string; writingMode?: WritingMode | null }): WritingMode {
  return subject.writingMode ?? (isKokugoSubject(subject.name) ? 'vertical' : 'horizontal');
}
