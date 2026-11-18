import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import * as S from '../shared/schema';
import { writeFileAtomic } from './fsutil';

export type DataFileErrorKind = 'missing' | 'corrupt' | 'invalid' | 'newer_version' | 'unsupported_version';

const KIND_TEXT: Record<DataFileErrorKind, string> = {
  missing: 'ファイルがありません',
  corrupt: 'ファイルが壊れていて読めません',
  invalid: 'ファイルの中身が決まった形式に合っていません',
  newer_version: 'このアプリより新しい版で作られたファイルです。アプリを新しくしてください',
  unsupported_version: '古い版のファイルで、いまの版に直せません',
};

export class DataFileError extends Error {
  constructor(
    public readonly kind: DataFileErrorKind,
    public readonly path: string,
    public readonly detail = '',
  ) {
    super(`${KIND_TEXT[kind]}: ${path}${detail ? `\n${detail}` : ''}`);
    this.name = 'DataFileError';
  }
}

/** ファイルの種類の定義: 型・いまの版・古い版からの直し方。 */
export interface FileDef<T> {
  name: string;
  version: number;
  schema: z.ZodType<T>;
  /** migrations[n] は版 n の内容を版 n+1 に直す。 */
  migrations?: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>>;
}

function describeIssues(e: z.ZodError): string {
  return e.issues
    .slice(0, 8)
    .map((i) => `- ${i.path.join('.') || '(全体)'}: ${i.message}`)
    .join('\n');
}

/**
 * 検証つきで読む。古い版なら直してから返し、直した内容で書き戻す(元は `.v<版>.bak` に残す)。
 * 壊れている・形式違い・新しすぎる版は DataFileError。
 */
export function readData<T>(path: string, def: FileDef<T>): T {
  if (!existsSync(path)) throw new DataFileError('missing', path);
  let text = readFileSync(path, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new DataFileError('corrupt', path, (e as Error).message);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DataFileError('corrupt', path, 'JSON のオブジェクトではありません');
  let obj = raw as Record<string, unknown>;
  const fileVersion = typeof obj.version === 'number' ? obj.version : 0;
  if (fileVersion > def.version) throw new DataFileError('newer_version', path, `ファイルの版 ${fileVersion}、アプリが扱える版 ${def.version}`);
  let migrated = false;
  for (let v = fileVersion; v < def.version; v++) {
    const step = def.migrations?.[v];
    if (!step) throw new DataFileError('unsupported_version', path, `版 ${v} から ${v + 1} への直し方がありません`);
    obj = { ...step(obj), version: v + 1 };
    migrated = true;
  }
  const parsed = def.schema.safeParse(obj);
  if (!parsed.success) throw new DataFileError('invalid', path, describeIssues(parsed.error));
  if (migrated) {
    try {
      copyFileSync(path, `${path}.v${fileVersion}.bak`);
      writeFileAtomic(path, JSON.stringify(parsed.data, null, 1));
    } catch {
      /* 書き戻せなくても、読めた内容は返す */
    }
  }
  return parsed.data;
}

/** 無ければ fallback を返す(壊れている場合は例外のまま)。 */
export function readDataOr<T>(path: string, def: FileDef<T>, fallback: () => T): T {
  if (!existsSync(path)) return fallback();
  return readData(path, def);
}

/** 型で検証してから、安全な置き換えで書く。版番号はいまの版にする。 */
export function writeData<T>(path: string, def: FileDef<T>, data: T): T {
  const withVersion = { ...(data as Record<string, unknown>), version: def.version };
  const parsed = def.schema.safeParse(withVersion);
  if (!parsed.success) throw new DataFileError('invalid', path, describeIssues(parsed.error));
  writeFileAtomic(path, JSON.stringify(parsed.data, null, 1));
  return parsed.data;
}

/** 書き込み途中で落ちたときに残る一時ファイル(*.tmp-*)を消す。1分以内のものは書き込み中かもしれないので残す。 */
export function cleanupTmpFiles(dir: string, olderThanMs = 60000): number {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name !== 'node_modules') removed += cleanupTmpFiles(p, olderThanMs);
    } else if (/\.tmp-\d+-[a-z0-9]+$/.test(name) && Date.now() - st.mtimeMs >= olderThanMs) {
      rmSync(p, { force: true });
      removed++;
    }
  }
  return removed;
}

// 版 0(版番号が無い時代)→ 1 は、足りない項目を既定値で補うだけ。
const fromV0 = { 0: (raw: Record<string, unknown>) => raw };

function def<T>(name: string, schema: z.ZodType<T>): FileDef<T> {
  return { name, version: S.FORMAT_VERSION, schema, migrations: fromV0 };
}

/** ファイルの種類の一覧。 */
export const Files = {
  settings: def('settings.json', S.AppSettingsSchema),
  project: def('project.json', S.ProjectSchema),
  units: def('units.json', S.UnitsSchema),
  weakness: def('weakness.json', S.WeaknessSchema),
  source: def('source.json', S.SourceMetaSchema),
  extracted: def('extracted.json', S.ExtractedSchema),
  corrections: def('corrections.json', S.CorrectionsSchema),
  test: def('test.json', S.TestSchema),
  answerKey: def('answer_key.json', S.AnswerKeySchema),
  verify: def('verify.json', S.VerifySchema),
  reading: def('reading.json', S.ReadingSchema),
  draft: def('draft.json', S.DraftSchema),
  grading: def('grading.json', S.GradingSchema),
  trend: def('trend.json', S.TrendSchema),
  plan: def('plan.json', S.PlanSchema),
  review: def('review.json', S.ReviewSchema),
  chat: def('chat.json', S.ChatSchema),
};
