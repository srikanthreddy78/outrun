/**
 * What an agent fetches to find and use Outrun, generated from the contracts and PRODUCTS so it
 * can't drift: /llms.txt, /openapi.json and the MCP server card at /.well-known/mcp/server-card.json.
 * The A2A agent card lives next to the A2A handler (a2a.ts).
 */
import { z } from "zod";
import { PUBLIC_TOOLS, ScoreQuery, ScoreResponse, ErrorBody, type PublicToolName } from "../../contracts";
import { PRODUCTS } from "../constants";

const TOOLS = Object.keys(PUBLIC_TOOLS) as PublicToolName[];
const paid = [PRODUCTS.auditKit, PRODUCTS.growth];
const price = (p: (typeof paid)[number]) =>
  `$${p.priceUsd.toLocaleString("en-US")}${p.interval === "month" ? "/month" : ""}`;

export function llmsTxt(appUrl: string): string {
  return `# Outrun

> Outrun checks how ready a business is for AI agents (can an agent find it, read it, and buy from it?) and fixes the gaps. Agents can use every step below without a person: score a domain, get a quote, buy, and track the order.

## For agents
- MCP server (Streamable HTTP, no auth): ${appUrl}/api/mcp
- A2A agent card: ${appUrl}/.well-known/agent-card.json (JSON-RPC at ${appUrl}/api/a2a; send a data part {"skill", "input"})
- OpenAPI: ${appUrl}/openapi.json
- MCP server card: ${appUrl}/.well-known/mcp/server-card.json

## Tools (the same four on MCP and A2A)
${TOOLS.map((t) => `- \`${t}\`: ${PUBLIC_TOOLS[t].description}`).join("\n")}

## Products
- ${PRODUCTS.freeScan.name}: free. ${PRODUCTS.freeScan.deliverables.join(", ")}. ${appUrl}/score/{domain}
${paid.map((p) => `- ${p.name} (\`${p.key}\`): ${price(p)}. ${p.deliverables.join(", ")}.`).join("\n")}

## How to buy
1. \`get_quote\` with your domain and a package.
2. \`buy_audit\` with your domain, the package, a contact email for the report, and your own idempotencyKey. Repeat calls with the same key return the same order.
3. Pay at the returned checkoutUrl (Stripe Checkout).
4. Poll \`get_order_status\` until the state is \`delivered\`; it then carries the report link.

## Limits
- Scores: 20 per caller per hour. New orders: 10 per caller per hour; repeating a key is free.
- Errors have the shape {"error": {"code", "message", "requestId", "retryable"}}.
`;
}

export function mcpServerCard(appUrl: string) {
  return {
    version: "1.0",
    protocolVersion: "2025-06-18",
    serverInfo: { name: "outrun", title: "Outrun", version: "1.0.0" },
    description:
      "Agent-readiness scores, quotes and audit purchases for any domain, with no person in the loop.",
    documentationUrl: `${appUrl}/llms.txt`,
    transport: { type: "streamable-http", endpoint: `${appUrl}/api/mcp` },
    capabilities: { tools: { listChanged: false } },
    authentication: { required: false },
    tools: TOOLS.map((name) => ({
      name,
      description: PUBLIC_TOOLS[name].description,
      inputSchema: z.toJSONSchema(PUBLIC_TOOLS[name].input, { io: "input" }),
    })),
  };
}

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: "output", unrepresentable: "any" });

export function openApi(appUrl: string) {
  const errorRef = { $ref: "#/components/schemas/ErrorBody" };
  const errors = Object.fromEntries(
    ["400", "429", "503"].map((c) => [
      c,
      { description: "Error", content: { "application/json": { schema: errorRef } } },
    ]),
  );
  return {
    openapi: "3.1.0",
    info: {
      title: "Outrun",
      version: "1.0.0",
      description: "Agent-readiness scores, and the A2A endpoint for buying an audit. See /llms.txt.",
    },
    servers: [{ url: appUrl }],
    paths: {
      "/api/score": {
        get: {
          operationId: "getReadinessScore",
          summary: "Agent-readiness score for a domain",
          parameters: [
            { name: "domain", in: "query", required: true, schema: schema(ScoreQuery.shape.domain) },
          ],
          responses: {
            "200": {
              description: "Score",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ScoreResponse" } } },
            },
            ...errors,
          },
        },
      },
      "/api/a2a": {
        post: {
          operationId: "a2a",
          summary: "A2A JSON-RPC 2.0: message/send and tasks/get (see /.well-known/agent-card.json)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["jsonrpc", "id", "method", "params"],
                  properties: {
                    jsonrpc: { const: "2.0" },
                    id: { type: ["string", "number"] },
                    method: { enum: ["message/send", "tasks/get"] },
                    params: { type: "object" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "JSON-RPC response with a Task" } },
        },
      },
    },
    components: {
      schemas: {
        ScoreResponse: schema(ScoreResponse),
        ErrorBody: schema(ErrorBody),
        ...Object.fromEntries(
          TOOLS.flatMap((t) => [
            [`${t}_input`, z.toJSONSchema(PUBLIC_TOOLS[t].input, { io: "input" })],
            [`${t}_output`, schema(PUBLIC_TOOLS[t].output)],
          ]),
        ),
      },
    },
  };
}

/** The markdown alternate link every page carries (MT-3, MT-5); as an HTTP Link header too. */
export const markdownLinkHeader = (path: string): string =>
  `<${path}>; rel="alternate"; type="text/markdown"`;
