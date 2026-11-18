// データの型はここに1か所でまとめる。ファイルの読み書き時と、Claude の出力の検証に同じ型を使う。
import { z } from 'zod';

/** ファイル形式の版番号(全ファイル共通で今は 1)。 */
export const FORMAT_VERSION = 1;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD の形式で書く');

// ───────── 設定 ─────────
export const AppSettingsSchema = z.object({
  version: z.number().int(),
  /** データの場所。空なら既定(ドキュメント/MarshallEducaterData)。 */
  dataDir: z.string().default(''),
  /** claude の場所。空なら PATH から探す。 */
  claudePath: z.string().default(''),
  /** モデル(別名か正式名)。空なら Claude Code の既定。 */
  model: z.string().default('sonnet'),
  concurrency: z.number().int().min(1).max(8).default(2),
  dailyLimit: z.number().int().min(1).max(100000).default(200),
  timeoutMin: z.number().int().min(1).max(180).default(15),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

// ───────── プロジェクト ─────────
export const ExamTypeSchema = z.enum(['kyotsu', 'kokkoritsu', 'shidai']);
export type ExamType = z.infer<typeof ExamTypeSchema>;
export const EXAM_TYPE_LABEL: Record<ExamType, string> = {
  kyotsu: '共通テスト',
  kokkoritsu: '国公立二次',
  shidai: '私大',
};

export const TargetLevelSchema = z.enum(['pass', 'solid', 'top']);
export type TargetLevel = z.infer<typeof TargetLevelSchema>;
export const TARGET_LEVEL_LABEL: Record<TargetLevel, string> = {
  pass: '合格最低点をねらう',
  solid: '合格者平均をねらう',
  top: '上位での合格をねらう',
};

export const SubjectRefSchema = z.object({
  /** フォルダ名にもなる ID。 */
  id: z.string().min(1),
  name: z.string().min(1),
});
export type SubjectRef = z.infer<typeof SubjectRefSchema>;

export const ProjectSchema = z.object({
  version: z.number().int(),
  /** フォルダ名にもなる ID。 */
  id: z.string().min(1),
  name: z.string().min(1),
  university: z.string(),
  faculty: z.string(),
  examDate: isoDate,
  examType: ExamTypeSchema,
  targetLevel: TargetLevelSchema,
  /** 1日に使える学習時間(分)。 */
  dailyMinutes: z.number().int().min(10).max(960).default(120),
  subjects: z.array(SubjectRefSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

/** 画面からの作成・編集で受け取る内容。 */
export const ProjectInputSchema = ProjectSchema.pick({
  name: true,
  university: true,
  faculty: true,
  examDate: true,
  examType: true,
  targetLevel: true,
  dailyMinutes: true,
}).extend({ subjectNames: z.array(z.string().min(1)).min(1, '科目を1つ以上選んでください') });
export type ProjectInput = z.infer<typeof ProjectInputSchema>;

// ───────── 単元 ─────────
export interface UnitNode {
  id: string;
  name: string;
  /** 重み。0=扱わない、1=ふつう、2=重点、3=最重点。 */
  weight: number;
  children: UnitNode[];
}
export const UnitNodeSchema: z.ZodType<UnitNode> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  weight: z.number().min(0).max(3),
  get children() {
    return z.array(UnitNodeSchema);
  },
});
export const UnitsSchema = z.object({
  version: z.number().int(),
  tree: z.array(UnitNodeSchema),
  /** Claude が調整した日時。まだなら null。 */
  adjustedAt: z.string().nullable().default(null),
  /** 調整の方針(Claude の一言)。 */
  note: z.string().default(''),
});
export type Units = z.infer<typeof UnitsSchema>;

// ───────── ミスの種類・苦手マップ ─────────
export const MistakeTypeSchema = z.enum(['knowledge', 'approach', 'calculation', 'misread', 'timeout', 'blank']);
export type MistakeType = z.infer<typeof MistakeTypeSchema>;
export const MISTAKE_TYPES = MistakeTypeSchema.options;
export const MISTAKE_LABEL: Record<MistakeType, string> = {
  knowledge: '知識不足',
  approach: '方針が立たない',
  calculation: '計算・処理ミス',
  misread: '読み違い',
  timeout: '時間切れ',
  blank: '未解答',
};

export const DifficultySchema = z.enum(['easy', 'standard', 'target']);
export type Difficulty = z.infer<typeof DifficultySchema>;
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: '易', standard: '標準', target: '目標校レベル' };

export const WeaknessEventSchema = z.object({
  date: z.string(),
  testId: z.string(),
  problemId: z.string(),
  /** 得点率(0〜1)。 */
  ratio: z.number().min(0).max(1),
  difficulty: DifficultySchema,
  mistake: MistakeTypeSchema.nullable(),
});
export type WeaknessEvent = z.infer<typeof WeaknessEventSchema>;

export const UnitWeaknessSchema = z.object({
  unitName: z.string().default(''),
  /** 習熟度(0〜100)。 */
  mastery: z.number().min(0).max(100),
  events: z.array(WeaknessEventSchema),
  /** 習熟度の推移。 */
  history: z.array(z.object({ date: z.string(), mastery: z.number() })),
});
export type UnitWeakness = z.infer<typeof UnitWeaknessSchema>;

export const WeaknessSchema = z.object({
  version: z.number().int(),
  units: z.record(z.string(), UnitWeaknessSchema),
  updatedAt: z.string().nullable().default(null),
});
export type Weakness = z.infer<typeof WeaknessSchema>;

// ───────── 資料と読み取り ─────────
export const SourceKindSchema = z.enum(['past_exam', 'workbook', 'answer', 'mock_result']);
export type SourceKind = z.infer<typeof SourceKindSchema>;
export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  past_exam: '過去問',
  workbook: '問題集・演習',
  answer: '答案',
  mock_result: '模試の結果',
};

export const SourceStatusSchema = z.enum(['imported', 'read', 'confirmed']);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;
export const SOURCE_STATUS_LABEL: Record<SourceStatus, string> = { imported: '取り込み済み(未読み取り)', read: '読み取り済み(未確定)', confirmed: '確定' };

export const SourceMetaSchema = z.object({
  version: z.number().int(),
  id: z.string(),
  kind: SourceKindSchema,
  title: z.string(),
  /** 元のファイル名。 */
  fileName: z.string(),
  pageCount: z.number().int().min(0),
  importedAt: z.string(),
  status: SourceStatusSchema,
  /** 答案の場合、どのテストへの答案か。 */
  testId: z.string().nullable().default(null),
});
export type SourceMeta = z.infer<typeof SourceMetaSchema>;

export const BBoxSchema = z.object({
  /** ページの左上を (0,0)、右下を (1,1) とした割合。 */
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
});
export type BBox = z.infer<typeof BBoxSchema>;

export const AnswerFormatSchema = z.enum(['choice', 'short', 'essay', 'other']);
export type AnswerFormat = z.infer<typeof AnswerFormatSchema>;
export const ANSWER_FORMAT_LABEL: Record<AnswerFormat, string> = { choice: '選択式', short: '短答', essay: '記述', other: 'その他' };

export const UncertainSchema = z.object({
  /** 自信がない箇所の文字列(本文中の該当部分。分からなければ空)。 */
  text: z.string(),
  reason: z.string(),
});
export type Uncertain = z.infer<typeof UncertainSchema>;

/** Claude が読み取りで出す図(切り出し前)。 */
export const ReadFigureSchema = z.object({
  page: z.number().int().min(1),
  bbox: BBoxSchema,
  description: z.string(),
});

/** Claude が読み取りで出す1問ぶん。答案の読み取りでは body が答案の内容、target が設問番号。 */
export const ReadProblemSchema = z.object({
  /** 表示用の番号(例: 「第1問 (2)」)。 */
  number: z.string(),
  major: z.string().default(''),
  minor: z.string().default(''),
  points: z.number().nullable().default(null),
  /** 本文。Markdown、数式は LaTeX($...$、$$...$$)。 */
  body: z.string(),
  choices: z.array(z.string()).default([]),
  answerFormat: AnswerFormatSchema.default('other'),
  /** 推定の単元名。 */
  unit: z.string().default(''),
  pages: z.array(z.number().int().min(1)).default([]),
  figures: z.array(ReadFigureSchema).default([]),
  uncertain: z.array(UncertainSchema).default([]),
  /** 前のページ群の最後の問題の続きなら true(分けて読んだときの結合に使う)。 */
  continuesFromPrevious: z.boolean().default(false),
  /** 答案の場合: どの設問への解答か(設問の番号)。 */
  target: z.string().nullable().default(null),
});
export type ReadProblem = z.infer<typeof ReadProblemSchema>;

export const ReadPagesOutputSchema = z.object({ problems: z.array(ReadProblemSchema) });
export type ReadPagesOutput = z.infer<typeof ReadPagesOutputSchema>;

/** 1問だけの読み直し(ヒントつき)の出力。 */
export const RereadOutputSchema = z.object({ problem: ReadProblemSchema });

export const FigureSchema = ReadFigureSchema.extend({
  id: z.string(),
  /** 切り出した画像(資料フォルダからの相対パス)。まだなら null。 */
  image: z.string().nullable().default(null),
});
export type Figure = z.infer<typeof FigureSchema>;

export const ExtractedProblemSchema = ReadProblemSchema.omit({ figures: true, continuesFromPrevious: true }).extend({
  id: z.string(),
  figures: z.array(FigureSchema).default([]),
  confirmed: z.boolean().default(false),
});
export type ExtractedProblem = z.infer<typeof ExtractedProblemSchema>;

export const ExtractedSchema = z.object({
  version: z.number().int(),
  sourceId: z.string(),
  problems: z.array(ExtractedProblemSchema),
  readAt: z.string(),
  /** 資料全体を確定した日時。未確定は null。 */
  confirmedAt: z.string().nullable().default(null),
});
export type Extracted = z.infer<typeof ExtractedSchema>;

export const CorrectionActionSchema = z.enum(['edit', 'split', 'merge', 'reorder', 'delete', 'figure', 'reread', 'confirm', 'unconfirm', 'confirm_all']);
export const CorrectionEntrySchema = z.object({
  at: z.string(),
  problemId: z.string(),
  action: CorrectionActionSchema,
  before: z.string().nullable().default(null),
  after: z.string().nullable().default(null),
});
export type CorrectionEntry = z.infer<typeof CorrectionEntrySchema>;
export const CorrectionsSchema = z.object({
  version: z.number().int(),
  sourceId: z.string(),
  entries: z.array(CorrectionEntrySchema),
  /** Claude が最初に読み取った文字数と、確定時点で人が直した文字数(補正率の目安)。 */
  originalChars: z.number().int().default(0),
  changedChars: z.number().int().default(0),
});
export type Corrections = z.infer<typeof CorrectionsSchema>;

// ───────── 問題・テスト ─────────
export const ProblemFormatSchema = z.enum(['choice', 'short', 'essay']);
export type ProblemFormat = z.infer<typeof ProblemFormatSchema>;
export const PROBLEM_FORMAT_LABEL: Record<ProblemFormat, string> = { choice: '選択式', short: '短答', essay: '記述' };

export const ProblemOriginSchema = z.enum(['diagnostic', 'weakness', 'similar', 'review', 'mock', 'practice']);
export type ProblemOrigin = z.infer<typeof ProblemOriginSchema>;
export const PROBLEM_ORIGIN_LABEL: Record<ProblemOrigin, string> = {
  diagnostic: '診断',
  weakness: '苦手克服問題',
  similar: '過去問の類題',
  review: '復習',
  mock: '模擬試験',
  practice: '演習',
};

/** Claude が作る1問(答えつき)。 */
export const GeneratedProblemSchema = z.object({
  unitId: z.string(),
  difficulty: DifficultySchema,
  format: ProblemFormatSchema,
  /** 問題文。Markdown、数式は LaTeX。 */
  body: z.string().min(1),
  /** 選択式のときの選択肢(2つ以上)。それ以外は空。 */
  choices: z.array(z.string()).default([]),
  points: z.number().min(1).max(100),
  /** 図が必要なときだけ SVG。不要なら null。 */
  figureSvg: z.string().nullable().default(null),
  /** 正解。選択式は選択肢の番号(1始まり)を文字列で。 */
  answer: z.string().min(1),
  /** 採点基準(記述・短答の部分点の付け方)。 */
  rubric: z.string().default(''),
  /** 解き方の説明。 */
  solution: z.string().default(''),
});
export type GeneratedProblem = z.infer<typeof GeneratedProblemSchema>;
export const GenerateOutputSchema = z.object({ problems: z.array(GeneratedProblemSchema) });

/** テストの設計(診断テスト・模擬試験): 分量・制限時間・出題する単元と難易度と形式を Claude が決める。 */
export const DesignTestOutputSchema = z.object({
  /** 制限時間(分)。 */
  timeLimitMin: z.number().int().min(5).max(240),
  /** 受験生への注意書き(1〜3文)。 */
  instructions: z.string().default(''),
  /** 出題する問題の一覧(1要素 = 1問)。 */
  items: z.array(z.object({ unitId: z.string(), difficulty: DifficultySchema, format: ProblemFormatSchema })).min(1).max(40),
});
export type DesignTestOutput = z.infer<typeof DesignTestOutputSchema>;

export const ProblemSchema = z.object({
  id: z.string(),
  number: z.string(),
  unitId: z.string(),
  unitName: z.string(),
  difficulty: DifficultySchema,
  format: ProblemFormatSchema,
  body: z.string(),
  choices: z.array(z.string()).default([]),
  points: z.number(),
  figureSvg: z.string().nullable().default(null),
  origin: ProblemOriginSchema.default('practice'),
});
export type Problem = z.infer<typeof ProblemSchema>;

export const TestKindSchema = z.enum(['diagnostic', 'daily', 'mock', 'practice']);
export type TestKind = z.infer<typeof TestKindSchema>;
export const TEST_KIND_LABEL: Record<TestKind, string> = { diagnostic: '実力診断テスト', daily: '今日の課題', mock: '通しの模擬試験', practice: '演習' };

export const TestStatusSchema = z.enum(['ready', 'submitted', 'reading', 'graded']);
export type TestStatus = z.infer<typeof TestStatusSchema>;
export const TEST_STATUS_LABEL: Record<TestStatus, string> = { ready: '未提出', submitted: '提出済み(採点待ち)', reading: '答案の読み取り・補正中', graded: '採点済み' };

export const TestSchema = z.object({
  version: z.number().int(),
  id: z.string(),
  subjectId: z.string(),
  kind: TestKindSchema,
  title: z.string(),
  timeLimitMin: z.number().int().min(1),
  instructions: z.string().default(''),
  problems: z.array(ProblemSchema),
  createdAt: z.string(),
  /** 今日の課題の場合の日付。 */
  date: isoDate.nullable().default(null),
  status: TestStatusSchema.default('ready'),
});
export type Test = z.infer<typeof TestSchema>;

export const AnswerKeyItemSchema = z.object({
  problemId: z.string(),
  answer: z.string(),
  rubric: z.string().default(''),
  solution: z.string().default(''),
});
export const AnswerKeySchema = z.object({
  version: z.number().int(),
  testId: z.string(),
  items: z.array(AnswerKeyItemSchema),
});
export type AnswerKey = z.infer<typeof AnswerKeySchema>;

export const VerifyOutcomeSchema = z.enum(['adopted', 'regenerated', 'discarded']);
export type VerifyOutcome = z.infer<typeof VerifyOutcomeSchema>;
export const VerifyRecordSchema = z.object({
  /** 採用された問題の ID。破棄の場合は null。 */
  problemId: z.string().nullable(),
  unitId: z.string(),
  outcome: VerifyOutcomeSchema,
  reason: z.string().default(''),
});
export type VerifyRecord = z.infer<typeof VerifyRecordSchema>;
export const VerifySchema = z.object({
  version: z.number().int(),
  testId: z.string(),
  records: z.array(VerifyRecordSchema),
  counts: z.object({ adopted: z.number().int(), regenerated: z.number().int(), discarded: z.number().int() }),
});
export type Verify = z.infer<typeof VerifySchema>;

/** 検算: 解答を見せずに解かせた結果。 */
export const SolveOutputSchema = z.object({
  answers: z.array(
    z.object({
      index: z.number().int().min(1),
      /** 答え。選択式は選択肢の番号。解けない・条件不足・複数解のときは空にして issue に理由を書く。 */
      answer: z.string(),
      issue: z.string().default(''),
    }),
  ),
});
export type SolveOutput = z.infer<typeof SolveOutputSchema>;

/** 検算: 解き直しの答えが、作成時の答え(採点基準)に照らして正しいかの判定。 */
export const JudgeOutputSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().int().min(1),
      /** 作成時の答えと一致(記述は採点基準で満点)なら true。 */
      match: z.boolean(),
      reason: z.string().default(''),
    }),
  ),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

