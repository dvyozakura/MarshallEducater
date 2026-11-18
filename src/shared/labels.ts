// 画面と印刷の両方で使う、表示用の小さな決まり。

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

/** 選択肢の記号(0始まりの順番 → ①②…)。 */
export const choiceMark = (i: number): string => CIRCLED[i] ?? `(${i + 1})`;
