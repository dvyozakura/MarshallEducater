import 'katex/dist/katex.min.css';
import { useMemo, type ReactNode } from 'react';
import { madeByLabel, type MadeBy } from '../shared/engines';
import { renderMarkdown, svgToImgHtml } from '../shared/mdmath';

/** Markdown+数式(KaTeX)の表示。 */
export function Md({ text, className, testId }: { text: string; className?: string; testId?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`md ${className ?? ''}`} data-testid={testId} dangerouslySetInnerHTML={{ __html: html }} />;
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
