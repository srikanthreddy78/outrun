import { PRODUCTS } from "@outrun/core/constants";

export default function Home() {
  return (
    <main
      style={{
        maxWidth: 920,
        margin: "0 auto",
        padding: "64px 24px",
        fontFamily: "system-ui, sans-serif",
        color: "#172824",
      }}
    >
      <nav style={{ display: "flex", justifyContent: "space-between", marginBottom: 72 }}>
        <strong>Outrun</strong>
        <span>
          <a href="/ops">Live ops</a> · <a href="/landing.md">For agents</a> ·{" "}
          <a href="/dashboard">Team sign in</a>
        </span>
      </nav>
      <section>
        <p style={{ color: "#32785d", fontWeight: 700, textTransform: "uppercase", letterSpacing: 2 }}>
          Agent growth department
        </p>
        <h1
          style={{
            fontSize: "clamp(2.4rem, 6vw, 4.8rem)",
            lineHeight: 1.05,
            letterSpacing: "-0.05em",
            maxWidth: 780,
          }}
        >
          Be easier for agents to find, understand, and use.
        </h1>
        <p style={{ fontSize: "1.3rem", lineHeight: 1.5, maxWidth: 650 }}>
          See how ready your product is for agent buyers. Get an evidence-backed public scan, then a full
          Audit + Kit to close the gaps.
        </p>
        <form
          id="scan"
          action="/score"
          method="get"
          style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "36px 0" }}
        >
          <label htmlFor="domain" style={{ alignSelf: "center" }}>
            Your domain
          </label>
          <input
            id="domain"
            name="domain"
            type="text"
            placeholder="example.com"
            required
            style={{ padding: 14, minWidth: 250, flexGrow: 1, fontSize: 16 }}
          />
          <button
            type="submit"
            style={{
              padding: "14px 20px",
              border: 0,
              borderRadius: 5,
              background: "#14563e",
              color: "white",
              fontSize: 16,
            }}
          >
            Run free scan
          </button>
        </form>
        <p>The free scan checks public pages only. It never signs in or submits a form.</p>
      </section>
      <section style={{ marginTop: 80 }}>
        <h2>What you get</h2>
        <ol style={{ lineHeight: 1.9 }}>
          <li>
            A free scan with separate site-readiness and marketing-coverage scores, evidence, and three
            actions.
          </li>
          <li>A full paid audit of the public journey and, with authorized test access, gated areas.</li>
          <li>A Kit with technical fixes, listing copy, positioning, outreach assets, and a 30-day plan.</li>
        </ol>
      </section>
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 24,
          marginTop: 64,
        }}
      >
        <article style={{ padding: 28, border: "2px solid #14563e", borderRadius: 12 }}>
          <p>Primary offer</p>
          <h2>{PRODUCTS.growth.name}</h2>
          <p style={{ fontSize: 28, fontWeight: 700 }}>
            ${PRODUCTS.growth.priceUsd.toLocaleString("en-US")}/month
          </p>
          <p>Initial Audit + Kit, then monthly outbound work, registry submissions, rescans, and reports.</p>
          <a href="/hire">Start with a free trial →</a>
        </article>
        <article style={{ padding: 28, border: "1px solid #9db6a8", borderRadius: 12 }}>
          <p>One-time option</p>
          <h2>{PRODUCTS.auditKit.name}</h2>
          <p style={{ fontSize: 28, fontWeight: 700 }}>${PRODUCTS.auditKit.priceUsd}</p>
          <p>The same initial audit and Kit, without monthly work.</p>
          <a href="#scan">Scan your domain to buy →</a>
        </article>
      </section>
      <footer style={{ marginTop: 80, paddingTop: 24, borderTop: "1px solid #d4ded7" }}>
        <strong>For agents:</strong> <a href="/landing.md">Markdown overview</a> ·{" "}
        <a href="/llms.txt">llms.txt</a> · <a href="/openapi.json">OpenAPI</a> · <a href="/api/mcp">MCP</a> ·{" "}
        <a href="/ops">See the company run live</a>
      </footer>
    </main>
  );
}
