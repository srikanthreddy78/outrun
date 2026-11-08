export default function AccessDeniedPage() {
  return (
    <main style={{ maxWidth: 640, margin: "5rem auto", padding: "0 1.5rem", fontFamily: "system-ui" }}>
      <h1>Access denied</h1>
      <p>This GitHub account is not on the team allowlist.</p>
      <a href="/">Return home</a>
    </main>
  );
}
