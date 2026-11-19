// 教員エンジン(教える側の仕事を担当する AI)。Claude Code・ChatGPT(Codex CLI)・Gemini(Gemini CLI)。
// どれも公式のコマンドラインツールを、ユーザー自身のログインのまま非対話で呼ぶ(API キーは預からない)。
// 呼び方の確認結果は DECISIONS.md「ほかの AI との接続」。
import { z } from 'zod';

export const ENGINE_IDS = ['claude', 'codex', 'gemini'] as const;
export const EngineIdSchema = z.enum(ENGINE_IDS);
export type EngineId = z.infer<typeof EngineIdSchema>;

export const ENGINE_LABEL: Record<EngineId, string> = {
  claude: 'Claude(Claude Code)',
  codex: 'ChatGPT(Codex CLI)',
  gemini: 'Gemini(Gemini CLI)',
};
/** 画面に小さく出す短い名前。 */
export const ENGINE_SHORT: Record<EngineId, string> = { claude: 'Claude', codex: 'ChatGPT', gemini: 'Gemini' };
/** コマンドの名前(PATH から探すとき)。 */
export const ENGINE_COMMAND: Record<EngineId, string> = { claude: 'claude', codex: 'codex', gemini: 'gemini' };

/** エンジンごとにできること(DECISIONS.md の確認結果から。暫定)。 */
export interface EngineCapabilities {
  /** ページ画像(PNG)を読めるか(読み取りの役割に使えるか)。 */
  images: boolean;
  /** 会話の続き(前の会話 ID を渡して再開)ができるか。できなければ、やりとりをプロンプトに入れて代用する。 */
  resume: boolean;
  /** 「フォルダ内の読み書きだけ・コマンド実行なし」で呼べるか。false のエンジンは使わせない。 */
  safeMode: boolean;
}
export const ENGINE_CAPS: Record<EngineId, EngineCapabilities> = {
  claude: { images: true, resume: true, safeMode: true },
  // Codex CLI: 画像は -i で添付する。続きは `codex exec resume` があるが、作業フォルダ・権限の指定と組み合わせた非対話の再開は
  // 確かめきれないので、やりとりをプロンプトに入れて代用する(暫定)。
  codex: { images: true, resume: false, safeMode: true },
  // Gemini CLI: read_file で画像を読める。続き(--resume)は会話の保存先が利用者のホームに依存するので、代用する(暫定)。
  gemini: { images: true, resume: false, safeMode: true },
};

/** 役割(割り当ての単位)。 */
export const ENGINE_ROLES = ['create', 'verify', 'read', 'grade', 'textbook', 'chat'] as const;
export const EngineRoleSchema = z.enum(ENGINE_ROLES);
export type EngineRole = z.infer<typeof EngineRoleSchema>;
export const ENGINE_ROLE_LABEL: Record<EngineRole, string> = {
  create: '問題作成',
  verify: '検算',
  read: '読み取り',
  grade: '採点',
  textbook: '教材',
  chat: '質問',
};
/** 役割の説明(設定画面)。 */
export const ENGINE_ROLE_NOTE: Record<EngineRole, string> = {
  create: 'テストの設計・問題づくり・単元の調整・傾向・学習計画',
  verify: '作った問題を、答えを見ずに解き直して照らし合わせる',
  read: 'PDF・答案の画像の読み取り(画像を読めるエンジンだけ)',
  grade: '答案の採点',
  textbook: '教材の章・点検・解説・授業ノート',
  chat: '問題・解説・教材への質問',
};

/** プロンプトの種類 → 役割(DECISIONS.md「役割の割り当て」)。ここに無い種類は create として扱う。 */
export const KIND_ROLE: Record<string, EngineRole> = {
  ping: 'create',
  adjust_units: 'create',
  design_test: 'create',
  generate_problems: 'create',
  trend: 'create',
  plan: 'create',
  solve_problems: 'verify',
  judge_answers: 'verify',
  read_pages: 'read',
  reread_problem: 'read',
  grade: 'grade',
  explain: 'textbook',
  note: 'textbook',
  chapter_body: 'textbook',
  chapter_review: 'textbook',
  chapter_revise: 'textbook',
  chapter_supplement: 'textbook',
  chat: 'chat',
};
export function roleOfKind(kind: string): EngineRole {
  return KIND_ROLE[kind] ?? 'create';
}

/** エンジンごとの設定(アプリ全体)。 */
export const EngineConfigSchema = z.object({
  /** コマンドの場所。空なら PATH から探す。 */
  path: z.string().default(''),
  /** モデル。空ならそのツールの既定。 */
  model: z.string().default(''),
  /** 1日の呼び出し回数の上限。 */
  dailyLimit: z.number().int().min(1).max(100000).default(200),
});
export type EngineConfig = z.infer<typeof EngineConfigSchema>;

/** 割り当て(アプリ全体の既定、またはプロジェクトごとの上書き)。 */
export const EngineAssignSchema = z.object({
  /** 既定のエンジン。プロジェクトの上書きでは null = アプリ全体の設定に従う。 */
  defaultEngine: EngineIdSchema.nullable().default(null),
  /** 役割ごとの割り当て。書いていない役割は既定のエンジン。 */
  roles: z.partialRecord(EngineRoleSchema, EngineIdSchema).default({}),
  /** 検算は問題作成と別の AI にする。null = アプリ全体の設定に従う(プロジェクトの上書きのとき)。 */
  verifyWithOther: z.boolean().nullable().default(null),
});
export type EngineAssign = z.infer<typeof EngineAssignSchema>;

