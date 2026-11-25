# zoho-grok

Internal MCP (Model Context Protocol) server that lets Global Drone Solutions staff query Zoho CRM **Deals** from Grok in natural language, with accurate statistics and without each person needing a Zoho licence.

Staff sign in with their company Microsoft account. The server knows who is calling on every request, reads Zoho through a single read-only integration account, and (from Phase 1) answers statistical questions from a synced copy of Deals in Postgres, so totals are calculated by the database rather than by the AI model.

## Status

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Sign-in chain: Microsoft → Supabase Auth (OAuth 2.1) → Grok → MCP server; `whoami` tool | **Done** |
| 1 | Sync Zoho Deals into Supabase Postgres every 15 minutes | Not started |
| 2 | Server framework: roles, rate limiting, audit log, email-domain check | Not started |
| 3 | Read tools: `aggregate_deals`, `deal_trend`, `pipeline_snapshot`, `search_deals`, `get_deal` | Not started |
| 4 | Accuracy and security testing, internal pilot | Not started |
| 5 | Manager-only write tools with human confirmation | Later |

Currently the server exposes only `whoami`. It cannot query Deals yet.

## How it works

```
Employee ──(company Microsoft login)──▶ Consent page (Netlify)
                                              │ approve
                                              ▼
Grok ◀──(access token, ES256 JWT)──── Supabase Auth (OAuth 2.1 server)
  │
  │ Bearer token
  ▼
MCP server (Supabase Edge Function `mcp`) ──(read-only integration account)──▶ Zoho CRM (AU)
```

First connection, in short:

1. Grok calls the MCP URL without a token and gets `401` with a `WWW-Authenticate` header pointing to the protected resource metadata.
2. Grok reads that metadata, finds Supabase Auth as the authorization server, reads its metadata and registers itself (dynamic client registration).
3. Grok opens a browser to Supabase `/authorize` (with PKCE). Supabase redirects to the consent page, the employee signs in with Microsoft and clicks **Approve**.
4. Grok exchanges the one-time code (plus its PKCE verifier) for an access token and a refresh token.
5. Every MCP call carries `Authorization: Bearer <token>`. The server verifies the signature (JWKS), the issuer and the presence of `client_id`, then runs the tool as that user.

After the first connection Grok reuses and refreshes its token without asking the employee to sign in again.

Two identities are kept completely separate:

- **Employee identity**: Microsoft → Supabase → Grok → MCP server. Answers "who is asking".
- **Service identity**: MCP server → Zoho, using a refresh token from a Zoho Self Client. Answers "whose Zoho permissions are used to read data". Employees never touch Zoho credentials, and Grok's token is never passed to Zoho.

## Repository layout

```
zoho-grok/
├─ supabase/
│  ├─ config.toml                 # verify_jwt = false for `mcp` (and later `sync-deals`)
│  └─ functions/
│     ├─ _shared/
│     │  └─ auth.ts               # verifyBearer(): JWKS signature, issuer, client_id checks
│     └─ mcp/
│        └─ index.ts              # Hono + mcp-lite; metadata endpoint, 401 handling, tools
├─ consent/
│  ├─ index.html                  # OAuth consent page (Microsoft sign-in + Approve)
│  └─ _redirects                  # Netlify rewrite: every path serves index.html
└─ .vscode/settings.json          # enables the Deno extension for supabase/functions
```

## Infrastructure

| Component | Where | Notes |
| --- | --- | --- |
| Supabase project | `zoho-grok`, ref `uhwqdkinzofhvdmjumqa`, region `ap-southeast-2` (Sydney) | Edge Functions, Auth, (Phase 1+) Postgres |
| MCP endpoint | `https://uhwqdkinzofhvdmjumqa.supabase.co/functions/v1/mcp` | Add this URL as a custom connector in Grok |
| Protected resource metadata | `…/functions/v1/mcp/.well-known/oauth-protected-resource` | Served by `mcp/index.ts` |
| Authorization server metadata | `https://uhwqdkinzofhvdmjumqa.supabase.co/.well-known/oauth-authorization-server/auth/v1` | Served by Supabase |
| Consent page | `https://zoho-grok-consent.netlify.app` (Netlify site `zoho-grok-consent`) | Static HTML |
| Microsoft sign-in | Entra app registration `zoho-grok-login`, single tenant | Only `gdronesolutions.com` accounts can sign in |
| Zoho access | Zoho API Console Self Client, AU data centre | Scope `ZohoCRM.modules.deals.READ` only |

### Supabase Auth settings

