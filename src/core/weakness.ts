// 苦手マップ: 単元 × ミスの種類ごとの記録と、単元ごとの習熟度(0〜100)。採点(と上書き)のたびに更新する。
import { existsSync } from 'node:fs';
import { daysBetween, todayString } from '../shared/dates';
import { FORMAT_VERSION, MISTAKE_TYPES, type Difficulty, type Grading, type MistakeType, type TargetLevel, type Test, type UnitWeakness, type Weakness, type WeaknessEvent } from '../shared/schema';
import { flattenUnits } from '../shared/subjects';
import type { AppCore } from './app';
import { effectiveScore } from './grading';
import { Files, readData, readDataOr, writeData } from './store';
import { getUnits } from './units';

// ───── 習熟度の式(暫定。DECISIONS.md に記録) ─────

/** 難易度ごとの、得点率 0 のとき・1 のときの「できる度合い」。易しい問題が解けても満点の証拠にはならない。 */
export const CREDIT: Record<Difficulty, { miss: number; hit: number }> = {
  easy: { miss: 0, hit: 70 },
  standard: { miss: 10, hit: 85 },
  target: { miss: 25, hit: 100 },
};
/** 結果の重みが半分になるまでの日数。古い結果ほど軽く扱う。 */
export const HALF_LIFE_DAYS = 30;
/** 記録が少ないうちは、この値(まだ分からない=50)に寄せる。 */
export const PRIOR = { value: 50, weight: 0.5 };
/** 目標の高さごとの、目標とする習熟度。 */
export const TARGET_MASTERY: Record<TargetLevel, number> = { pass: 60, solid: 75, top: 85 };

export function creditOf(ratio: number, difficulty: Difficulty): number {
  const c = CREDIT[difficulty];
  return c.miss + Math.max(0, Math.min(1, ratio)) * (c.hit - c.miss);
}

export function recencyWeight(ageDays: number): number {
  return Math.pow(0.5, Math.max(0, ageDays) / HALF_LIFE_DAYS);
}

/** 習熟度: 「できる度合い」の、新しさで重み付けした平均(記録が少ないうちは 50 に寄せる)。 */
export function computeMastery(events: WeaknessEvent[], today: string): number {
  let sum = PRIOR.value * PRIOR.weight;
  let weight = PRIOR.weight;
  for (const e of events) {
    const w = recencyWeight(daysBetween(e.date, today));
    sum += creditOf(e.ratio, e.difficulty) * w;
    weight += w;
  }
  return Math.round((sum / weight) * 10) / 10;
}

function emptyWeakness(): Weakness {
  return { version: FORMAT_VERSION, units: {}, updatedAt: null };
}

/**
 * 1つのテストの採点結果を苦手マップに反映する。同じテストの前の記録は置き換える(上書き・採点し直しで二重に数えない)。
 */
export function applyGrading(weakness: Weakness, test: Test, grading: Grading, today: string): Weakness {
  const units: Record<string, UnitWeakness> = {};
  const touched = new Set<string>();
  // 同じテストの前の記録を外す(日付は、最初に記録した日を引き継ぐ)
  let date = today;
  for (const [id, u] of Object.entries(weakness.units)) {
    const old = u.events.find((e) => e.testId === test.id);
    if (old) {
      date = old.date;
      touched.add(id);
    }
    units[id] = { ...u, events: u.events.filter((e) => e.testId !== test.id) };
  }
  for (const item of grading.items) {
    const u = units[item.unitId] ?? { unitName: item.unitName, mastery: PRIOR.value, events: [], history: [] };
    const score = effectiveScore(item);
    const ratio = item.max > 0 ? Math.max(0, Math.min(1, score / item.max)) : 0;
    units[item.unitId] = {
      ...u,
      unitName: item.unitName || u.unitName,
      events: [...u.events, { date, testId: test.id, problemId: item.problemId, ratio, difficulty: item.difficulty, mistake: ratio >= 1 ? null : item.mistake }],
    };
    touched.add(item.unitId);
  }
  for (const id of touched) {
    const u = units[id];
    if (u.events.length === 0 && u.history.length <= 1) {
      delete units[id]; // このテストの記録しか無かった単元が、結果から消えた場合
      continue;
    }
    const mastery = computeMastery(u.events, today);
    units[id] = { ...u, mastery, history: [...u.history.filter((h) => h.date !== today), { date: today, mastery }].sort((a, b) => a.date.localeCompare(b.date)) };
  }
  return { version: FORMAT_VERSION, units, updatedAt: new Date().toISOString() };
}

