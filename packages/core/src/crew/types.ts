import type { AgentName, EmitInput, JobEnvelopeInput } from "../../contracts";
import type { DbOrTx } from "../db/client";

/** What every crew tool handler receives. The queue and events land in SR-3; fakes stand in for tests. */
export interface ToolContext {
  agent: AgentName;
  requestId: string;
  db: DbOrTx;
  now: () => Date;
  enqueue: (job: JobEnvelopeInput, opts?: { tx?: DbOrTx }) => Promise<{ jobId: string | null }>;
  emit: (event: EmitInput, opts?: { tx?: DbOrTx }) => Promise<void>;
}
