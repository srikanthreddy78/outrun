import { loadConfig } from "@outrun/core";
import { createRuntime, type Runtime } from "@outrun/core/runtime";

const g = globalThis as unknown as { __outrunRuntime?: Promise<Runtime> };

/** One runtime per server instance: pool, queue client, registry, integrations. */
export function getRuntime(): Promise<Runtime> {
  g.__outrunRuntime ??= createRuntime(loadConfig(), { poolMax: 3 }).catch((err: unknown) => {
    g.__outrunRuntime = undefined;
    throw err;
  });
  return g.__outrunRuntime;
}
