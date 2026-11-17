import { useEffect, useState } from 'react';
import type { UnitNode, Units } from '../../../shared/schema';
import { api, errorMessage } from '../../api';
import { ErrorBox, Md } from '../../components';
import { JobRow, useJobRunner } from '../../jobs';

const WEIGHT_LABEL = ['0 扱わない', '1 ふつう', '2 重点', '3 最重点'];

function newUnitId(): string {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** パス(添字の並び)で指した単元を書き換えた、新しいツリーを返す。 */
function updateAt(tree: UnitNode[], path: number[], fn: (n: UnitNode) => UnitNode | null): UnitNode[] {
  const [head, ...rest] = path;
  const out: UnitNode[] = [];
  tree.forEach((n, i) => {
    if (i !== head) return out.push(n);
    if (rest.length === 0) {
      const r = fn(n);
      if (r) out.push(r);
    } else {
      out.push({ ...n, children: updateAt(n.children, rest, fn) });
    }
  });
  return out;
}

function UnitRow({ node, path, onChange, depth }: { node: UnitNode; path: number[]; depth: number; onChange: (path: number[], fn: (n: UnitNode) => UnitNode | null) => void }) {
  return (
    <div className="unit" data-testid="unit-row" data-unit-id={node.id}>
      <div className={`unit-line depth-${depth} ${node.weight === 0 ? 'off' : ''}`}>
        <input className="unit-name" data-testid="unit-name" value={node.name} onChange={(e) => onChange(path, (n) => ({ ...n, name: e.target.value }))} />
        <select data-testid="unit-weight" value={node.weight} onChange={(e) => onChange(path, (n) => ({ ...n, weight: Number(e.target.value) }))}>
          {WEIGHT_LABEL.map((l, i) => (
            <option key={i} value={i}>
              {l}
            </option>
          ))}
        </select>
        {depth < 3 && (
          <button
            className="small"
            data-testid="unit-add-child"
            onClick={() => onChange(path, (n) => ({ ...n, children: [...n.children, { id: newUnitId(), name: '新しい単元', weight: 1, children: [] }] }))}
          >
            下に足す
          </button>
        )}
        <button className="small danger" data-testid="unit-delete" onClick={() => onChange(path, () => null)}>
          消す
        </button>
      </div>
      {node.children.map((c, i) => (
        <UnitRow key={c.id} node={c} path={[...path, i]} depth={depth + 1} onChange={onChange} />
      ))}
    </div>
  );
}

/** 科目の単元ツリー: Claude による調整と、手での編集。 */
export function UnitsTab({ projectId, subjectId }: { projectId: string; subjectId: string }) {
  const [units, setUnits] = useState<Units | null>(null);
  const [tree, setTree] = useState<UnitNode[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    try {
      const u = await api.getUnits(projectId, subjectId);
      setUnits(u);
      setTree(u.tree);
      setDirty(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, subjectId]);

  const adjust = useJobRunner(() => void load());

  const change = (path: number[], fn: (n: UnitNode) => UnitNode | null) => {
    setTree((t) => updateAt(t, path, fn));
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    setError(null);
    try {
      const u = await api.saveUnits(projectId, subjectId, tree);
      setUnits(u);
      setTree(u.tree);
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  if (!units) return <ErrorBox message={error} />;
  return (
    <div data-testid="units-tab">
      <div className="row">
        <button className="primary" data-testid="adjust-units" disabled={adjust.busy || dirty} onClick={() => void adjust.start(() => api.startAdjustUnits(projectId, subjectId))}>
          Claude に目標に合わせて調整させる
        </button>
        <button data-testid="save-units" disabled={!dirty} onClick={() => void save()}>
          編集を保存する
        </button>
        <button
          data-testid="add-top-unit"
          onClick={() => {
            setTree((t) => [...t, { id: newUnitId(), name: '新しい単元', weight: 1, children: [] }]);
            setDirty(true);
          }}
        >
          大きな単元を足す
        </button>
        {dirty && <span className="hint">保存していない変更があります(保存すると Claude の調整を使えます)</span>}
        {saved && <span className="hint" data-testid="units-saved">保存しました</span>}
      </div>
      {adjust.job && <JobRow job={adjust.job} onRetry={() => void adjust.start(() => api.startAdjustUnits(projectId, subjectId))} />}
      <ErrorBox message={error ?? adjust.startError} />
      {units.note && (
        <div className="info" data-testid="units-note">
          <strong>Claude の調整の方針</strong>
          <Md text={units.note} />
        </div>
      )}
      <div className="hint">重みは出題のされやすさです。「0 扱わない」にした単元は、テストや課題に出ません。</div>
      <div className="unit-tree" data-testid="unit-tree">
        {tree.map((n, i) => (
          <UnitRow key={n.id} node={n} path={[i]} depth={1} onChange={change} />
        ))}
      </div>
    </div>
  );
}
