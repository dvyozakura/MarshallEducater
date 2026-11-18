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

/** 1問だけの読み直し: 前回の内容にヒントを反映した印を付け、自信がない箇所を無くして返す。 */
function rereadProblem({ input }) {
  const p = input.problem;
  return {
    problem: {
      number: p.number,
      major: p.major,
      minor: p.minor,
      points: p.points,
      body: `${p.body}\n(読み直し: ${input.hint || 'ヒントなし'})`,
      choices: p.choices,
      answerFormat: p.answerFormat,
      unit: p.unit,
      target: p.target,
      pages: [input.pages[0].page],
      uncertain: [],
    },
  };
}

const FAKE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 120"><polygon points="20,100 180,100 180,20" fill="none" stroke="#000" stroke-width="2"/><text x="90" y="116" font-size="12">図</text></svg>';

/** モード「名前:1,3」の番号の一覧を取り出す(番号が無ければ「全部」= null)。名前が違えば false。 */
function modeTargets(mode, name) {
  if (mode === name) return null;
  if (!mode.startsWith(`${name}:`)) return false;
  return mode
    .slice(name.length + 1)
    .split(',')
    .map(Number);
}
const hits = (targets, index) => targets !== false && (targets === null || targets.includes(index));

/**
 * 問題の作成: 注文ごとに「a + b を計算せよ」という問題を作る(答えが問題文から決まるので、偽の検算と採点が照らし合わせられる)。
 * 作り直し(avoid あり)では数を変える。モード with_figure / bad_svg[:番号] で図を付ける。
 */
function generateProblems({ input, mode }) {
  const badSvg = modeTargets(mode, 'bad_svg');
  const withFigure = modeTargets(mode, 'with_figure');
  return {
    problems: input.requests.map((r) => {
      const a = 10 + r.index * 3 + (r.avoid ? 100 : 0) + (r.reference ? 50 : 0);
      const b = 7;
      const sum = a + b;
      const base = { unitId: r.unitId, difficulty: r.difficulty, format: r.format, points: r.format === 'essay' ? 20 : 10, figureSvg: null };
      if (!r.noFigure && hits(badSvg, r.index)) base.figureSvg = '<svg><script>alert(1)</script></svg>';
      else if (!r.noFigure && hits(withFigure, r.index)) base.figureSvg = FAKE_SVG;
      const head = `【${r.unitName}・${r.origin}${input.trend ? '・傾向反映' : ''}】`;
      const solution = `$${a}$ と $${b}$ を足すと $${sum}$。`;
      if (r.format === 'choice') {
        return { ...base, body: `${head} $${a} + ${b}$ の値として正しいものを選べ。`, choices: [`$${sum - 1}$`, `$${sum}$`, `$${sum + 1}$`, `$${sum + 10}$`], answer: '2', rubric: '', solution };
      }
      if (r.format === 'essay') {
        return { ...base, body: `${head} $${a} + ${b}$ を計算し、考え方も説明せよ。`, answer: `一の位と十の位に分けて足す。答えは ${sum}。`, rubric: '考え方の説明 10点、答え 10点', solution };
      }
      return { ...base, body: `${head} $${a} + ${b}$ を計算せよ。`, answer: `$${sum}$`, rubric: '数値が合っていれば正解', solution };
    }),
  };
}

/** 偽の問題文「$a + b$」から、正しい答え(和)を出す。 */
function sumOf(body) {
  const m = body.match(/\$(\d+) \+ (\d+)\$/);
  return m ? Number(m[1]) + Number(m[2]) : null;
}

/** 検算の解き直し: 問題文から計算して答える。モード wrong[:番号] は誤答、issue[:番号] は「問題の不備」を返す。 */
function solveProblems({ input, mode }) {
  const wrong = modeTargets(mode, 'wrong');
  const issue = modeTargets(mode, 'issue');
  return {
    answers: input.problems.map((p) => {
      if (hits(issue, p.index)) return { index: p.index, answer: '', issue: '条件が足りず、答えが1つに決まらない' };
      const sum = (sumOf(p.body) ?? 0) + (hits(wrong, p.index) ? 1 : 0);
      if (p.format === 'choice') {
        const n = p.choices.findIndex((c) => c.replace(/\$/g, '') === String(sum));
        return { index: p.index, answer: String(n >= 0 ? n + 1 : 1), issue: '' };
      }
      // 短答は、書き方だけ変えて答える(照らし合わせの確認用)
      if (p.format === 'short') return { index: p.index, answer: mode === 'reworded' ? `答えは ${sum} です` : `${sum}`, issue: '' };
      return { index: p.index, answer: `位ごとに分けて足すと、答えは ${sum} になる。`, issue: '' };
    }),
  };
}

