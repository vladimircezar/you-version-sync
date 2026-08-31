/**
 * YouVersion OAuth 2.0 authorization-code client with PKCE.
 *
 * Deliberately narrow: it builds the authorize URL, exchanges a code, refreshes,
 * and fetches the JWKS. It never touches the user's credentials, never opens a
 * window, and never persists anything — see `./tokenStore.ts` for storage and
 * `./loopback.ts` for the redirect receiver.
 */
import { ApiErrorSchema, ApiTokenResponse, ApiTokenResponseSchema } from "../models/api";
import { AUTH_ENDPOINTS, HIGHLIGHTS_PERMISSION, SUPPORTED_SCOPES } from "../constants";
import { HttpError, ResilientHttp } from "../sync/http";
import { Jwks, JwksSchema } from "./jwt";
import { PkcePair } from "./pkce";

export interface OAuthConfig {
  /** The `app_key` from the Platform Portal, used as the OAuth `client_id`. */
  appKey: string;
  /** Must byte-for-byte match the callback URL registered in the Portal. */
  redirectUri: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Epoch milliseconds. Derived from `expires_in` at receipt time. */
  expiresAt: number;
  /** Permissions YouVersion actually granted, e.g. `["highlights"]`. */
  grantedPermissions: string[];
  /**
   * Whether YouVersion reported a permission list at all during sign-in.
   * `false` means "not told", which must never be read as "denied".
   */
  permissionsReported?: boolean;
  scope?: string;
}

export interface AuthorizeUrlParams {
  pkce: PkcePair;
  state: string;
  nonce: string;
  /** Adds `require_user_interaction=true`, required on Android. */
  requireUserInteraction?: boolean;
  /** Request the `highlights` data permission alongside identity scopes. */
  requestHighlights?: boolean;
}

/**
 * Build the `/auth/authorize` URL.
 *
 * Note the two distinct concepts: `scope` carries OIDC identity claims only,
 * while `requested_permissions[]` carries data access. Mixing them is a
 * documented error, so `highlights` never appears in `scope`.
 */
export function buildAuthorizeUrl(config: OAuthConfig, params: AuthorizeUrlParams): string {
  const url = new URL(AUTH_ENDPOINTS.authorize);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.appKey);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", SUPPORTED_SCOPES.join(" "));
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.pkce.challenge);
  url.searchParams.set("code_challenge_method", params.pkce.method);
  if (params.requestHighlights !== false) {
    url.searchParams.append("requested_permissions[]", HIGHLIGHTS_PERMISSION);
  }
  if (params.requireUserInteraction) url.searchParams.set("require_user_interaction", "true");
  return url.toString();
}

export class OAuthClient {
  constructor(
    private readonly config: OAuthConfig,
    private readonly http: ResilientHttp,
  ) {}

  /** Exchange an authorization code for tokens. Public client: no secret is sent. */
  async exchangeCode(
    code: string,
    codeVerifier: string,
    grantedPermissions: string[],
    now: number = Date.now(),
  ): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.appKey,
      code_verifier: codeVerifier,
    });
    return toTokenSet(await this.postToken(body), grantedPermissions, now);
  }

  /**
   * Refresh an expired access token. YouVersion may or may not rotate the
   * refresh token; when it omits one we keep the existing value.
   */
  async refresh(
    refreshToken: string,
    grantedPermissions: string[],
    now: number = Date.now(),
  ): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.appKey,
    });
    const parsed = await this.postToken(body);
    const next = toTokenSet(parsed, grantedPermissions, now);
    if (!next.refreshToken) next.refreshToken = refreshToken;
    return next;
  }

  async fetchJwks(): Promise<Jwks> {
    const res = await this.http.send({ url: AUTH_ENDPOINTS.jwks, method: "GET" });
    return JwksSchema.parse(JSON.parse(res.text));
  }

  private async postToken(body: URLSearchParams): Promise<ApiTokenResponse> {
    const res = await this.http.send({
      url: AUTH_ENDPOINTS.token,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    });

    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      throw new HttpError(
        res.status,
        "Token endpoint returned a non-JSON response.",
        AUTH_ENDPOINTS.token,
      );
    }

    const parsed = ApiTokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      // Surface the OAuth error code (e.g. `invalid_grant`) but nothing else.
      const asError = ApiErrorSchema.safeParse(json);
      const detail = asError.success && asError.data.error ? ` (${asError.data.error})` : "";
      throw new HttpError(res.status, `Token exchange failed${detail}.`, AUTH_ENDPOINTS.token);
    }
    return parsed.data;
  }
}

function toTokenSet(res: ApiTokenResponse, grantedPermissions: string[], now: number): TokenSet {
  const expiresInSec = Number(res.expires_in ?? 3600);
  const lifetime = Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : 3600;
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    idToken: res.id_token,
    expiresAt: now + lifetime * 1000,
    grantedPermissions: [...grantedPermissions],
    scope: res.scope,
  };
}
