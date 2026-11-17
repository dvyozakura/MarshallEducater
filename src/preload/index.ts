import { contextBridge, ipcRenderer } from 'electron';

// 画面(renderer)に見せる窓口。ここに無いことは画面からはできない。
contextBridge.exposeInMainWorld('me', {
  ping: () => ipcRenderer.invoke('me:ping'),
});
