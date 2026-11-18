// 設定画面の「品質」欄: 検算の結果(採用・作り直し・破棄)、読み取りの補正率、採点の上書きの数。
// 全プロジェクトのファイルを数えるだけで、Claude は呼ばない。
import { existsSync } from 'node:fs';
import type { AppCore } from './app';
import { getGrading } from './grading';
import type { SourcePaths } from './paths';
import { listProjects } from './projects';
import { listSources } from './sources';
import { Files, readData } from './store';
import { getVerify, listTests } from './tests';

export interface ReadingQuality {
  /** 補正の記録がある資料の数。 */
  sources: number;
  /** Claude が最初に読み取った文字数。 */
  originalChars: number;
  /** 人が直した文字数。 */
  changedChars: number;
  /** 直した操作の回数(編集・分割・結合など。確定の操作は除く)。 */
  edits: number;
  /** 補正率(%)= 直した文字数 ÷ 読み取った文字数。記録が無ければ null。 */
  rate: number | null;
}

export interface Quality {
  /** 検算(生成問題の解き直し)。 */
  verify: { tests: number; adopted: number; regenerated: number; discarded: number; total: number; adoptedRate: number | null };
  /** 問題(過去問・問題集など)の読み取り。 */
  problems: ReadingQuality;
  /** 答案(手書きを含む)の読み取り。 */
  answers: ReadingQuality;
  /** 採点の上書き。 */
  grading: { tests: number; items: number; overridden: number; rate: number | null };
}

const pct = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

function addCorrections(q: ReadingQuality, paths: SourcePaths): void {
  if (!existsSync(paths.correctionsJson)) return;
  try {
    const c = readData(paths.correctionsJson, Files.corrections);
    q.sources++;
    q.originalChars += c.originalChars;
    q.changedChars += c.changedChars;
    q.edits += c.entries.filter((e) => !['confirm', 'unconfirm', 'confirm_all'].includes(e.action)).length;
  } catch {
    /* 壊れた記録は数えない */
  }
}

export function getQuality(core: AppCore): Quality {
  const verify = { tests: 0, adopted: 0, regenerated: 0, discarded: 0 };
  const problems: ReadingQuality = { sources: 0, originalChars: 0, changedChars: 0, edits: 0, rate: null };
  const answers: ReadingQuality = { sources: 0, originalChars: 0, changedChars: 0, edits: 0, rate: null };
  const grading = { tests: 0, items: 0, overridden: 0 };
  for (const p of listProjects(core).projects) {
    for (const s of p.subjects) {
      const sp = core.paths(p.id).subject(s.id);
      for (const src of listSources(core, p.id, s.id)) addCorrections(problems, sp.source(src.id));
      for (const t of listTests(core, p.id, s.id)) {
        const v = getVerify(core, p.id, s.id, t.id);
        if (v) {
          verify.tests++;
          verify.adopted += v.counts.adopted;
          verify.regenerated += v.counts.regenerated;
          verify.discarded += v.counts.discarded;
        }
        addCorrections(answers, sp.test(t.id).submission);
        try {
          const g = getGrading(core, p.id, s.id, t.id);
          if (g) {
            grading.tests++;
            grading.items += g.items.length;
            grading.overridden += g.items.filter((i) => i.override).length;
          }
        } catch {
          /* 壊れた採点結果は数えない */
        }
      }
    }
  }
  problems.rate = pct(problems.changedChars, problems.originalChars);
  answers.rate = pct(answers.changedChars, answers.originalChars);
  const total = verify.adopted + verify.regenerated + verify.discarded;
  return {
    verify: { ...verify, total, adoptedRate: pct(verify.adopted, total) },
    problems,
    answers,
    grading: { ...grading, rate: pct(grading.overridden, grading.items) },
  };
}
