/** Claude の呼び出しが失敗した理由の種類。 */
export type FailureKind =
  | 'not_found' // claude が見つからない
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

export function failureTitle(kind: FailureKind): string {
  return GUIDES[kind].title;
}
export function failureGuide(kind: FailureKind): string {
  return GUIDES[kind].guide;
}
export function failureRetryable(kind: FailureKind): boolean {
  return GUIDES[kind].retryable;
}

/** claude の出力文から失敗の種類を見分ける(文言は DECISIONS.md「失敗の見分け方」)。 */
export function classifyFailureText(text: string): FailureKind {
  const t = text.toLowerCase();
  if (/hit your .{0,40}limit|usage limit|limit reached|rate limit|out of (extra )?usage/.test(t)) return 'usage_limit';
  // ログイン切れの実際の文言(ANSWERS.md 1): "Failed to authenticate: OAuth session expired and could not be refreshed"。
  // "Prompt is too long · automatic compaction failed: Failed to authenticate: …" の形でも出る。
  if (/failed to authenticate|oauth session expired|could not be refreshed|not logged in|please run \/login|invalid api key|authentication[_ ]error|oauth token|unauthorized|\/login/.test(t)) return 'not_logged_in';
  if (/econnreset|enotfound|etimedout|econnrefused|network|fetch failed|connection error|api error|overloaded|socket hang up/.test(t)) return 'network';
  return 'other';
}
