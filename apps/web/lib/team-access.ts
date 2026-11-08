import { isAllowedTeamAccount } from "@outrun/core/dashboard/views";

type GithubEmail = { email?: unknown; primary?: unknown; verified?: unknown };

export async function verifiedAllowedGithubEmail(
  accessToken: string | undefined,
  allowlist: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  if (!accessToken || !allowlist.trim()) return null;
  try {
    const response = await fetcher("https://api.github.com/user/emails", {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2026-03-10",
        "user-agent": "Outrun-Dashboard/1.0",
      },
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const emails: unknown = await response.json();
    if (!Array.isArray(emails)) return null;
    const primary = (emails as GithubEmail[]).find(
      (entry) => entry.primary === true && entry.verified === true && typeof entry.email === "string",
    );
    const email = typeof primary?.email === "string" ? primary.email.trim().toLowerCase() : null;
    return email && isAllowedTeamAccount(email, allowlist) ? email : null;
  } catch {
    return null;
  }
}

export function dashboardAccess(email: string | null | undefined, allowlist: string): boolean {
  return isAllowedTeamAccount(email, allowlist);
}
