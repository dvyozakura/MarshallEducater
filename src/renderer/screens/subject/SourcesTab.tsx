import { useEffect, useState } from 'react';
import { SOURCE_KIND_LABEL, SOURCE_STATUS_LABEL, type SourceMeta } from '../../../shared/schema';
import { api, errorMessage } from '../../api';
import { Empty, ErrorBox } from '../../components';
import { useNav } from '../../nav';

/** 科目の資料の一覧。 */
export function SourcesTab({ projectId, subjectId }: { projectId: string; subjectId: string }) {
  const nav = useNav();
  const [sources, setSources] = useState<SourceMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = () => api.listSources(projectId, subjectId).then(setSources, (e) => setError(errorMessage(e)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, subjectId]);

  const remove = async (id: string) => {
    await api.deleteSource(projectId, subjectId, id);
    setConfirmDelete(null);
    void load();
  };

  return (
    <div data-testid="sources-tab">
      <div className="row">
        <button className="primary" data-testid="go-import" onClick={() => nav.go({ screen: 'import', projectId, subjectId })}>
          PDF・画像を取り込む
        </button>
        <span className="hint">「確定」した資料だけが、傾向の分析や類題づくりに使われます。</span>
      </div>
      <ErrorBox message={error} />
      {sources && sources.length === 0 && <Empty>まだ資料がありません。過去問や問題集の PDF を取り込むと、Claude が読み取ります。</Empty>}
      {(sources ?? []).map((s) => (
        <div key={s.id} className="list-item" data-testid="source-row" data-status={s.status}>
          <span className="badge">{SOURCE_KIND_LABEL[s.kind]}</span>
          <span className="grow">
            <strong>{s.title}</strong> <span className="muted">{s.pageCount} ページ</span>
          </span>
          <span className={`badge ${s.status === 'confirmed' ? 'good' : s.status === 'read' ? 'mid' : ''}`} data-testid="source-status">
            {SOURCE_STATUS_LABEL[s.status]}
          </span>
          <button className="small" data-testid="open-source" onClick={() => nav.go({ screen: 'correction', projectId, subjectId, sourceId: s.id })}>
            {s.status === 'imported' ? '読み取る' : '補正画面を開く'}
          </button>
          {confirmDelete === s.id ? (
            <>
              <button className="small danger" data-testid="delete-source-yes" onClick={() => void remove(s.id)}>
                本当に消す
              </button>
              <button className="small" onClick={() => setConfirmDelete(null)}>
                やめる
              </button>
            </>
          ) : (
            <button className="small" data-testid="delete-source" onClick={() => setConfirmDelete(s.id)}>
              消す
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
