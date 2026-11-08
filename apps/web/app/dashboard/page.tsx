const sections = [
  { title: "Approvals", href: "/dashboard/approvals", detail: "Review work waiting for a person." },
  {
    title: "Ops Ledger",
    href: "/dashboard/ledger",
    detail: "Follow the growth pipeline and delivery costs.",
  },
  { title: "Orders", href: "/dashboard/orders", detail: "Track paid audits and delivery." },
  { title: "Agents", href: "/dashboard/agents", detail: "See crew sessions, status, and spend." },
  { title: "Health", href: "/dashboard/health", detail: "Check jobs and integrations." },
] as const;

export default function DashboardHome() {
  return (
    <>
      <h1>Team workspace</h1>
      <p>Keep the crew, orders, and delivery in view.</p>
      <div className="team-cards">
        {sections.map((section) => (
          <a className="team-card" key={section.href} href={section.href}>
            <h2>{section.title}</h2>
            <p>{section.detail}</p>
          </a>
        ))}
      </div>
    </>
  );
}
