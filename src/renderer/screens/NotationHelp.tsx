import { NOTATION_ITEMS, SAMPLE_GENDAIBUN, SAMPLE_KANBUN, SAMPLE_KOBUN } from '../../shared/notation_samples';
import { Md } from '../components';

/** 縦書きの記法の一覧と、現代文・古文・漢文の見本(自作)。補正画面・科目の設定から開く。 */
export function NotationHelp({ samples = true }: { samples?: boolean }) {
  return (
    <div className="notation-help" data-testid="notation-help">
      <table className="table notation-table">
        <thead>
          <tr>
            <th>表すもの</th>
            <th>書き方</th>
            <th>例</th>
            <th>縦書きでの表示</th>
          </tr>
        </thead>
        <tbody>
          {NOTATION_ITEMS.map((it) => (
            <tr key={it.name} data-testid="notation-row">
              <td>
                {it.name}
                {it.note && <div className="muted small">{it.note}</div>}
              </td>
              <td>
                <code style={{ whiteSpace: 'pre-wrap' }}>{it.syntax}</code>
              </td>
              <td>
                <code style={{ whiteSpace: 'pre-wrap' }}>{it.example}</code>
              </td>
              <td>
                <Md text={it.example} vertical height="7.5em" className="tate-mini" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {samples && (
        <div className="notation-samples">
          <h3>現代文の見本(自作)</h3>
          <Md text={SAMPLE_GENDAIBUN} vertical testId="sample-gendaibun" height="360px" />
          <h3>古文の見本(自作)</h3>
          <Md text={SAMPLE_KOBUN} vertical testId="sample-kobun" height="360px" />
          <h3>漢文の見本(自作。白文・訓読文・書き下し文)</h3>
          <Md text={SAMPLE_KANBUN} vertical testId="sample-kanbun" height="360px" />
        </div>
      )}
    </div>
  );
}