// ───────── 答案 ─────────
export const AnswerEntrySchema = z.object({
  problemId: z.string(),
  answer: z.string(),
});
export const ReadingSchema = z.object({
  version: z.number().int(),
  testId: z.string(),
  /** アプリ内で入力したか、紙の答案を読み取ったか。 */
  method: z.enum(['inapp', 'scan']),
  answers: z.array(AnswerEntrySchema),
  /** 確定した答案だけが採点に使われる。 */
  confirmed: z.boolean(),
  submittedAt: z.string(),
  elapsedSec: z.number().nullable().default(null),
});
export type Reading = z.infer<typeof ReadingSchema>;

/** アプリ内で解いている途中の控え(画面を離れても消えないように保存する)。 */
export const DraftSchema = z.object({
  version: z.number().int(),
  testId: z.string(),
  /** 問題 ID → いま入力されている答え。 */
  answers: z.record(z.string(), z.string()),
  startedAt: z.string(),
  /** これまでに使った時間(秒)。 */
  elapsedSec: z.number().min(0),
  /** 制限時間を過ぎたあと、延長して続けているか。 */
  extended: z.boolean().default(false),
});
export type Draft = z.infer<typeof DraftSchema>;

// ───────── 採点 ─────────
export const GradeItemOutputSchema = z.object({
  problemId: z.string(),
  score: z.number().min(0),
  /** 採点の根拠(記述は部分点の内訳)。 */
  rationale: z.string(),
  /** 減点・間違いがあるときのミスの種類。満点なら null。 */
  mistake: MistakeTypeSchema.nullable().default(null),
  /** なぜ間違えたかの短い所見。満点なら空でよい。 */
  comment: z.string().default(''),
});
export const GradeOutputSchema = z.object({ items: z.array(GradeItemOutputSchema) });
export type GradeOutput = z.infer<typeof GradeOutputSchema>;

