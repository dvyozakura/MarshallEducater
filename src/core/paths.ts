import { join } from 'node:path';

/** プロジェクトフォルダの中の置き場所(CLAUDE.md「データの置き場所」)。 */
export class ProjectPaths {
  constructor(public readonly root: string) {}

  get projectJson() {
    return join(this.root, 'project.json');
  }
  get claudeMd() {
    return join(this.root, 'CLAUDE.md');
  }
  get claudeSettings() {
    return join(this.root, '.claude', 'settings.json');
  }
  get planJson() {
    return join(this.root, 'plan.json');
  }
  get logsDir() {
    return join(this.root, 'logs');
  }
  get subjectsDir() {
    return join(this.root, 'subjects');
  }
  subject(subjectId: string) {
    return new SubjectPaths(join(this.root, 'subjects', subjectId), `subjects/${subjectId}`);
  }
}

export class SubjectPaths {
  /** rel は、プロジェクトフォルダからの相対パス(Claude に伝えるときに使う。区切りは /)。 */
  constructor(
    public readonly root: string,
    public readonly rel: string,
  ) {}

  get unitsJson() {
    return join(this.root, 'units.json');
  }
  get weaknessJson() {
    return join(this.root, 'weakness.json');
  }
  get trendJson() {
    return join(this.root, 'trend.json');
  }
  get trendMd() {
    return join(this.root, 'trend.md');
  }
  get reviewJson() {
    return join(this.root, 'review.json');
  }
  get sourcesDir() {
    return join(this.root, 'sources');
  }
  get testsDir() {
    return join(this.root, 'tests');
  }
  get notesDir() {
    return join(this.root, 'notes');
  }
  get chatsDir() {
    return join(this.root, 'chats');
  }
  source(sourceId: string) {
    return new SourcePaths(join(this.root, 'sources', sourceId), `${this.rel}/sources/${sourceId}`);
  }
  test(testId: string) {
    return new TestPaths(join(this.root, 'tests', testId), `${this.rel}/tests/${testId}`);
  }
  note(unitId: string) {
    return join(this.root, 'notes', `${unitId}.md`);
  }
  chat(chatId: string) {
    return join(this.root, 'chats', `${chatId}.json`);
  }
}

/** 資料(または答案)1つぶんのフォルダ。 */
export class SourcePaths {
  constructor(
    public readonly root: string,
    public readonly rel: string,
  ) {}
  get sourceJson() {
    return join(this.root, 'source.json');
  }
  get originalPdf() {
    return join(this.root, 'original.pdf');
  }
  get pagesDir() {
    return join(this.root, 'pages');
  }
  get figuresDir() {
    return join(this.root, 'figures');
  }
  get extractedJson() {
    return join(this.root, 'extracted.json');
  }
  /** Claude が最初に読み取ったままの内容(補正率の計算に使う)。 */
  get extractedOriginalJson() {
    return join(this.root, 'extracted.original.json');
  }
  get correctionsJson() {
    return join(this.root, 'corrections.json');
  }
  pageName(n: number) {
    return `page-${String(n).padStart(3, '0')}.png`;
  }
  page(n: number) {
    return join(this.root, 'pages', this.pageName(n));
  }
  pageRel(n: number) {
    return `${this.rel}/pages/${this.pageName(n)}`;
  }
}

export class TestPaths {
  constructor(
    public readonly root: string,
    public readonly rel: string,
  ) {}
  get testJson() {
    return join(this.root, 'test.json');
  }
  get answerKeyJson() {
    return join(this.root, 'answer_key.json');
  }
  get verifyJson() {
    return join(this.root, 'verify.json');
  }
  get readingJson() {
    return join(this.root, 'reading.json');
  }
  get gradingJson() {
    return join(this.root, 'grading.json');
  }
  get explanationsMd() {
    return join(this.root, 'explanations.md');
  }
  get explanationsJson() {
    return join(this.root, 'explanations.json');
  }
  get bookletPdf() {
    return join(this.root, 'booklet.pdf');
  }
  get answerSheetPdf() {
    return join(this.root, 'answer_sheet.pdf');
  }
  get explanationsPdf() {
    return join(this.root, 'explanations.pdf');
  }
  /** 紙の答案(資料と同じ構成)。 */
  get submission() {
    return new SourcePaths(join(this.root, 'submission'), `${this.rel}/submission`);
  }
}
