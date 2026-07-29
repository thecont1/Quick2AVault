export interface StoredOAuthTokensInput {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number;
  scope?: string;
  tokenType?: string;
  updatedAt?: Date;
}

export interface StoredOAuthTokens extends StoredOAuthTokensInput {
  updatedAt: Date;
}

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const EXPIRY_SKEW_MS = 60 * 1000;

export interface GoogleAuthorizationUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  mailbox: string;
}

export function buildGoogleAuthorizationUrl(input: GoogleAuthorizationUrlInput): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_GMAIL_SCOPES.join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent select_account",
    include_granted_scopes: "true",
    login_hint: input.mailbox,
  });
  return `${GOOGLE_AUTHORIZE_URL}?${params}`;
}

export function parseOAuthCallback(callbackUrl: string, expectedState: string): { code: string } {
  const url = new URL(callbackUrl);
  if (url.searchParams.get("state") !== expectedState) throw new Error("OAuth state mismatch.");
  const providerError = url.searchParams.get("error");
  if (providerError) throw new Error(`Google OAuth failed: ${providerError}`);
  const code = url.searchParams.get("code");
  if (!code) throw new Error("Google OAuth returned no authorization code.");
  return { code };
}

export function isStoredTokenFresh(
  tokens: Pick<StoredOAuthTokens, "accessToken" | "expiresIn" | "updatedAt">,
  now = new Date(),
): boolean {
  if (!tokens.accessToken || !tokens.expiresIn) return false;
  return tokens.updatedAt.getTime() + tokens.expiresIn * 1000 - EXPIRY_SKEW_MS > now.getTime();
}

export function googleTokenInput(
  payload: Record<string, unknown>,
  previousRefreshToken?: string,
): StoredOAuthTokensInput {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!accessToken) throw new Error("Google OAuth returned no access token.");
  return {
    accessToken,
    refreshToken:
      typeof payload.refresh_token === "string" ? payload.refresh_token : previousRefreshToken,
    idToken: typeof payload.id_token === "string" ? payload.id_token : undefined,
    expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    tokenType: typeof payload.token_type === "string" ? payload.token_type : undefined,
    updatedAt: new Date(),
  };
}
