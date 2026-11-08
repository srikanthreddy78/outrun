/**
 * Runs once when the Naive-hosted server starts, before any request (deploy/naive-hosted).
 *
 * Naive hands the app `DATABASE_URL` with `sslmode=require`, which libpq reads as "encrypt, don't
 * verify the chain" but node-postgres verifies unless asked to read it the libpq way; the managed
 * pooler's certificate has no root here, so connections would fail. The app also gets no separate
 * unpooled URL, so the queue uses the same one.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const compat = (url: string | undefined): string | undefined => {
    if (!url) return url;
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has("sslmode")) parsed.searchParams.set("uselibpqcompat", "true");
      return parsed.toString();
    } catch {
      return url;
    }
  };
  if (process.env.DATABASE_URL) process.env.DATABASE_URL = compat(process.env.DATABASE_URL);
  process.env.DATABASE_URL_UNPOOLED = compat(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);
}
