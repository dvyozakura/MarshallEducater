import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';

/** プロンプトの種類。`src/prompts/<種類>.md` が1つずつある。 */
export const PROMPT_KINDS = [
  'ping',
  'adjust_units',
  'read_pages',
  'reread_problem',
  'design_test',
  'generate_problems',
  'solve_problems',
  'judge_answers',
  'grade',
  'trend',
  'plan',
  'explain',
  'note',
  'chat',
] as const;
export type PromptKind = (typeof PROMPT_KINDS)[number];

let cachedDir: string | null = null;

/** プロンプトのフォルダ。ビルド後は out/prompts、テスト・開発時は src/prompts。 */
export function promptsDir(): string {
  if (process.env.ME_PROMPTS_DIR) return process.env.ME_PROMPTS_DIR;
  if (cachedDir) return cachedDir;
  const candidates = [
    resolve(__dirname, '../prompts'), // out/main -> out/prompts
    resolve(__dirname, '../../prompts'), // src/core/claude -> src/prompts
    resolve(process.cwd(), 'src/prompts'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, '_common.md'))) {
      cachedDir = c;
      return c;
    }
  }
  throw new Error('プロンプトのフォルダが見つかりません');
}

export function loadPromptFile(name: string): string {
  return readFileSync(join(promptsDir(), `${name}.md`), 'utf8');
}

/** `<!-- MODE:名前 -->` で区切ったプロンプトのファイルから、1つの区画を取り出す。 */
export function loadPromptSection(name: string, mode: string): string {
  for (const m of loadPromptFile(name).matchAll(/<!-- MODE:(\w+) -->\r?\n([\s\S]*?)(?=<!-- MODE:|$)/g)) {
    if (m[1] === mode) return m[2].trim();
  }
  throw new Error(`プロンプト ${name} に、区画 ${mode} がありません`);
}

/** `{{名前}}` を置き換える。渡されていない名前が残っていたら間違いなのでエラーにする。 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => {
    if (!(name in vars)) throw new Error(`プロンプトの変数 ${name} が渡されていません`);
    return vars[name];
  });
}

/** 型(zod)から、Claude に見せる出力形式の説明(JSON Schema)を作る。 */
export function schemaDescription(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  return JSON.stringify(json, null, 1);
}

export interface BuildPromptArgs {
  kind: PromptKind;
  vars: Record<string, string>;
  /** 入力ファイル(作業フォルダからの相対パス)。無ければ「なし」。 */
  inputFile: string | null;
  outputFile: string;
  schema: z.ZodType;
  /** やり直しのとき、前回の出力の問題点。 */
  retryError?: string;
}

/** 本文(種類ごと)+入出力の約束(共通)+やり直しの指摘、を1つのプロンプトにする。 */
export function buildPrompt(a: BuildPromptArgs): string {
  const body = renderTemplate(loadPromptFile(a.kind), a.vars);
  const common = renderTemplate(loadPromptFile('_common'), {
    kind: a.kind,
    inputFile: a.inputFile ?? 'なし',
    outputFile: a.outputFile,
    schema: schemaDescription(a.schema),
  });
  let text = `${body.trim()}\n\n${common.trim()}\n`;
  if (a.retryError) {
    text += `\n${renderTemplate(loadPromptFile('_retry'), { error: a.retryError }).trim()}\n`;
  }
  return text;
}
