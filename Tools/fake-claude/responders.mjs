// 偽 Claude の、プロンプトの種類ごとの応答。入力ファイルの内容から、毎回同じ結果を作る。

const responders = {
  ping: () => ({ ok: true, message: '接続できました' }),
};

export function respond(ctx) {
  const fn = responders[ctx.kind];
  if (!fn) return { error: `偽 Claude は種類 ${ctx.kind} を知りません` };
  return fn(ctx);
}