export const GradeItemSchema = GradeItemOutputSchema.extend({
  max: z.number(),
  unitId: z.string(),
  unitName: z.string().default(''),
  difficulty: DifficultySchema.default('standard'),
  /** ユーザーによる上書き。 */
  override: z
    .object({ score: z.number().min(0), note: z.string(), at: z.string() })
    .nullable()
    .default(null),
});
export type GradeItem = z.infer<typeof GradeItemSchema>;
export const GradingSchema = z.object({
  version: z.number().int(),
  testId: z.string(),
  gradedAt: z.string(),
  items: z.array(GradeItemSchema),
  /** 上書きの履歴。 */
  overrides: z.array(z.object({ at: z.string(), problemId: z.string(), from: z.number(), to: z.number(), note: z.string() })).default([]),
});
export type Grading = z.infer<typeof GradingSchema>;

// ───────── 解説・ノート ─────────
export const ExplainOutputSchema = z.object({
  items: z.array(
    z.object({
      problemId: z.string(),
      /** 考え方。 */
      thinking: z.string(),
      /** 解き方。 */
      solution: z.string(),
      /** 同じミスを防ぐ一言。 */
      tip: z.string(),
    }),
  ),
});
export type ExplainOutput = z.infer<typeof ExplainOutputSchema>;

