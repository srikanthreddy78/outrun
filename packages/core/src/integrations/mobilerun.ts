import { randomUUID } from "node:crypto";
import { z } from "zod";
import { scrubText } from "../crew/scrub";
import { normalizeDomain } from "../scan/scan";

const API = "https://api.mobilerun.ai/v1";
const TaskStarted = z.object({ id: z.string().min(1), status: z.string() });
const TaskStatus = z.object({
  status: z.string(),
  succeeded: z.boolean().nullable().optional(),
  output: z.unknown().optional(),
  message: z.string().nullable().optional(),
});
const Output = z.object({
  reachable: z.boolean(),
  primaryActionVisible: z.boolean(),
  steps: z.array(z.string()).max(20),
  wall: z.enum(["none", "signup", "payment", "unknown"]),
  notes: z.string(),
});

export type MobileOnboardingCheck = {
  domain: string;
  taskId: string;
  status: "pass" | "fail" | "unknown";
  evidence: string;
  steps: string[];
  wall: "none" | "signup" | "payment" | "unknown";
};

export function createMobilerunClient(key: string, deviceId: string, fetcher: typeof fetch = fetch) {
  if (!key || !deviceId) throw new Error("Mobilerun key and device ID are required");
  const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
  return {
    async start(domain: string, idempotencyKey: string = randomUUID()): Promise<string> {
      const normalized = normalizeDomain(domain);
      const response = await fetcher(`${API}/tasks`, {
        method: "POST",
        headers: { ...headers, "idempotency-key": idempotencyKey },
        body: JSON.stringify({
          deviceId,
          task: `Open https://${normalized}/ in the mobile browser. Observe the first primary action and follow public onboarding navigation only. Do not type into forms, submit anything, sign in, purchase, change settings, or send messages. Stop at a signup or payment wall. Return only the observed steps and evidence.`,
          maxSteps: 10,
          outputSchema: {
            type: "object",
            properties: {
              reachable: { type: "boolean" },
              primaryActionVisible: { type: "boolean" },
              steps: { type: "array", items: { type: "string" } },
              wall: { type: "string", enum: ["none", "signup", "payment", "unknown"] },
              notes: { type: "string" },
            },
            required: ["reachable", "primaryActionVisible", "steps", "wall", "notes"],
            additionalProperties: false,
          },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Mobilerun task start HTTP ${response.status}`);
      return TaskStarted.parse(await response.json()).id;
    },
    async status(taskId: string): Promise<z.infer<typeof TaskStatus>> {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(taskId)) throw new Error("Invalid Mobilerun task ID");
      const response = await fetcher(`${API}/tasks/${taskId}/status`, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Mobilerun task status HTTP ${response.status}`);
      return TaskStatus.parse(await response.json());
    },
  };
}

export async function runMobileOnboardingCheck(
  client: ReturnType<typeof createMobilerunClient>,
  domain: string,
  opts: { maxPolls?: number; wait?: () => Promise<void>; idempotencyKey?: string } = {},
): Promise<MobileOnboardingCheck> {
  const normalized = normalizeDomain(domain);
  const taskId = await client.start(normalized, opts.idempotencyKey);
  const wait = opts.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 5_000)));
  for (let i = 0; i < (opts.maxPolls ?? 60); i++) {
    const state = await client.status(taskId);
    if (state.succeeded === false)
      return {
        domain: normalized,
        taskId,
        status: "unknown",
        evidence: scrubText(state.message ?? "Mobile task failed"),
        steps: [],
        wall: "unknown",
      };
    if (state.succeeded === true) {
      let output = state.output;
      if (typeof output === "string") {
        try {
          output = JSON.parse(output);
        } catch {
          output = null;
        }
      }
      const parsed = Output.safeParse(output);
      if (!parsed.success)
        return {
          domain: normalized,
          taskId,
          status: "unknown",
          evidence: "Mobile task returned no structured result",
          steps: [],
          wall: "unknown",
        };
      const value = parsed.data;
      return {
        domain: normalized,
        taskId,
        status: value.reachable && value.primaryActionVisible ? "pass" : "fail",
        evidence: scrubText(value.notes).slice(0, 1000),
        steps: value.steps.map((step) => scrubText(step).slice(0, 300)),
        wall: value.wall,
      };
    }
    await wait();
  }
  throw new Error("Mobilerun task did not finish within the polling window");
}