/** 検算の照らし合わせ: 解き直しの答えに、作成時の答えの数が含まれていれば一致。モード reject はすべて不一致。 */
function judgeAnswers({ input, mode }) {
  return {
    results: input.items.map((it) => {
      const key = (it.key.match(/\d+/g) ?? []).at(-1);
      const match = mode !== 'reject' && !!key && (it.solved.match(/\d+/g) ?? []).includes(key);
      return { index: it.index, match, reason: match ? '' : `作成時の答えは ${key}、解き直しは「${it.solved.slice(0, 30)}」` };
    }),
  };
}

/** テストの設計: 単元を広く拾い、難易度を混ぜる。共通テスト型はすべて選択式。問題数は control.options.designCount(既定 4)。 */
function designTest({ input, control, mode }) {
  const n = control.options?.designCount ?? 4;
  const diffs = ['easy', 'standard', 'target'];
  const formats = input.project.examType === '共通テスト' ? ['choice'] : ['choice', 'short', 'essay', 'short'];
  const items = [];
  for (let i = 0; i < n; i++) {
    const unit = input.units[Math.floor((i * input.units.length) / n) % input.units.length];
    items.push({ unitId: unit.id, difficulty: diffs[i % 3], format: formats[i % formats.length] });
  }
  if (mode === 'bad_unit') items[0].unitId = 'zzz';
  return { timeLimitMin: input.kind === 'mock' ? 90 : 40, instructions: '分からない問題は空欄でかまいません。途中の式も書いてください。', items };
}

/**
 * 採点: 偽の問題(a + b)の和が答案に入っていれば満点。記述は、和が無くても「足」と書いてあれば半分(部分点)。
 * モード no_mistake は、減点があるのにミスの種類を付けない(やり直しの確認用)。strict は記述をすべて 0 点にする。
 */
function grade({ input, mode }) {
  return {
    items: input.items.map((it) => {
      const sum = String(sumOf(it.body));
      let score = 0;
      if (it.format === 'choice') score = it.answer === it.key ? it.points : 0;
      else if ((it.answer.match(/\d+/g) ?? []).includes(sum)) score = it.points;
      else if (it.format === 'essay' && it.answer.includes('足') && mode !== 'strict') score = it.points / 2;
      if (score >= it.points) return { problemId: it.problemId, score, rationale: '正解と一致', mistake: null, comment: '' };
      const mistake = mode === 'no_mistake' ? null : it.format === 'choice' ? 'misread' : it.format === 'short' ? 'calculation' : score > 0 ? 'calculation' : 'approach';
      return {
        problemId: it.problemId,
        score,
        rationale: it.format === 'essay' ? `考え方の説明 ${score}/${it.points / 2}、答え 0/${it.points / 2}` : `正解は ${it.key}、答案は ${it.answer.slice(0, 20)}`,
        mistake,
        comment: `${it.unitName} の問題で、和の計算を誤っています。位をそろえて確かめましょう。`,
      };
    }),
  };
}