- **Sign In / Providers**: Azure enabled with the tenant URL `https://login.microsoftonline.com/<tenant-id>`. Email provider disabled. "Allow new users to sign up" stays **on** (turning it off blocks first-time Microsoft sign-ins).
- **URL Configuration**: Site URL `https://zoho-grok-consent.netlify.app`; Redirect URLs include `https://zoho-grok-consent.netlify.app/**`.
- **OAuth Server** (beta): enabled; Authorization Path `/`; Allow Dynamic OAuth Apps on.
- **JWT Keys**: current signing key is ECC P-256 (ES256). The previous HS256 key is kept; do not revoke it without checking which API keys still depend on it.
- **OAuth Apps**: lists every registered client. Grok's client must not be deleted, or Grok users have to reconnect.

### Secrets

Set with `npx supabase secrets set` and listed with `npx supabase secrets list`. Never commit values.

| Name | Purpose |
| --- | --- |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` | Zoho Self Client |
| `ZOHO_REFRESH_TOKEN` | Read-only Zoho token (Phase 1 onwards) |
| `ZOHO_ACCOUNTS_URL` | `https://accounts.zoho.com.au` |
| `ZOHO_API_DOMAIN` | `https://www.zohoapis.com.au` |
| `ZOHO_API_VERSION` | `v8` |
| `CRON_SECRET` | Shared secret for the Phase 1 sync job |

`SUPABASE_URL` and the service role key are injected by the platform.

## Development

Prerequisites: Supabase CLI (via `npx supabase`), Deno, Netlify CLI, Node.js (for MCP Inspector).

```bash
# Download dependencies and type-check
deno cache supabase/functions/mcp/index.ts
deno check supabase/functions/mcp/index.ts

# Deploy the MCP server
npx supabase functions deploy mcp

# Deploy the consent page
netlify deploy --prod --dir consent --site zoho-grok-consent
```

Dependencies use `npm:` specifiers pinned to exact versions (currently `hono@4.13.17`, `mcp-lite@0.10.0`, `zod@4.6.7`, `jose@5.9.6`). Only pin versions that were published at least two weeks ago; Deno's minimum dependency age policy rejects very new releases.

Editor red underlines on `npm:` imports or `Deno` mean the Deno extension is not active. Install `denoland.vscode-deno`, keep `.vscode/settings.json`, and reload the window. `deno check` is the source of truth.

## Verifying the deployment

```bash
# 1. Unauthenticated call: expect HTTP 401 and a www-authenticate header with resource_metadata
curl -sS -i -X POST https://uhwqdkinzofhvdmjumqa.supabase.co/functions/v1/mcp \
  -H "Content-Type: application/json" -d '{}'

# 2. Protected resource metadata: expect authorization_servers = [".../auth/v1"]
curl -sS https://uhwqdkinzofhvdmjumqa.supabase.co/functions/v1/mcp/.well-known/oauth-protected-resource

# 3. Authorization server metadata: expect authorization, token and registration endpoints
curl -sS https://uhwqdkinzofhvdmjumqa.supabase.co/.well-known/oauth-authorization-server/auth/v1
```

End-to-end: run `npx @modelcontextprotocol/inspector`, add the MCP URL with Streamable HTTP transport and empty OAuth fields, connect, then run `whoami`. It should return your email, user ID and the Inspector's client ID.

Logs: Supabase Dashboard → Edge Functions → `mcp` → Logs. The server returns a bare `unauthorized` to callers on purpose; the reason for a rejected token only appears in server logs.

## Operations

- **Staff leaving**: disabling a Microsoft account stops new sign-ins but does **not** revoke tokens Grok already holds. Also delete or ban the user in Supabase → Authentication → Users.
- **Microsoft client secret** expires 24 months after creation (expiry date: _fill in_). Rotate it in Entra and update the Azure provider in Supabase before it expires, or nobody can sign in.
- **Zoho refresh token** belongs to the Zoho user who generated it. If that user leaves, loses access or revokes the app, Phase 1 sync stops. Plan to regenerate it from a dedicated integration account.
- **Zoho licence terms**: confirm with Zoho that serving data to unlicensed staff through one integration account is permitted.
- **xAI data handling**: deal names contain customer names and are sent to Grok. Confirm xAI's enterprise data terms are acceptable.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| After Microsoft sign-in the browser lands on `localhost:3000` | Return URL is not in Supabase Redirect URLs, so Supabase falls back to the Site URL |
| Consent page URL is two URLs joined together | Authorization Path must be a path (`/`), not a full URL |
| Browser ends on `/undefined` after Approve | Consent page read the wrong redirect field; the page accepts both `redirect_url` and `redirect_to` |
| Consent page stuck on "Loading…" | Script error; check the browser console. Confirm the deployed version with `curl -s https://zoho-grok-consent.netlify.app/ \| grep -c redirectOf` |
| `whoami` returns `unauthorized` after a successful sign-in | Token rejected by `verifyBearer`; check function logs for the reason (expired, issuer, missing claim) |
| `deno cache` says a version is blocked | Version is newer than the minimum dependency age; pick an older release |

## Roadmap

See the Status table above. The full implementation plan for Phases 1–5 (schema, sync job, RPC functions, tool definitions, tests) is kept in the team's implementation handbook.
