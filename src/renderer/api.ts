import type { Api } from '../core/api';

declare global {
  interface Window {
    me: {
      call: (method: string, args: unknown[]) => Promise<unknown>;
      onEvent: (cb: (event: unknown) => void) => () => void;
    };
  }
}

type Promisified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
};

/** main 側の機能を呼ぶ。`api.listProjects()` のように使う。 */
export const api = new Proxy(
  {},
  {
    get:
      (_t, method: string) =>
      (...args: unknown[]) =>
        window.me.call(method, args),
  },
) as Promisified<Api>;

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
