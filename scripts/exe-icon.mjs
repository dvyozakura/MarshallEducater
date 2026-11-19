// exe に埋め込まれたアイコンが、.ico の画像(大きさごと)とすべて同じかを調べる(配布用フォルダの exe・インストーラ)。
// 読むのには resedit(@electron/packager・electron-builder がアイコンを書き込むのに使うライブラリ。新しい依存ではない)を使う。
import { readFileSync } from 'node:fs';

export async function checkExeIcon(exePath, icoPath) {
  const ResEdit = await import('resedit');
  const pe = ResEdit.NtExecutable.from(readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(pe);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length === 0) throw new Error('exe にアイコンがありません');
  const ico = ResEdit.Data.IconFile.from(readFileSync(icoPath));
  const b64 = (d) => Buffer.from(d.generate ? d.generate() : (d.bin ?? new Uint8Array())).toString('base64');
  const want = ico.icons.map((i) => b64(i.data));
  // アイコンのまとまりが複数ある exe(インストーラなど)もあるので、どれか1つが一致すればよい
  const match = groups.some((g) => {
    const got = g.getIconItemsFromEntries(res.entries).map(b64);
    return got.length === want.length && want.every((w) => got.includes(w));
  });
  const sizes = ico.icons.map((i) => `${i.width || 256}px`).join('・');
  if (!match) throw new Error(`exe のアイコンが ${icoPath} と違います`);
  return `exe のアイコンは build/icon.ico と同じ(${want.length} 枚: ${sizes})`;
}