export const NoteOutputSchema = z.object({
  /** 授業ノート(Markdown)。要点・例題・よくある誤りを含む。 */
  markdown: z.string().min(1),
});

// ───────── 傾向 ─────────
export const TrendOutputSchema = z.object({
  /** 出題形式(マーク式・記述式など)。 */
  format: z.string(),
  /** 大問構成。 */
  structure: z.array(z.object({ label: z.string(), description: z.string() })),
  /** 頻出単元。 */
  frequentUnits: z.array(z.object({ unit: z.string(), note: z.string().default('') })),
  /** 分量。 */
  volume: z.string(),
  /** 時間配分。 */
  timeAllocation: z.string(),
  /** 難易度の所見。 */
  difficulty: z.string(),
  /** 人が読むまとめ(Markdown)。 */
  summaryMd: z.string(),
});
export type TrendOutput = z.infer<typeof TrendOutputSchema>;
export const TrendSchema = TrendOutputSchema.extend({
  version: z.number().int(),
  updatedAt: z.string(),
  /** もとにした過去問(資料 ID)。 */
  basedOn: z.array(z.string()),
});
export type Trend = z.infer<typeof TrendSchema>;

// ───────── 学習計画 ─────────
export const PlanWeekOutputSchema = z.object({
  /** その週のねらい。 */
  theme: z.string(),
  items: z.array(
    z.object({
      subjectId: z.string(),
      /** 取り組む単元(単元 ID)。 */
      unitIds: z.array(z.string()),
      /** その週にこの科目へ使う時間(分)。 */
      minutes: z.number().min(0),
      goal: z.string().default(''),
    }),
  ),
});
export const PlanOutputSchema = z.object({
  /** 週ごとの計画。入力の weeks と同じ数・同じ順。 */
  weeks: z.array(PlanWeekOutputSchema),
  /** 全体の方針と助言。 */
  advice: z.string(),
});
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

