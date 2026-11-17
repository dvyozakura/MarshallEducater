// 偽 Claude の、プロンプトの種類ごとの応答。入力ファイルの内容から、毎回同じ結果を作る。

/** 単元の調整: 先頭の単元を重点にし、最後の単元の最後の子を「扱わない」にし、融合問題を1つ足す。 */
function adjustUnits({ input, mode }) {
  const tree = JSON.parse(JSON.stringify(input.tree));
  if (mode === 'dup_id') {
    // 型は合うが中身がおかしい(ID の重なり)場合の確認用
    tree.push({ ...tree[0], children: [] });
    return { tree, note: 'ID が重なった出力' };
  }
  tree[0].weight = 3;
  if (tree[0].children[0]) tree[0].children[0].weight = 2;
  const last = tree[tree.length - 1];
  if (last.children.length) last.children[last.children.length - 1].weight = 0;
  tree[0].children.push({ id: `${tree[0].id}-90`, name: '融合問題(目標校向け)', weight: 2, children: [] });
  return {
    tree,
    note: `${input.project.examType}・「${input.project.targetLevel}」に合わせて、「${tree[0].name}」を最重点にし、出題の少ない単元を外し、融合問題を足しました。`,
  };
}

/**
 * ページの読み取り。
 * 問題: 1ページにつき2問。前のページ群の続きがあるとき(previousTail)は、先頭を「続き」として返す。
 * 答案: テストの設問ごとに1つ。内容は control.options.scanAnswers(設問番号 → 答案)で指定できる。
 */
function readPages({ input, control, mode }) {
  const unit = input.units?.[0]?.id ?? '';
  if (input.mode === 'answers') {
    const given = control.options?.scanAnswers ?? {};
    const list = input.testProblems ?? [];
    // 複数ページでも、設問は最初のページ群でまとめて返す
    if (input.previousTail) return { problems: [] };
    return {
      problems: list.map((tp, i) => ({
        number: tp.number,
        body: given[tp.number] ?? `(読み取った答案 ${i + 1})`,
        pages: [input.pages[0].page],
        target: mode === 'unmapped' && i === 0 ? null : tp.number,
        uncertain: i === 0 ? [{ text: '', reason: '手書きの数字が 1 か 7 か判別しにくい' }] : [],
      })),
    };
  }
  if (mode === 'bad_page') {
    return { problems: [{ number: '第1問', body: 'ページ番号がおかしい', pages: [999] }] };
  }
  const problems = [];
  input.pages.forEach((pg, idx) => {
    const n = pg.page;
    if (idx === 0 && input.previousTail) {
      problems.push({
        number: input.previousTail.number,
        body: `(続き)ただし $n$ は自然数とする。ページ ${n} にまたがる部分。`,
        pages: [n],
        continuesFromPrevious: true,
      });
    } else {
      problems.push({
        number: `第${n}問 (1)`,
        major: `第${n}問`,
        minor: '(1)',
        points: 10,
        body: `ページ ${n} の最初の問題。2次方程式 $x^2 - ${n + 4}x + ${n * 4} = 0$ を解け。`,
        answerFormat: 'short',
        unit,
        pages: [n],
        figures: n === 1 ? [{ page: 1, bbox: { x: 0.1, y: 0.5, w: 0.4, h: 0.3 }, description: '直角三角形 ABC。AB = 3、BC = 4、角 B が直角。' }] : [],
      });
    }
    problems.push({
      number: `第${n}問 (2)`,
      major: `第${n}問`,
      minor: '(2)',
      points: null,
      body: `ページ ${n} の2つ目の問題。次のうち正しいものを選べ。$$\\int_0^${n} x\\,dx$$`,
      choices: ['ア $\\frac{1}{2}$', 'イ $1$', 'ウ $2$', `エ $\\frac{${n * n}}{2}$`],
      answerFormat: 'choice',
      unit,
      pages: [n],
      uncertain: [{ text: `\\int_0^${n}`, reason: '積分の上端がかすれていて読みにくい' }],
    });
  });
  return { problems };
}

const responders = {
  read_pages: readPages,
  ping: () => ({ ok: true, message: '接続できました' }),
  adjust_units: adjustUnits,
};

export function respond(ctx) {
  const fn = responders[ctx.kind];
  if (!fn) return { error: `偽 Claude は種類 ${ctx.kind} を知りません` };
  return fn(ctx);
}