export function getWeakness(core: AppCore, projectId: string, subjectId: string): Weakness {
  return readDataOr(core.paths(projectId).subject(subjectId).weaknessJson, Files.weakness, emptyWeakness);
}

/** 採点(と上書き)のあとに呼ばれる。 */
export function updateWeaknessFromGrading(core: AppCore, projectId: string, subjectId: string, test: Test, grading: Grading): void {
  const file = core.paths(projectId).subject(subjectId).weaknessJson;
  writeData(file, Files.weakness, applyGrading(getWeakness(core, projectId, subjectId), test, grading, todayString()));
}

export interface WeaknessRow {
  unitId: string;
  unitName: string;
  /** いまの習熟度(今日の時点で計算し直したもの。古い結果は軽くなる)。 */
  mastery: number;
  attempts: number;
  /** ミスの種類ごとの回数。 */
  mistakes: Record<MistakeType, number>;
  history: Array<{ date: string; mastery: number }>;
  lastDate: string;
  /** 単元の重み(0〜3)。単元ツリーから消されていたら 1。 */
  weight: number;
}

export interface WeaknessView {
  rows: WeaknessRow[];
  /** 科目全体の習熟度(記録のある単元の、重み付きの平均)。記録が無ければ null。 */
  overall: number | null;
  /** 単元ツリーのうち、まだ記録の無い(出題の対象の)単元の数。 */
  untested: number;
  updatedAt: string | null;
}

export function buildWeaknessView(weakness: Weakness, unitWeights: Map<string, { weight: number; fullName: string; leaf: boolean }>, today: string): WeaknessView {
  const rows: WeaknessRow[] = Object.entries(weakness.units)
    .filter(([, u]) => u.events.length > 0)
    .map(([unitId, u]) => {
      const mistakes = Object.fromEntries(MISTAKE_TYPES.map((m) => [m, 0])) as Record<MistakeType, number>;
      for (const e of u.events) if (e.mistake) mistakes[e.mistake]++;
      return {
        unitId,
        unitName: unitWeights.get(unitId)?.fullName ?? u.unitName ?? unitId,
        mastery: computeMastery(u.events, today),
        attempts: u.events.length,
        mistakes,
        history: u.history,
        lastDate: u.events.reduce((d, e) => (e.date > d ? e.date : d), ''),
        weight: unitWeights.get(unitId)?.weight ?? 1,
      };
    })
    .sort((a, b) => a.mastery - b.mastery || a.unitName.localeCompare(b.unitName, 'ja'));
  const wsum = rows.reduce((n, r) => n + Math.max(0.5, r.weight), 0);
  const overall = rows.length ? Math.round((rows.reduce((n, r) => n + r.mastery * Math.max(0.5, r.weight), 0) / wsum) * 10) / 10 : null;
  const tested = new Set(rows.map((r) => r.unitId));
  const untested = [...unitWeights.entries()].filter(([id, u]) => u.leaf && u.weight > 0 && !tested.has(id)).length;
  return { rows, overall, untested, updatedAt: weakness.updatedAt };
}

export function getWeaknessView(core: AppCore, projectId: string, subjectId: string): WeaknessView {
  const sp = core.paths(projectId).subject(subjectId);
  const weakness = getWeakness(core, projectId, subjectId);
  const units = existsSync(sp.unitsJson) ? flattenUnits(getUnits(core, projectId, subjectId).tree) : [];
  return buildWeaknessView(weakness, new Map(units.map((u) => [u.id, { weight: u.weight, fullName: u.fullName, leaf: u.leaf }])), todayString());
}

/** 苦手克服問題づくり用: 単元ごとに、いちばん多いミスの種類。 */
export function dominantMistake(u: Pick<WeaknessRow, 'mistakes'>): MistakeType | null {
  let best: MistakeType | null = null;
  for (const m of MISTAKE_TYPES) if (u.mistakes[m] > 0 && (best === null || u.mistakes[m] > u.mistakes[best])) best = m;
  return best;
}

/** ファイルをそのまま読む(ほかのモジュール用)。無ければ null。 */
export function readWeaknessOrNull(core: AppCore, projectId: string, subjectId: string): Weakness | null {
  const f = core.paths(projectId).subject(subjectId).weaknessJson;
  return existsSync(f) ? readData(f, Files.weakness) : null;
}