/** 傾向: 渡された過去問の設問から、形式・大問・単元を数えてまとめる。 */
function trend({ input }) {
  const all = input.sources.flatMap((s) => s.problems);
  const count = (key) => {
    const m = new Map();
    for (const p of all) if (p[key]) m.set(p[key], (m.get(p[key]) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const formats = count('answerFormat');
  const label = { choice: '選択式', short: '短答', essay: '記述', other: 'その他' };
  return {
    format: `${label[formats[0]?.[0]] ?? '不明'}が中心(${formats.map(([f, n]) => `${label[f]} ${n} 問`).join('、')})`,
    structure: count('major').map(([m, n]) => ({ label: m, description: `小問 ${n} 問` })),
    frequentUnits: count('unitName')
      .slice(0, 5)
      .map(([u, n]) => ({ unit: u, note: `${n} 問` })),
    volume: `過去問 ${input.sources.length} 件で、設問は合わせて ${all.length} 問`,
    timeAllocation: '分量からの推定: 大問1つにつき 20 分',
    difficulty: '標準的な問題が中心',
    summaryMd: [
      `## ${input.subject} の傾向`,
      '',
      `- 過去問 ${input.sources.length} 件(${input.sources.map((s) => s.title).join('、')})をもとにしています。`,
      `- ${input.previous ? '前回のまとめを更新しました。' : '初めてのまとめです。'}`,
      '- 数式の例: $x^2$',
    ].join('\n'),
  };
}

/** 学習計画: 週ごとに、科目へ時間を等分し、弱い単元(無ければ先頭の単元)を割り当てる。モード short_weeks は週を1つ減らす。 */
function plan({ input, mode }) {
  const weeks = input.weeks.map((w, i) => {
    const last = i === input.weeks.length - 1;
    const budget = Math.floor((input.dailyMinutes * w.days * 0.8) / Math.max(1, input.subjects.length));
    return {
      theme: last ? '総復習と体調の調整' : w.mock ? '通しの模擬試験と、その復習' : i < input.weeks.length / 2 ? '苦手の克服と基礎固め' : '志望校の形式での演習',
      items: input.subjects.map((s) => {
        const weak = s.weakUnits.map((u) => u.unitId);
        const pool = weak.length ? weak : s.units.map((u) => u.id);
        return {
          subjectId: s.id,
          unitIds: [pool[i % pool.length], pool[(i + 1) % pool.length]].filter((v, k, a) => a.indexOf(v) === k),
          minutes: budget,
          goal: weak.length ? '弱い単元を標準レベルまで引き上げる' : '基本事項の確認',
        };
      }),
    };
  });
  if (mode === 'short_weeks') weeks.pop();
  return {
    weeks,
    advice: input.progress ? `作り直しました(理由: ${input.progress.reason})。量を減らし、弱い単元を優先します。` : `最初の計画です。${input.weeks.length} 週で、弱い単元から順に固めます。`,
  };
}

/** 解説: 設問ごとに、考え方・解き方・一言。モード missing は最後の設問を落とす(やり直しの確認用)。 */
function explain({ input, mode }) {
  const items = input.items.map((it) => {
    const m = it.body.match(/\$(\d+) \+ (\d+)\$/);
    const sum = sumOf(it.body);
    return {
      problemId: it.problemId,
      thinking: `${it.unitName} の問題です。足し算は、位をそろえて一の位から順に考えます。`,
      solution: m ? `$${m[1]} + ${m[2]} = ${sum}$ なので、正解は ${it.key} です。${it.answer ? `あなたの答案「${it.answer.slice(0, 20)}」は、ここが違います。` : '未解答でした。まず式を書き出しましょう。'}` : `正解は ${it.key} です。`,
      tip: it.mistake === 'blank' || it.mistake === 'timeout' ? '分からなくても、最初の一歩(式を書く)だけは書きましょう。' : '計算のあとに、逆算(引き算)で確かめましょう。',
    };
  });
  if (mode === 'missing') items.pop();
  return { items };
}

/** 授業ノート: 要点・例題・よくある誤り・確認問題。苦手の記録や前のノートがあれば、その印を入れる。 */
function note({ input }) {
  return {
    markdown: [
      `# ${input.unit.name}`,
      '',
      `${input.project.university} ${input.project.faculty} 向け${input.previous ? '(作り直し)' : ''}。`,
      '',
      '## 要点',
      '- 三平方の定理: $a^2 + b^2 = c^2$',
      input.trend ? '- 志望校の傾向に合わせた補足。' : '- 基本事項を順に確かめる。',
      '',
      '## 例題',
      '**問題** $3^2 + 4^2$ を計算せよ。',
      '',
      '**考え方** 2乗してから足す。',
      '',
      '**解答** $$3^2 + 4^2 = 25$$',
      '',
      '## よくある誤り',
      input.weakness ? `- この単元の習熟度は ${input.weakness.mastery}。間違えた問題 ${input.mistakes.length} 件を踏まえた注意。` : '- 2乗と2倍を取り違える。',
      '',
      '## 確認問題',
      '1. $5^2 + 12^2$ を計算せよ。(答え: $169$)',
    ].join('\n'),
  };
}

/** 質問: 質問の文と、渡された文脈(問題・答案・採点・解説・ノート・苦手マップ・これまでのやりとり)が分かる答えを返す。 */
function chat({ input }) {
  const c = input.context;
  const parts = [`「${input.question}」への答えです。`];
  if (c.problem) parts.push(`問題: ${c.problem.number}(${c.problem.key ? `正解は ${c.problem.key}` : '正解はまだ見せません'})。`);
  if (c.answer !== null) parts.push(`あなたの答案: ${c.answer || '未解答'}。`);
  if (c.grading) parts.push(`採点: ${c.grading.score} / ${c.grading.max}${c.grading.mistake ? `(${c.grading.mistake})` : ''}。`);
  if (c.explanation) parts.push('解説を踏まえています。');
  if (c.note) parts.push(`授業ノート「${c.note.unitName}」を踏まえています。`);
  parts.push(`苦手マップ: 弱い単元 ${input.weakness.units.length} 件。`);
  parts.push(`これまでのやりとり: ${input.history.length} 件。`);
  parts.push('式で書くと $x^2 \\geq 0$ です。');
  return { answer: parts.join('\n\n') };
}

const responders = {
  explain,
  note,
  chat,
  plan,
  trend,
  grade,
  design_test: designTest,
  generate_problems: generateProblems,
  solve_problems: solveProblems,
  judge_answers: judgeAnswers,
  read_pages: readPages,
  reread_problem: rereadProblem,
  ping: () => ({ ok: true, message: '接続できました' }),
  adjust_units: adjustUnits,
};

export function respond(ctx) {
  const fn = responders[ctx.kind];
  if (!fn) return { error: `偽 Claude は種類 ${ctx.kind} を知りません` };
  return fn(ctx);
}
