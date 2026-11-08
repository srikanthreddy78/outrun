import { afterEach, describe, expect, it, vi } from "vitest";

const { authMock, redirectMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock("../../auth", () => ({ auth: authMock, signOut: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

import DashboardLayout from "./layout";

describe("dashboard authentication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("redirects signed-out visitors to GitHub sign-in", async () => {
    authMock.mockResolvedValue(null);
    await expect(DashboardLayout({ children: null })).rejects.toThrow(
      "redirect:/api/auth/signin?callbackUrl=%2Fdashboard",
    );
    expect(redirectMock).toHaveBeenCalledOnce();
  });

  it("redirects signed-in visitors outside the allowlist", async () => {
    vi.stubEnv("AUTH_GITHUB_ALLOWLIST", "team@example.com");
    authMock.mockResolvedValue({ user: { email: "outsider@example.com" } });
    await expect(DashboardLayout({ children: null })).rejects.toThrow("redirect:/access-denied");
  });
});
