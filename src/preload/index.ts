import { contextBridge, ipcRenderer } from 'electron';

// 画面(renderer)に見せる窓口。画面からは、ここを通してしか main 側の機能を使えない。
contextBridge.exposeInMainWorld('me', {
  /** main 側の機能(src/core/api.ts の一覧にあるものだけ)を呼ぶ。 */
  call: async (method: string, args: unknown[]) => {
    const r = await ipcRenderer.invoke('me:call', method, args);
    if (r && r.ok) return r.value;
    const err = new Error(r?.error?.message ?? '不明なエラー');
    (err as Error & { kind?: string }).kind = r?.error?.kind ?? undefined;
    throw err;
  },
  /** main 側からの知らせ(ジョブの状態の変化など)を受け取る。戻り値は解除の関数。 */
  onEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, event: unknown) => cb(event);
    ipcRenderer.on('me:event', listener);
    return () => ipcRenderer.removeListener('me:event', listener);
  },
});
