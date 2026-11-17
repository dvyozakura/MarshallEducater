import { useEffect, useState } from 'react';
import { SOURCE_KIND_LABEL, type Project, type SourceKind, type SourceMeta } from '../../shared/schema';
import { api, errorMessage } from '../api';
import { ErrorBox, Section } from '../components';
import { useNav } from '../nav';
import { isImageFile, isPdfFile, renderImage, renderPdf, type PageImage } from '../pdf';

const KINDS: SourceKind[] = ['past_exam', 'workbook', 'answer', 'mock_result'];

/**
 * 資料の取り込み: PDF か画像を選ぶ → 種類と科目を選ぶ → ページ画像にして保存。
 * testId が渡されたときは、そのテストへの「答案」として取り込む。
 */
export function Import({ projectId, subjectId: initialSubject, testId }: { projectId: string; subjectId?: string; testId?: string }) {
  const nav = useNav();
  const [project, setProject] = useState<Project | null>(null);
  const [subjectId, setSubjectId] = useState(initialSubject ?? '');
  const [kind, setKind] = useState<SourceKind>(testId ? 'answer' : 'past_exam');
  const [files, setFiles] = useState<File[]>([]);
  const [title, setTitle] = useState('');
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SourceMeta | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);

  useEffect(() => {
    api.getProject(projectId).then(
      (p) => {
        setProject(p);
        setSubjectId((s) => s || p.subjects[0]?.id || '');
      },
      (e) => setError(errorMessage(e)),
    );
  }, [projectId]);
  useEffect(() => () => thumbs.forEach((u) => URL.revokeObjectURL(u)), [thumbs]);

  const pick = (list: FileList | null) => {
    const picked = [...(list ?? [])];
    setFiles(picked);
    setResult(null);
    setError(null);
    if (picked[0] && !title) setTitle(picked[0].name.replace(/\.[^.]+$/, ''));
  };

  const problems: string[] = [];
  if (files.length === 0) problems.push('ファイルを選んでください');
  else if (files.some((f) => !isPdfFile(f) && !isImageFile(f))) problems.push('PDF か画像(JPG・PNG)を選んでください');
  else if (files.filter(isPdfFile).length > 1 || (files.some(isPdfFile) && files.length > 1)) problems.push('PDF は1つだけ選んでください(画像は複数選べます)');
  if (!subjectId) problems.push('科目を選んでください');

  const run = async () => {
    setError(null);
    setResult(null);
    setThumbs([]);
    const urls: string[] = [];
    let sourceId: string | null = null;
    try {
      setProgress('準備しています');
      const meta = await api.importBegin(projectId, subjectId, { kind, title, fileName: files[0].name, testId: testId ?? null });
      sourceId = meta.id;
      const save = async (page: PageImage, total: number) => {
        setProgress(`ページ ${page.pageNo} / ${total} を画像にして保存しています`);
        await api.importPage(projectId, subjectId, meta.id, page.pageNo, page.png, page.text);
        if (urls.length < 12) urls.push(URL.createObjectURL(new Blob([page.png.slice()], { type: 'image/png' })));
      };
      let pageCount = 0;
      if (isPdfFile(files[0])) {
        const bytes = new Uint8Array(await files[0].arrayBuffer());
        await api.importOriginal(projectId, subjectId, meta.id, bytes, 'original.pdf');
        pageCount = await renderPdf(bytes, save);
      } else {
        const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
        for (let i = 0; i < sorted.length; i++) {
          const ext = /\.png$/i.test(sorted[i].name) ? 'png' : 'jpg';
          await api.importOriginal(projectId, subjectId, meta.id, new Uint8Array(await sorted[i].arrayBuffer()), `original-${i + 1}.${ext}`);
          await save(await renderImage(sorted[i], i + 1), sorted.length);
        }
        pageCount = sorted.length;
      }
      const done = await api.importFinish(projectId, subjectId, meta.id, pageCount);
      setThumbs(urls);
      setResult(done);
    } catch (e) {
      urls.forEach((u) => URL.revokeObjectURL(u));
      setError(errorMessage(e));
      // 途中まで作った資料は残さない
      if (sourceId) await api.deleteSource(projectId, subjectId, sourceId).catch(() => {});
    } finally {
      setProgress(null);
    }
  };

  if (!project) return <div className="page"><ErrorBox message={error} /></div>;
  const busy = progress !== null;

  return (
    <div className="page narrow" data-testid="screen-import">
      <Section title={testId ? '紙の答案の取り込み' : '資料の取り込み'}>
        <div className="form">
          <label>
            <span>ファイル</span>
            <span>
              <input data-testid="import-file" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg" disabled={busy} onChange={(e) => pick(e.target.files)} />
              <div className="hint">PDF を1つ、または画像(JPG・PNG)を1枚以上。画像はファイル名の順にページになります。</div>
            </span>
          </label>
          <label>
            <span>種類</span>
            <select data-testid="import-kind" value={kind} disabled={busy || !!testId} onChange={(e) => setKind(e.target.value as SourceKind)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {SOURCE_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>科目</span>
            <select data-testid="import-subject" value={subjectId} disabled={busy || !!testId} onChange={(e) => setSubjectId(e.target.value)}>
              {project.subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>題名</span>
            <input data-testid="import-title" value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} placeholder="例: 2025年度 前期 数学" />
          </label>
        </div>
        <div className="hint">実在の入試問題などを取り込む場合は、ご自身で用意したものを使ってください。取り込んだ内容は、このパソコンのプロジェクトフォルダにだけ保存されます。</div>
        <div className="buttons">
          <button className="primary" data-testid="import-run" disabled={busy || problems.length > 0} onClick={() => void run()}>
            取り込む
          </button>
          {problems.length > 0 && files.length > 0 && <span className="hint" data-testid="import-problems">{problems.join(' / ')}</span>}
          {progress && (
            <span data-testid="import-progress">
              <span className="spinner" /> {progress}
            </span>
          )}
        </div>
        <ErrorBox message={error} testId="import-error" />
      </Section>

      {result && (
        <Section title="取り込みました" testId="import-result">
          <div data-testid="import-summary">
            「{result.title}」({SOURCE_KIND_LABEL[result.kind]}) … {result.pageCount} ページ
          </div>
          <div className="thumbs">
            {thumbs.map((u, i) => (
              <img key={u} src={u} alt={`ページ ${i + 1}`} className="thumb" data-testid="import-thumb" />
            ))}
          </div>
          <div className="buttons">
            <button className="primary" data-testid="import-open" onClick={() => nav.go({ screen: 'correction', projectId, subjectId, sourceId: result.id })}>
              Claude に読み取らせる(補正画面へ)
            </button>
            {!testId && (
              <button data-testid="import-to-sources" onClick={() => nav.go({ screen: 'subject', projectId, subjectId, tab: 'sources' })}>
                資料の一覧へ
              </button>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}
