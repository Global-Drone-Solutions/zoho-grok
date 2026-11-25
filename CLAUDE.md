# CLAUDE.md

Context and rules for AI assistants working in this repository. Read this before changing anything. Human-facing documentation is in `README.md`.

## What this project is

A remote MCP server that lets company staff query Zoho CRM Deals from Grok. Staff authenticate with their company Microsoft account through Supabase Auth acting as an OAuth 2.1 authorization server. The MCP server reads Zoho with one read-only integration account and, from Phase 1, answers statistics from a Postgres copy of Deals.

Two goals drive every design decision:

1. **Accurate statistics**: totals, counts, rankings and trends are computed in Postgres, never by the model adding up records.
2. **No per-user Zoho licence**: staff never authenticate to Zoho. Access control for staff is enforced in this server's code.

## Current state

- **Phase 0 is done**: OAuth sign-in chain works end to end in MCP Inspector and Grok. The only tool is `whoami`.
- **Phases 1–5 are not started**: Deals sync (1), roles/rate limit/audit framework (2), read tools (3), testing (4), manager-only writes (5). Do not assume any table, RPC function or tool from those phases exists unless you find it in the code.

## Stack and layout

- Runtime: **Deno** on Supabase Edge Functions. Imports use `npm:` specifiers pinned to exact versions.
- `supabase/functions/_shared/auth.ts`: `verifyBearer(req)` returns `{ userId, email, clientId }` or `null`.
- `supabase/functions/mcp/index.ts`: Hono app with `basePath("/mcp")`, mcp-lite `McpServer` + `StreamableHttpTransport`, a fresh server built per request (stateless).
- `consent/index.html`: static consent page on Netlify using supabase-js from esm.sh. `consent/_redirects` rewrites all paths to `index.html`.
- `supabase/config.toml`: `verify_jwt = false` for `mcp` (and `sync-deals` when it exists).

Key values (not secrets): Supabase ref `uhwqdkinzofhvdmjumqa`, region `ap-southeast-2`; issuer `https://uhwqdkinzofhvdmjumqa.supabase.co/auth/v1`; consent site `zoho-grok-consent.netlify.app`; company email domain `gdronesolutions.com`; Zoho AU data centre (`accounts.zoho.com.au`, `www.zohoapis.com.au`).

## Commands

```bash
deno cache supabase/functions/mcp/index.ts      # fetch deps
deno check supabase/functions/mcp/index.ts      # type-check (source of truth, not editor squiggles)
npx supabase functions deploy mcp               # deploy MCP server
netlify deploy --prod --dir consent --site zoho-grok-consent   # deploy consent page
npx supabase secrets list                       # list secret names
```

After deploying `mcp`, verify: an unauthenticated POST returns `401` with `www-authenticate: Bearer resource_metadata="…/functions/v1/mcp/.well-known/oauth-protected-resource"`, and that metadata URL returns `authorization_servers: ["https://uhwqdkinzofhvdmjumqa.supabase.co/auth/v1"]`.

## Rules that must not be broken

### Authentication

- Keep `verify_jwt = false` for `mcp`. The function must serve its own `.well-known/oauth-protected-resource` publicly and return its own `401` with the `WWW-Authenticate: Bearer resource_metadata="…"` header. Without these, MCP clients cannot discover how to authorize.
- `verifyBearer` must keep all three checks: JWKS signature, `issuer`, and presence of `client_id` (plus `sub`). The `client_id` check rejects ordinary Supabase session tokens that were not issued to an OAuth client.
- The `resource` value in protected resource metadata must equal the MCP URL exactly.
- Return a bare `unauthorized` to callers. Put rejection reasons only in server logs.
- Never pass Grok's access token to Zoho or any other upstream service, and never expose Zoho tokens to clients.

### Secrets and logging

- Never commit secrets, tokens or `.env` files. Secrets live in `supabase secrets`.
- Never log token values, refresh tokens or Zoho credentials. Logging claim names or error names is fine.
- The Supabase publishable key in `consent/index.html` is public by design.

### Zoho

- The current Zoho token scope is `ZohoCRM.modules.deals.READ` only. Do not widen it. Write access (Phase 5) must use a separate token in a separate secret, used only by write tools.
- Do not sync or return free-text fields (description, notes) unless explicitly asked; they carry PII and prompt-injection risk.
- Zoho returns at most 200 records per page and requires `page_token` beyond 2,000 records. The `fields` parameter is required on list calls (max 50 fields).
- This org uses custom stage names, for example `Invoiced (WON)`. Never hard-code Zoho's default `Closed Won` / `Closed Lost`.

### Dependencies

- Pin every `npm:` and esm.sh import to an exact version published at least 14 days earlier. Never use ranges, bare major versions or `@latest`.
- Deno's minimum dependency age policy will reject very new versions; choose an older release rather than disabling the policy.
- `mcp-lite` has had no release since 2025-11. If a client fails the MCP handshake over protocol version, the fallback is the official `@modelcontextprotocol/sdk` in stateless Streamable HTTP mode; keep the same per-request structure.

### Consent page

- Build DOM with `textContent` / `createElement`, never `innerHTML` with server data. Client names come from dynamic client registration and are attacker-controlled.
- Accept both `redirect_url` and `redirect_to` from `approveAuthorization` and `getAuthorizationDetails`, and redirect immediately if details already contain a redirect (previously approved client).
- Keep the `authorization_id` query string intact through the Microsoft sign-in round trip (`redirectTo: location.href`).

### Tool design (Phase 3 onwards)

- Aggregations run in Postgres RPC functions with whitelisted parameters (enums), never model-written SQL.
- List tools return at most 50 rows and include `total_count`, `returned_count`, `truncated`; statistical tools include `data_as_of`.
- Tool descriptions are written in English and state when to use and when not to use the tool (for example, never count with `search_deals`).
- Tools are registered per request according to the caller's role, so tools a role may not use are absent from `tools/list`.

### Things to ask the user about before changing

- Any Supabase Auth setting: OAuth Server, Authorization Path (`/`), Redirect URLs, Site URL, providers, JWT keys.
- Deleting anything in Supabase → OAuth Apps (deleting Grok's client disconnects every Grok user).
- Revoking the legacy HS256 JWT key.
- Anything touching the Zoho refresh token, scopes or Self Client.
- Adding write capability of any kind.

## Conventions

- Code comments and tool descriptions in English.
- Keep the MCP server stateless: no in-memory sessions, build the server inside the request handler.
- Prefer small, verifiable steps: after each change run `deno check`, deploy, and re-run the curl checks above.
