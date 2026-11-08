export function EmptySection({ title, description }: { title: string; description: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p>{description}</p>
      <div className="team-card" style={{ marginTop: 32 }}>
        <p>Data will appear here when available.</p>
      </div>
    </>
  );
}