export const PlanWeekSchema = PlanWeekOutputSchema.extend({
  index: z.number().int(),
  start: isoDate,
  end: isoDate,
  /** 通しの模擬試験を入れる週。 */
  mock: z.boolean().default(false),
});
export type PlanWeek = z.infer<typeof PlanWeekSchema>;
export const PlanSchema = z.object({
  version: z.number().int(),
  createdAt: z.string(),
  /** 作った日(この日を起点に週を切る)。 */
  startDate: isoDate,
  examDate: isoDate,
  dailyMinutes: z.number(),
  weeks: z.array(PlanWeekSchema),
  /** 通しの模擬試験の予定。 */
  mocks: z.array(z.object({ date: isoDate, subjectId: z.string(), testId: z.string().nullable().default(null) })).default([]),
  advice: z.string().default(''),
  /** 何回目の作り直しか(最初は 0)。 */
  revision: z.number().int().default(0),
  /** 作り直しの理由。 */
  reason: z.string().default(''),
});
export type Plan = z.infer<typeof PlanSchema>;

// ───────── 復習(間をあけた再出題) ─────────
export const ReviewItemSchema = z.object({
  testId: z.string(),
  problemId: z.string(),
  unitId: z.string(),
  unitName: z.string().default(''),
  difficulty: DifficultySchema,
  format: ProblemFormatSchema,
  /** もとの問題文(類題づくりの参考)。 */
  body: z.string(),
  /** 次に出す日。 */
  due: isoDate,
  /** いまの間隔(日)。 */
  intervalDays: z.number().int(),
  /** 連続で正解した回数。 */
  streak: z.number().int().default(0),
});
export type ReviewItem = z.infer<typeof ReviewItemSchema>;
export const ReviewSchema = z.object({ version: z.number().int(), items: z.array(ReviewItemSchema) });
export type Review = z.infer<typeof ReviewSchema>;