/** 作ったもの(問題・採点・教材・解説など)に残す「どのエンジン・モデルで作ったか」。 */
export const MadeBySchema = z.object({
  engine: EngineIdSchema,
  /** モデル(指定しなかったときは空。ツールの既定)。 */
  model: z.string().default(''),
});
export type MadeBy = z.infer<typeof MadeBySchema>;

export function madeByLabel(m: MadeBy | null | undefined): string {
  if (!m) return '';
  return m.model ? `${ENGINE_SHORT[m.engine]}(${m.model})` : ENGINE_SHORT[m.engine];
}

/** 接続確認の結果。 */
export const EngineStatusKindSchema = z.enum(['ok', 'not_found', 'not_logged_in', 'usage_limit', 'error', 'unchecked']);
export type EngineStatusKind = z.infer<typeof EngineStatusKindSchema>;
export const ENGINE_STATUS_LABEL: Record<EngineStatusKind, string> = {
  ok: 'つながっています',
  not_found: '入っていません',
  not_logged_in: 'ログインしていません',
  usage_limit: '使用量の上限に達しています',
  error: 'つながりません',
  unchecked: '未確認',
};
export const EngineStatusSchema = z.object({
  engine: EngineIdSchema,
  status: EngineStatusKindSchema,
  /** 版(--version の出力)。 */
  version: z.string().default(''),
  message: z.string().default(''),
  checkedAt: z.string().nullable().default(null),
});
export type EngineStatus = z.infer<typeof EngineStatusSchema>;

/**
 * 役割ごとにどのエンジンを使うかを決める(アプリ全体の既定 → プロジェクトの上書き → 役割ごと)。
 * - 画像を読めないエンジンは読み取りに使えない(既定のエンジン → Claude の順に代える)。
 * - 「検算は別の AI」がオンで、検算が問題作成と同じになるときは、使えるほかのエンジンに代える。使えるものが無ければ同じエンジンのまま(sameAsCreate)。
 */
export interface ResolveInput {
  app: { defaultEngine: EngineId; roles: Partial<Record<EngineRole, EngineId>>; verifyWithOther: boolean };
  project?: EngineAssign | null;
  /** 接続確認で「つながっている」と分かっているエンジン(検算の代わりを選ぶのに使う)。Claude は常に使える扱い。 */
  available: EngineId[];
}
export interface ResolvedEngine {
  engine: EngineId;
  /** 検算を別の AI にしたかったが、使えるものが無く同じエンジンになった。 */
  sameAsCreate?: boolean;
  /** 割り当てを代えた理由(画像を読めない など)。 */
  note?: string;
}

export function effectiveAssign(input: ResolveInput): { defaultEngine: EngineId; roles: Partial<Record<EngineRole, EngineId>>; verifyWithOther: boolean } {
  const p = input.project;
  return {
    defaultEngine: p?.defaultEngine ?? input.app.defaultEngine,
    roles: { ...input.app.roles, ...(p?.roles ?? {}) },
    verifyWithOther: p?.verifyWithOther ?? input.app.verifyWithOther,
  };
}

export function resolveEngine(role: EngineRole, input: ResolveInput): ResolvedEngine {
  const a = effectiveAssign(input);
  const pick = (r: EngineRole): EngineId => {
    const id = a.roles[r] ?? a.defaultEngine;
    if (r === 'read' && !ENGINE_CAPS[id].images) {
      return ENGINE_CAPS[a.defaultEngine].images ? a.defaultEngine : 'claude';
    }
    return ENGINE_CAPS[id].safeMode ? id : 'claude';
  };
  const engine = pick(role);
  if (role === 'read' && engine !== (a.roles.read ?? a.defaultEngine)) {
    return { engine, note: `${ENGINE_SHORT[a.roles.read ?? a.defaultEngine]} は画像を読めないので、読み取りは ${ENGINE_SHORT[engine]} で行います` };
  }
  if (role === 'verify' && a.verifyWithOther) {
    const create = pick('create');
    if (engine === create) {
      const usable = new Set<EngineId>(['claude', ...input.available]);
      const other = ENGINE_IDS.find((id) => id !== create && usable.has(id));
      if (other) return { engine: other, note: `検算は問題作成(${ENGINE_SHORT[create]})と別の AI にする設定なので、${ENGINE_SHORT[other]} で行います` };
      return { engine, sameAsCreate: true, note: '検算を別の AI にする設定ですが、使えるほかのエンジンが無いので同じエンジンで行います' };
    }
  }
  return { engine };
}

/** 画面の割り当てで選べるエンジンか(読み取りは画像を読めるものだけ)。 */
export function engineAllowedForRole(engine: EngineId, role: EngineRole): boolean {
  if (!ENGINE_CAPS[engine].safeMode) return false;
  if (role === 'read' && !ENGINE_CAPS[engine].images) return false;
  return true;
}
