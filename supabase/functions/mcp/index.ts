import { Hono } from "npm:hono@4";
import { McpServer, StreamableHttpTransport } from "npm:mcp-lite"; // 锁定具体版本
import { z } from "npm:zod@4";
import { ISSUER, verifyBearer, type Caller } from "../_shared/auth.ts";

const FN_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/mcp`;
const RESOURCE_METADATA_URL = `${FN_URL}/.well-known/oauth-protected-resource`;

const app = new Hono().basePath("/mcp");

// 1. 受保护资源元数据（RFC 9728）：告诉 Grok 去哪里授权
app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json({
    resource: FN_URL,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
  }),
);

// 2. 每个请求现建一个 server：无状态，且工具可以按调用者组装（阶段 2 用到）
function buildServer(caller: Caller) {
  const mcp = new McpServer({
    name: "zoho-deals",
    version: "0.1.0",
    schemaAdapter: (s) => z.toJSONSchema(s as z.ZodType),
  });
  mcp.tool("whoami", {
    description:
      "Returns the identity of the current caller. Use only to test the connection.",
    handler: () => ({
      content: [{ type: "text", text: JSON.stringify(caller) }],
    }),
  });
  return mcp;
}

// 3. MCP 入口：未认证一律返回带 resource_metadata 的 401
app.all("/", async (c) => {
  const caller = await verifyBearer(c.req.raw);
  if (!caller) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`,
      },
    });
  }
  const handler = new StreamableHttpTransport().bind(buildServer(caller));
  return handler(c.req.raw);
});

Deno.serve(app.fetch);
