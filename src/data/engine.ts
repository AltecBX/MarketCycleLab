/**
 * Run engine functions off the main thread. Heavy studies (model validation, analog search,
 * universe scans) go through here so scrolling and ticker changes never wait on them.
 */
import { cached, useAsync } from './client';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const getWorker = (): Worker | null => {
  if (typeof Worker === 'undefined') return null;
  if (!worker) {
    worker = new Worker(new URL('./engineWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error ?? 'Engine task failed'));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Engine worker failed'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
};

/** Call `module.fn(...args)` in the engine worker. Falls back to the main thread without Worker support. */
export const runEngine = async <T,>(module: string, fn: string, args: unknown[]): Promise<T> => {
  const w = getWorker();
  if (!w) {
    const mods = import.meta.glob(['../engine/*.ts', '!../engine/*.test.ts']);
    const mod = (await mods[`../engine/${module}.ts`]!()) as Record<string, (...a: unknown[]) => unknown>;
    return (await mod[fn]!(...args)) as T;
  }
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ id, module, fn, args });
  });
};

/**
 * Hook form. `key` must capture every input that changes the result (symbol, as-of, settings).
 * Pass null to skip.
 */
export const useEngine = <T,>(key: string | null, module: string, fn: string, args: () => unknown[]) =>
  useAsync<T>(key ? `engine:${module}.${fn}:${key}` : null, () => cached(`enginecall:${module}.${fn}:${key}`, () => runEngine<T>(module, fn, args())));
