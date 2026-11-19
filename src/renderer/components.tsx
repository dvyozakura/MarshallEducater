import 'katex/dist/katex.min.css';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { madeByLabel, type MadeBy } from '../shared/engines';
import { renderMarkdown, svgToImgHtml } from '../shared/mdmath';

/** Markdown+数式(KaTeX)+縦書きの記法の表示。vertical なら縦書きの表示部品(Tate)に入れる。 */
export function Md({ text, className, testId, vertical, height }: { text: string; className?: string; testId?: string; vertical?: boolean; height?: string }) {
  const html = useMemo(() => renderMarkdown(text, { vertical }), [text, vertical]);
  if (vertical) return <Tate html={html} className={className} testId={testId} height={height} />;
  return <div className={`md ${className ?? ''}`} data-testid={testId} dangerouslySetInnerHTML={{ __html: html }} />;
}

const TATE_FS_KEY = 'me.tateFontSize';
const TATE_FS = [14, 16, 18, 20, 24, 28];
function readTateFs(): number {
  const v = Number(globalThis.localStorage?.getItem(TATE_FS_KEY));
  return TATE_FS.includes(v) ? v : 18;
}
const fsListeners = new Set<(n: number) => void>();

/** 縦書きの文字の大きさ(アプリ全体で1つ。localStorage に保存)。 */
export function useTateFontSize(): [number, (n: number) => void] {
  const [fs, setFs] = useState(readTateFs);
  useEffect(() => {
    fsListeners.add(setFs);
    return () => void fsListeners.delete(setFs);
  }, []);
  const set = useCallback((n: number) => {
    globalThis.localStorage?.setItem(TATE_FS_KEY, String(n));
    for (const l of fsListeners) l(n);
  }, []);
  return [fs, set];
}

/** 縦書きの文字の大きさの切り替え(小さく/大きく)。 */
export function TateFontControl() {
  const [fs, set] = useTateFontSize();
  const i = TATE_FS.indexOf(fs);
  return (
    <span className="tate-fs" data-testid="tate-fs">
      <button className="small" data-testid="tate-fs-down" disabled={i <= 0} onClick={() => set(TATE_FS[Math.max(0, i - 1)])} title="文字を小さく">
        A−
      </button>
      <span className="muted" data-testid="tate-fs-value">{fs}px</span>
      <button className="small" data-testid="tate-fs-up" disabled={i >= TATE_FS.length - 1} onClick={() => set(TATE_FS[Math.min(TATE_FS.length - 1, i + 1)])} title="文字を大きく">
        A+
      </button>
    </span>
  );
}

/**
 * 縦書きの表示部品。行は右から左へ進み、横方向に読み進める。
 * ホイール(下へ回す = 先へ=左へ)、矢印キー(↓←: 先へ、↑→: 戻る)、PageUp/PageDown、Home(先頭=右端)/End(末尾=左端)。
 */
export function Tate({ html, className, testId, height }: { html: string; className?: string; testId?: string; height?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fs] = useTateFontSize();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : -e.deltaX;
      if (!d) return;
      e.preventDefault();
      el.scrollLeft -= d;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const line = fs * 2;
    const page = Math.max(line, el.clientWidth - line * 2);
    const end = -(el.scrollWidth - el.clientWidth);
    const moves: Record<string, () => number> = {
      ArrowDown: () => el.scrollLeft - line,
      ArrowLeft: () => el.scrollLeft - line,
      ArrowUp: () => el.scrollLeft + line,
      ArrowRight: () => el.scrollLeft + line,
      PageDown: () => el.scrollLeft - page,
      ' ': () => el.scrollLeft - page,
      PageUp: () => el.scrollLeft + page,
      Home: () => 0,
      End: () => end,
    };
    const m = moves[e.key];
    if (!m) return;
    e.preventDefault();
    el.scrollLeft = Math.max(end, Math.min(0, m()));
  };
  return (
    <div
      ref={ref}
      className={`md tate ${className ?? ''}`}
      data-testid={testId}
      data-writing="vertical"
      tabIndex={0}
      onKeyDown={onKey}
      style={{ fontSize: `${fs}px`, height: height ?? undefined }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Claude が描いた図(SVG)。スクリプトが動かないよう img として表示する。 */
export function SvgFigure({ svg }: { svg: string | null | undefined }) {
  const html = useMemo(() => (svg ? svgToImgHtml(svg) : ''), [svg]);
  if (!html) return null;
  return <div className="figure" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function ErrorBox({ message, testId }: { message: string | null | undefined; testId?: string }) {
  if (!message) return null;
  return (
    <div className="errorbox" data-testid={testId ?? 'error'} role="alert">
      {message}
    </div>
  );
}

export function Section({ title, children, actions, testId }: { title: string; children: ReactNode; actions?: ReactNode; testId?: string }) {
  return (
    <section className="section" data-testid={testId}>
      <div className="section-head">
        <h2>{title}</h2>
        <div className="section-actions">{actions}</div>
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** 習熟度などの横棒。 */
export function Meter({ value, max = 100, label }: { value: number; max?: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const tone = pct >= 70 ? 'good' : pct >= 40 ? 'mid' : 'low';
  return (
    <span className="meter" title={label}>
      <span className={`meter-fill ${tone}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

/** どのエンジン・モデルで作ったかの小さな印。記録が無ければ何も出さない。 */
export function MadeByTag({ madeBy, what, testId }: { madeBy: MadeBy | null | undefined; what?: string; testId?: string }) {
  if (!madeBy) return null;
  return (
    <span className="madeby" data-testid={testId ?? 'madeby'} data-engine={madeBy.engine} title="作ったエンジン・モデル">
      {what ? `${what}: ` : ''}
      {madeByLabel(madeBy)}
    </span>
  );
}
