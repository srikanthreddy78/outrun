import { describe, expect, it } from "vitest";
import { createMobilerunClient, runMobileOnboardingCheck } from "./mobilerun";

describe("Mobilerun mobile onboarding check", () => {
  it("runs a bounded, read-only phone task and returns structured evidence", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let polls = 0;
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input).endsWith("/tasks")) return Response.json({ id: "task_1", status: "queued" });
      polls++;
      return Response.json(
        polls === 1
          ? { status: "running", succeeded: null }
          : {
              status: "completed",
              succeeded: true,
              output: {
                reachable: true,
                primaryActionVisible: true,
                steps: ["Opened home", "Found Get Started"],
                wall: "signup",
                notes: "Signup wall observed",
              },
            },
      );
    };
    const client = createMobilerunClient("test-key", "device-1", fetcher as typeof fetch);
    const result = await runMobileOnboardingCheck(client, "example.com", {
      maxPolls: 3,
      wait: async () => {},
    });
    expect(result).toMatchObject({ domain: "example.com", status: "pass", wall: "signup" });
    expect(requests).toHaveLength(3);
    const body = JSON.parse(String(requests[0]?.init?.body));
    expect(body.maxSteps).toBe(10);
    expect(body.task).toContain("Do not type into forms");
    expect(requests[0]?.init?.headers).toMatchObject({ "idempotency-key": expect.any(String) });
  });

  it("marks a failed task unknown and rejects invalid domains", async () => {
    const fetcher = async (input: string | URL | Request) =>
      Response.json(
        String(input).endsWith("/tasks")
          ? { id: "task_2", status: "queued" }
          : { status: "failed", succeeded: false, message: "Device unavailable" },
      );
    const client = createMobilerunClient("test-key", "device-1", fetcher as typeof fetch);
    expect((await runMobileOnboardingCheck(client, "example.com")).status).toBe("unknown");
    await expect(runMobileOnboardingCheck(client, "http://127.0.0.1")).rejects.toThrow();
  });
});
