import { useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { NotationHelp } from './screens/NotationHelp';

interface Insert {
  label: string;
  testId: string;
  title: string;
  /** 選んだ文字列から、置き換える文字列と、置いたあとに選ぶ範囲(置き換えた文字列の中の位置)を作る。 */
  make: (sel: string) => { text: string; select?: [number, number] };
}

const wrap = (open: string, close: string, placeholder: string) => (sel: string) => {
  const inner = sel || placeholder;
  return { text: `${open}${inner}${close}`, select: [open.length, open.length + inner.length] as [number, number] };
};

/** よく使う縦書きの記法を入れるボタン(補正画面)。選んだ文字列を囲む。 */
export const NOTATION_INSERTS: Insert[] = [
  {
    label: 'ルビ',
    testId: 'ins-ruby',
    title: '選んだ漢字にふりがなを付ける {漢字|かんじ}',
    make: (sel) => {
      const base = sel || '漢字';
      const text = `{${base}|よみ}`;
      return { text, select: [base.length + 2, base.length + 4] };
    },
  },
  { label: '傍線', testId: 'ins-bousen', title: '{{傍線:ア|本文}}', make: wrap('{{傍線:ア|', '}}', '本文') },
  { label: '波線', testId: 'ins-hasen', title: '{{波線:a|本文}}', make: wrap('{{波線:a|', '}}', '本文') },
  { label: '傍点', testId: 'ins-bouten', title: '{{傍点|本文}}', make: wrap('{{傍点|', '}}', '本文') },
  { label: '空欄', testId: 'ins-kuuran', title: '{{空欄:A}}', make: () => ({ text: '{{空欄:A}}', select: [5, 6] }) },
  { label: '段落番号', testId: 'ins-danraku', title: '{{段落:1}}', make: () => ({ text: '{{段落:1}}', select: [5, 6] }) },
  { label: '返り点', testId: 'ins-kaeri', title: '字のあとに [^レ](訓読文の中だけ)', make: () => ({ text: '[^レ]', select: [2, 3] }) },
  { label: '送り仮名', testId: 'ins-okuri', title: '字のあとに [_ル](訓読文の中だけ)', make: () => ({ text: '[_ル]', select: [2, 3] }) },
  {
    label: '漢文(訓読文)',
    testId: 'ins-kanbun',
    title: ':::漢文 訓読文 … :::',
    make: (sel) => {
      const inner = sel || '本文';
      return { text: `\n:::漢文 訓読文\n${inner}\n:::\n`, select: [12, 12 + inner.length] };
    },
  },
];

/** テキスト欄の選んだ範囲を置き換える。 */
export function applyInsert(value: string, start: number, end: number, ins: Insert): { value: string; selStart: number; selEnd: number } {
  const sel = value.slice(start, end);
  const r = ins.make(sel);
  const next = value.slice(0, start) + r.text + value.slice(end);
  const [a, b] = r.select ?? [r.text.length, r.text.length];
  return { value: next, selStart: start + a, selEnd: start + b };
}

export function NotationButtons({ target, onChange }: { target: RefObject<HTMLTextAreaElement | null>; onChange: (value: string) => void }) {
  const [help, setHelp] = useState(false);
  return (
    <div className="notation-buttons" data-testid="notation-buttons">
      <span className="muted small">記法:</span>
      {NOTATION_INSERTS.map((ins) => (
        <button
          key={ins.testId}
          className="small"
          data-testid={ins.testId}
          title={ins.title}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const el = target.current;
            if (!el) return;
            const r = applyInsert(el.value, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, ins);
            // 値を入れ替えて描き直してから、その場で選び直す
            flushSync(() => onChange(r.value));
            el.focus();
            el.setSelectionRange(r.selStart, r.selEnd);
          }}
        >
          {ins.label}
        </button>
      ))}
      <button className="small" data-testid="notation-help-open" onClick={() => setHelp((v) => !v)}>
        {help ? '一覧を閉じる' : '記法の一覧'}
      </button>
      {help && <NotationHelp samples={false} />}
    </div>
  );
}

/** 補正画面の縦書きのプレビュー: 本文のあとに選択肢を番号つきで並べる。 */
export function verticalPreviewText(body: string, choices: string): string {
  const list = choices
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? `${body}\n\n${list.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : body;
}
