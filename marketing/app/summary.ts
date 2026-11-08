/** The summary email for one set of suggestions: what the dashboard previews and what is sent. */
export function summaryEmail(
  appName: unknown,
  insight: Record<string, unknown>,
): { subject: string; text: string } {
  const suggestions = Array.isArray(insight["suggestions"])
    ? (insight["suggestions"] as Record<string, unknown>[])
    : [];
  const list = suggestions.map((s, n) => `${n + 1}. ${s["title"]}\n   ${s["change"]}`).join("\n");
  return {
    subject: `What people are saying about ${appName}`,
    text: `${insight["summary"]}\n\n${list}\n\nThe Outrun team`.replace(/\n{3,}/g, "\n\n"),
  };
}
