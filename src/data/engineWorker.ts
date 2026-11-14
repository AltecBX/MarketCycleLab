/// <reference lib="webworker" />
/**
 * Generic engine worker. Runs any exported pure function of an engine module off the main thread:
 * { module: 'signal', fn: 'computeSignalScore', args: [...] }. Arguments and results must be
 * structured-cloneable, which every engine result is.
 */
const modules = import.meta.glob(['../engine/*.ts', '!../engine/*.test.ts']);

interface Req {
  id: number;
  module: string;
  fn: string;
  args: unknown[];
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, module, fn, args } = e.data;
  try {
    const load = modules[`../engine/${module}.ts`];
    if (!load) throw new Error(`Unknown engine module ${module}`);
    const mod = (await load()) as Record<string, unknown>;
    const f = mod[fn];
    if (typeof f !== 'function') throw new Error(`${module}.${fn} is not a function`);
    const result = await (f as (...a: unknown[]) => unknown)(...args);
    (self as unknown as Worker).postMessage({ id, ok: true, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
