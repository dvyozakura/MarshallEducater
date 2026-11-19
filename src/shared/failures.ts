import { ENGINE_SHORT, type EngineId } from './engines';

/** 教員エンジン(Claude など)の呼び出しが失敗した理由の種類。 */
export type FailureKind =
  | 'not_found' // コマンドが見つからない(入っていない)
  | 'not_logged_in' // ログインしていない
  | 'usage_limit' // 使用量の上限
  | 'network' // 通信の失敗
  | 'timeout' // 時間切れ
  | 'canceled' // 取り消し
  | 'daily_limit' // アプリ側の1日の呼び出し上限
  | 'invalid_output' // やり直しても出力が型に合わない
  | 'other';

export interface FailureInfo {
  kind: FailureKind;
  message: string;
  /** どのエンジンでの失敗か(無ければ Claude)。 */
  engine?: EngineId;
}

const GUIDES: Record<FailureKind, { title: string; guide: string; retryable: boolean }> = {
  not_found: {
    title: 'Claude Code(claude)が見つかりません',
    guide: 'Claude Code をインストールするか、設定画面の「claude の場所」に claude.exe の場所を入れてから、もう一度試してください。',
    retryable: true,
  },
  not_logged_in: {
    title: 'Claude Code にログインしていません(またはログインが切れました)',
    guide: 'ターミナルで claude を起動し、/login でログインし直してください。そのあとで、もう一度試してください。',
    retryable: true,
  },
  usage_limit: {
    title: 'Claude の使用量の上限に達しました',
    guide: '上限が戻る時刻まで待ってから、もう一度試してください(戻る時刻は下の詳細に出ていることがあります)。',
    retryable: true,
  },
  network: {
    title: 'Claude との通信に失敗しました',
    guide: 'インターネットの接続を確かめてから、もう一度試してください。',
    retryable: true,
  },
  timeout: {
    title: '時間切れになりました',
    guide: 'Claude の応答が時間内に終わりませんでした。もう一度試すか、設定画面で制限時間を延ばしてください。',
    retryable: true,
  },
  canceled: { title: '取り消しました', guide: '', retryable: true },
  daily_limit: {
    title: '今日の呼び出し回数の上限に達しました',
    guide: '設定画面の「1日の上限」を増やすか、明日また試してください。',
    retryable: false,
  },
  invalid_output: {
    title: 'Claude の出力を読み取れませんでした',
    guide: 'やり直しても決まった形式の出力になりませんでした。もう一度試してください。続く場合は logs フォルダの記録を確認してください。',
    retryable: true,
  },
  other: {
    title: 'Claude の呼び出しに失敗しました',
    guide: '下の詳細を確認して、もう一度試してください。',
    retryable: true,
  },
};

/** Claude 以外のエンジンの、入っていない・未ログイン・使用量上限の案内(DECISIONS.md「ほかの AI との接続」)。 */
const ENGINE_GUIDES: Record<Exclude<EngineId, 'claude'>, Partial<Record<FailureKind, { title: string; guide: string }>>> = {
  codex: {
    not_found: {
      title: 'ChatGPT(Codex CLI)が入っていません',
      guide: 'Codex CLI を入れる(例: npm i -g @openai/codex)か、設定画面の「codex の場所」を直してください。使わない場合は、設定画面で担当を Claude に戻してください。',
    },
    not_logged_in: {
      title: 'ChatGPT(Codex CLI)にログインしていません',
      guide: 'ターミナルで codex login を実行し、ChatGPT のアカウントでログインしてください。そのあとで、もう一度試してください。',
    },
    usage_limit: {
      title: 'ChatGPT(Codex)の使用量の上限に達しました',
      guide: '上限が戻るまで待つか、設定画面で担当を Claude に替えてください(戻る時刻は下の詳細に出ていることがあります)。',
    },
  },
  gemini: {
    not_found: {
      title: 'Gemini(Gemini CLI)が入っていません',
      guide: 'Gemini CLI を入れる(例: npm i -g @google/gemini-cli)か、設定画面の「gemini の場所」を直してください。使わない場合は、設定画面で担当を Claude に戻してください。',
    },
    not_logged_in: {
      title: 'Gemini(Gemini CLI)にログインしていません',
      guide: 'ターミナルで gemini を起動してログイン(認証の方法を選ぶ)してください。個人の Google アカウントでは Gemini CLI を使えないことがあります(DECISIONS.md)。そのあとで、もう一度試してください。',
    },
    usage_limit: {
      title: 'Gemini の使用量の上限に達しました',
      guide: '上限が戻るまで待つか、設定画面で担当を Claude に替えてください。',
    },
  },
};

function engineText(kind: FailureKind, engine: EngineId | undefined, field: 'title' | 'guide'): string {
  if (engine && engine !== 'claude') {
    const g = ENGINE_GUIDES[engine][kind];
    if (g) return g[field];
    // そのほかの失敗は、Claude の文言の「Claude」をエンジン名に置き換える
    return GUIDES[kind][field].replace(/Claude/g, ENGINE_SHORT[engine]);
  }
  return GUIDES[kind][field];
}

export function failureTitle(kind: FailureKind, engine?: EngineId): string {
  return engineText(kind, engine, 'title');
}
export function failureGuide(kind: FailureKind, engine?: EngineId): string {
  return engineText(kind, engine, 'guide');
}
export function failureRetryable(kind: FailureKind): boolean {
  return GUIDES[kind].retryable;
}

/** 出力文から失敗の種類を見分ける(文言は DECISIONS.md「失敗の見分け方」「ほかの AI との接続」)。 */
export function classifyFailureText(text: string, engine: EngineId = 'claude'): FailureKind {
  const t = text.toLowerCase();
  // Codex: "You’ve hit your usage limit." / "Your workspace is out of credits."。Gemini: 429 / RESOURCE_EXHAUSTED / "exceeded your current quota"
  if (/hit your .{0,40}limit|usage limit|limit reached|rate limit|out of (extra )?usage|out of credits|resource_exhausted|exceeded your current quota|quota exceeded|\b429\b/.test(t)) return 'usage_limit';
  // ログイン切れの実際の文言(ANSWERS.md 1): "Failed to authenticate: OAuth session expired and could not be refreshed"。
  // "Prompt is too long · automatic compaction failed: Failed to authenticate: …" の形でも出る。
  if (/failed to authenticate|oauth session expired|could not be refreshed|not logged in|please run \/login|invalid api key|authentication[_ ]error|oauth token|unauthorized|\/login/.test(t)) return 'not_logged_in';
  if (engine === 'codex' && /\b401\b|codex login|not signed in|login required/.test(t)) return 'not_logged_in';
  if (engine === 'gemini' && /exit 41|authentication failed|auth method|gemini_api_key|login required|\b401\b/.test(t)) return 'not_logged_in';
  if (/econnreset|enotfound|etimedout|econnrefused|network|fetch failed|connection error|api error|overloaded|socket hang up/.test(t)) return 'network';
  return 'other';
}
