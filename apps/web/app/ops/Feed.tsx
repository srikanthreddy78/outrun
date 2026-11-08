import type { FeedItem } from "@outrun/core/autonomy";

const TZ = "America/Los_Angeles";

export function when(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    timeZone: TZ,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A decisions or step-ins list; shared by /ops and the dashboard overview. */
export function Feed({ items, empty }: { items: FeedItem[]; empty: string }) {
  if (!items.length) return <p className="ops-empty">{empty}</p>;
  return (
    <ol className="ops-feed">
      {items.map((i) => (
        <li key={i.id}>
          <div className="ops-feed-meta">
            <span className={`ops-badge ops-badge-${i.actorClass}`}>{i.actor}</span>
            {i.client && <span className="ops-client">{i.client}</span>}
            <time dateTime={i.at}>{when(i.at)}</time>
          </div>
          <p>{i.summary}</p>
        </li>
      ))}
    </ol>
  );
}