// ───────── 質問 ─────────
export const ChatOutputSchema = z.object({
  /** 質問への答え(Markdown、数式は LaTeX)。 */
  answer: z.string().min(1),
});
export const ChatContextSchema = z.object({
  testId: z.string().nullable().default(null),
  problemId: z.string().nullable().default(null),
  /** 授業ノートからの質問のとき、その単元 ID。 */
  unitId: z.string().nullable().default(null),
});
export type ChatContext = z.infer<typeof ChatContextSchema>;
export const ChatSchema = z.object({
  version: z.number().int(),
  id: z.string(),
  subjectId: z.string(),
  title: z.string(),
  context: ChatContextSchema,
  /** Claude Code の会話 ID(続きの質問で --resume に渡す)。 */
  sessionId: z.string().nullable().default(null),
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string(), at: z.string() })),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Chat = z.infer<typeof ChatSchema>;

// ───────── 単元の調整(Claude の出力) ─────────
export const AdjustUnitsOutputSchema = z.object({
  tree: z.array(UnitNodeSchema).min(1),
  /** 調整の方針(何を増やし、何を減らしたか)。 */
  note: z.string(),
});

// ───────── 接続の確認 ─────────
export const PingOutputSchema = z.object({ ok: z.literal(true), message: z.string() });
