import { loadDashboardSnapshot } from "../../../lib/dashboard-live";

export default async function OrdersPage() {
  const { orders } = await loadDashboardSnapshot();
  return (
    <>
      <h1>Orders</h1>
      <p>Latest paid work and delivery state.</p>
      <div className="team-table-wrap">
        <table className="team-table">
          <thead>
            <tr>
              <th>Domain</th>
              <th>Product</th>
              <th>State</th>
              <th>Amount</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id}>
                <td>{order.domain}</td>
                <td>{order.product}</td>
                <td>{order.state}</td>
                <td>${Number(order.amountUsd).toFixed(2)}</td>
                <td>{order.createdAt.toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {orders.length === 0 && <p>No orders yet.</p>}
    </>
  );
}
