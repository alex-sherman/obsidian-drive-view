import { requestUrl } from "obsidian";
import { GoogleDriveSettings } from "../types";

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

// User-facing redirect bounce page hosted on asherman.io (GitHub Pages)
export const USER_FACING_REDIRECT_URI = "https://asherman.io/drive-view/auth";

// Direct Google OAuth endpoints (used when user supplies custom Client ID & Secret)
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const FULL_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

// Background worker endpoints for default auth redirect (drive.file), token exchange, and token refresh
export const WORKER_BASE_URL = "https://drive-view-auth.alexgshm.workers.dev";
export const WORKER_LOGIN_URL = `${WORKER_BASE_URL}/login`;
export const WORKER_TOKEN_URL = `${WORKER_BASE_URL}/token`;
export const WORKER_REFRESH_URL = `${WORKER_BASE_URL}/refresh`;

const PKCE_STORAGE_KEY = "drive_view_pkce_session";

type PKCESession = {
  codeVerifier: string;
  state: string;
  timestamp: number;
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generatePkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const codeVerifier = base64UrlEncode(randomBytes);

  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const codeChallenge = base64UrlEncode(new Uint8Array(digest));

  return { codeVerifier, codeChallenge };
}

export class GoogleOAuthManager {
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private getSettings: () => GoogleDriveSettings,
    private saveSettings: (partial: Partial<GoogleDriveSettings>) => Promise<void>
  ) {}

  public isAuthenticated(): boolean {
    const s = this.getSettings();
    return Boolean(s.refreshToken || (s.accessToken && s.tokenExpiresAt > Date.now() + 60_000));
  }

  /**
   * Returns true if the user has enabled custom OAuth credentials.
   * Throws if custom mode is enabled but Client ID or Client Secret is missing.
   */
  public usesCustomCredentials(): boolean {
    const s = this.getSettings();
    if (!s.useCustomCredentials) {
      return false;
    }
    const clientId = (s.customClientId || "").trim();
    const clientSecret = (s.customClientSecret || "").trim();
    if (!clientId || !clientSecret) {
      throw new Error(
        "Custom OAuth credentials enabled, but Client ID or Client Secret is empty. Please fill in both fields or disable Custom OAuth Credentials."
      );
    }
    return true;
  }

  /**
   * Builds the login URL:
   * - By default, points to the Cloudflare Worker `/login` endpoint (requests `drive.file` scope).
   * - When custom credentials are enabled, points directly to Google OAuth with full `drive` scope.
   */
  public buildLoginUrl(codeChallenge: string, state: string): string {
    if (this.usesCustomCredentials()) {
      const s = this.getSettings();
      const params = new URLSearchParams({
        client_id: s.customClientId.trim(),
        redirect_uri: USER_FACING_REDIRECT_URI,
        response_type: "code",
        scope: FULL_DRIVE_SCOPE,
        access_type: "offline",
        prompt: "consent",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state,
      });
      return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
    }

    const params = new URLSearchParams({
      challenge: codeChallenge,
      state,
    });
    return `${WORKER_LOGIN_URL}?${params.toString()}`;
  }

  /**
   * Starts the 1-click browser sign-in flow (works on Desktop and Mobile).
   * Generates a PKCE pair, saves the verifier in localStorage to survive app backgrounding,
   * and opens the authorization URL in the system browser.
   */
  public async startLoginFlow(onOpenUrl: (authUrl: string) => void): Promise<string> {
    const { codeVerifier, codeChallenge } = await generatePkcePair();
    const state = Math.random().toString(36).substring(2, 15);

    try {
      window.localStorage.setItem(
        PKCE_STORAGE_KEY,
        JSON.stringify({ codeVerifier, state, timestamp: Date.now() })
      );
    } catch {
      // Ignore if localStorage unavailable
    }

    const authUrl = this.buildLoginUrl(codeChallenge, state);
    onOpenUrl(authUrl);
    return authUrl;
  }

  /**
   * Handles the deep link callback from obsidian://drive-view-auth?code=...
   */
  public async handleDeepLinkCallback(
    params: Record<string, string>
  ): Promise<OAuthTokenResponse> {
    if (params.error) {
      throw new Error(`Google OAuth error: ${params.error}`);
    }

    const code = params.code;
    if (!code) {
      throw new Error("No authorization code received in callback.");
    }

    let codeVerifier = "";
    try {
      const stored = window.localStorage.getItem(PKCE_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as PKCESession;
        if (parsed.codeVerifier) {
          codeVerifier = parsed.codeVerifier;
        }
      }
    } catch {
      // Ignore
    }

    if (!codeVerifier) {
      throw new Error(
        "No pending sign-in session found. Please click 'Sign in with Google' again."
      );
    }

    try {
      window.localStorage.removeItem(PKCE_STORAGE_KEY);
    } catch {
      // Ignore
    }

    return this.exchangeCodeForTokens(code, codeVerifier);
  }

  /**
   * Extracts an authorization code from either a raw code string OR a redirect URL.
   */
  public static extractAuthCodeFromInput(input: string): string {
    const trimmed = input.trim();
    if (
      trimmed.startsWith("http://") ||
      trimmed.startsWith("https://") ||
      trimmed.startsWith("obsidian://") ||
      trimmed.includes("code=")
    ) {
      try {
        const url = new URL(
          trimmed.startsWith("http") || trimmed.startsWith("obsidian")
            ? trimmed
            : `http://127.0.0.1/?${trimmed}`
        );
        const code = url.searchParams.get("code");
        if (code) return code;
      } catch {
        const match = trimmed.match(/[?&]code=([^&]+)/);
        if (match?.[1]) return decodeURIComponent(match[1]);
      }
    }
    return trimmed;
  }

  /**
   * Exchanges an authorization code for access + refresh tokens:
   * - Default: via the Cloudflare Worker relay.
   * - Custom credentials: directly against Google's token endpoint.
   */
  public async exchangeCodeForTokens(
    rawCodeOrUrl: string,
    codeVerifier: string
  ): Promise<OAuthTokenResponse> {
    const code = GoogleOAuthManager.extractAuthCodeFromInput(rawCodeOrUrl);
    const isCustom = this.usesCustomCredentials();
    const s = this.getSettings();

    const response = isCustom
      ? await requestUrl({
          url: GOOGLE_TOKEN_ENDPOINT,
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: s.customClientId.trim(),
            client_secret: s.customClientSecret.trim(),
            code,
            code_verifier: codeVerifier,
            grant_type: "authorization_code",
            redirect_uri: USER_FACING_REDIRECT_URI,
          }).toString(),
          throw: false,
        })
      : await requestUrl({
          url: WORKER_TOKEN_URL,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            code,
            code_verifier: codeVerifier,
          }),
          throw: false,
        });

    if (response.status >= 400) {
      throw new Error(`Token exchange failed (${response.status}): ${response.text}`);
    }

    const data = response.json as OAuthTokenResponse;
    const expiresAt = Date.now() + (data.expires_in - 60) * 1000;

    await this.saveSettings({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || this.getSettings().refreshToken,
      tokenExpiresAt: expiresAt,
    });

    return data;
  }

  /**
   * Returns a valid access token, refreshing automatically if expired.
   */
  public async getValidAccessToken(): Promise<string> {
    const settings = this.getSettings();
    if (settings.accessToken && settings.tokenExpiresAt > Date.now() + 60_000) {
      return settings.accessToken;
    }

    if (!settings.refreshToken) {
      throw new Error("Not authenticated with Google Drive (missing refresh token).");
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessToken().finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  private async refreshAccessToken(): Promise<string> {
    const s = this.getSettings();
    const { refreshToken } = s;
    if (!refreshToken) {
      throw new Error("Missing Google OAuth Refresh Token.");
    }

    const isCustom = this.usesCustomCredentials();

    const response = isCustom
      ? await requestUrl({
          url: GOOGLE_TOKEN_ENDPOINT,
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: s.customClientId.trim(),
            client_secret: s.customClientSecret.trim(),
            refresh_token: refreshToken,
            grant_type: "refresh_token",
          }).toString(),
          throw: false,
        })
      : await requestUrl({
          url: WORKER_REFRESH_URL,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            refresh_token: refreshToken,
          }),
          throw: false,
        });

    if (response.status >= 400) {
      throw new Error(
        `Failed to refresh Google access token (${response.status}): ${response.text}`
      );
    }

    const data = response.json as OAuthTokenResponse;
    const expiresAt = Date.now() + (data.expires_in - 60) * 1000;

    await this.saveSettings({
      accessToken: data.access_token,
      tokenExpiresAt: expiresAt,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    });

    return data.access_token;
  }

  public async signOut(): Promise<void> {
    try {
      window.localStorage.removeItem(PKCE_STORAGE_KEY);
    } catch {
      // Ignore
    }
    await this.saveSettings({
      accessToken: "",
      refreshToken: "",
      tokenExpiresAt: 0,
      rootFolderId: "",
    });
  }
}
