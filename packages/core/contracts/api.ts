import { z } from "zod";
import { Domain, IsoDateTime } from "./common";
import { ScanCheck } from "./domain";

/** GET /api/score?domain= */
export const ScoreQuery = z.object({ domain: Domain });
export const ScoreResponse = z.object({
  domain: Domain,
  score: z.number().min(0).max(100),
  checks: z.array(ScanCheck),
  reportUrl: z.url(),
  cachedAt: IsoDateTime,
});
export type ScoreResponse = z.infer<typeof ScoreResponse>;
