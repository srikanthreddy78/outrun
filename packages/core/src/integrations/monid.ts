/**
 * SH-3: Monid over HTTP. A run is started, then polled until it finishes; statuses are UPPERCASE.
 * `endpoint` is "provider:/path", e.g. "akta:/v1/company/enrichment". Paid: every call costs.
 */
import { AppError } from "../errors";
import { getJson, postJson } from "./http";
import type { MonidClient } from "./types";

const BASE = "https://api.monid.ai";
const DONE = new Set(["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"]);

interface MonidRun {
  id?: string;
  runId?: string;
  status?: string;
  output?: unknown;
  providerResponse?: { status?: number; httpStatus?: number; data?: unknown };
  cost?: { value?: number };
  error?: { message?: string };
}

export function createMonidClient(
  apiKey: string,
  opts: { sleep?: (ms: number) => Promise<void>; maxWaitMs?: number } = {},
): MonidClient {
  const headers = { authorization: `Bearer ${apiKey}` };
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  return {
    async run(endpoint, input) {
      const at = endpoint.indexOf(":");
      if (at < 1) throw new AppError("bad_request", `monid endpoint must be provider:/path, got ${endpoint}`);
      let run = await postJson<MonidRun>(
        `${BASE}/v1/run`,
        { provider: endpoint.slice(0, at), endpoint: endpoint.slice(at + 1), input },
        {
          headers,
          timeoutMs: 30_000,
          provider: "monid",
          // A run the provider answered with a 4xx comes back as that status, with the run as body.
          acceptStatus: (st) => st >= 400 && st < 500 && ![401, 402, 403, 429].includes(st),
        },
      );
      const id = run.id ?? run.runId;
      let waited = 0;
      for (
        let delay = 1000;
        !DONE.has(run.status ?? "") && waited < (opts.maxWaitMs ?? 120_000);
        delay = Math.min(delay * 2, 8000)
      ) {
        if (!id) throw new AppError("upstream_error", "monid: run has no id");
        await sleep(delay);
        waited += delay;
        run = await getJson<MonidRun>(`${BASE}/v1/runs/${encodeURIComponent(id)}`, {
          headers,
          timeoutMs: 30_000,
          provider: "monid",
        });
      }
      if (run.status !== "COMPLETED")
        throw new AppError("upstream_error", `monid: run ${id ?? "?"} ended ${run.status ?? "unknown"}`, {
          retryable: run.status === undefined || !DONE.has(run.status),
        });
      // The live API calls it httpStatus; older responses used status.
      const http = run.providerResponse?.httpStatus ?? run.providerResponse?.status;
      // Not found: the provider knows nothing about it. That is an empty answer, not a failure.
      if (http === 404) return { data: null, costUsd: run.cost?.value ?? 0 };
      if (http && http >= 400)
        throw new AppError("upstream_error", `monid: provider HTTP ${http}`, { retryable: http >= 500 });
      const data = run.providerResponse?.data ?? run.output ?? null;
      // A run that finishes inside the POST comes back without its cost; the run record has it.
      if (run.cost?.value === undefined && id) {
        const billed = await getJson<MonidRun>(`${BASE}/v1/runs/${encodeURIComponent(id)}`, {
          headers,
          timeoutMs: 30_000,
          provider: "monid",
        }).catch(() => null);
        return { data, costUsd: billed?.cost?.value ?? 0 };
      }
      return { data, costUsd: run.cost?.value ?? 0 };
    },
  };
}
