import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const ISSUER = `${SUPABASE_URL}/auth/v1`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

export type Caller = { userId: string; email: string; clientId: string };

export async function verifyBearer(req: Request): Promise<Caller | null> {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1], JWKS, { issuer: ISSUER });
    // Only accept tokens issued through the OAuth flow to a registered client (e.g. Grok),
    // not ordinary Supabase session tokens from signing in on the consent page.
    // ⚠️ Verify the claim name that carries the client ID in OAuth-issued tokens.
    const clientId = payload.client_id as string | undefined;
    if (!clientId || !payload.sub) {
      return null;
    }
    return {
      userId: payload.sub,
      email: String(payload.email ?? ""),
      clientId,
    };
  } catch {
    return null;
  }
}
