import { Platform, requestUrl } from "obsidian";
import { GoogleDriveSettings } from "../types";

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

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
   * Builds the Google OAuth 2.0 authorization URL with PKCE.
   */
  public buildAuthUrl(redirectUri: string, codeChallenge: string, state: string): string {
    const { clientId } = this.getSettings();
    if (!clientId.trim()) {
      throw new Error("Google OAuth Client ID is not configured in settings.");
    }

    const params = new URLSearchParams({
      client_id: clientId.trim(),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: DRIVE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });

    return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Starts a Desktop loopback OAuth flow on 127.0.0.1:<ephemeral_port> and opens the browser.
   * Returns a Promise that resolves when the user completes authentication in the browser.
   */
  public async startDesktopLoopbackFlow(
    onOpenUrl: (authUrl: string) => void
  ): Promise<OAuthTokenResponse> {
    if (!Platform.isDesktopApp) {
      throw new Error("Loopback server flow is only available on Desktop.");
    }

    const { codeVerifier, codeChallenge } = await generatePkcePair();
    const state = Math.random().toString(36).substring(2, 15);

    // Dynamically require Node's 'http' module on Desktop only
    const nodeRequire = (globalThis as unknown as { require: (mod: string) => any }).require;
    const http = nodeRequire("http") as {
      createServer(
        handler: (
          req: { url?: string },
          res: {
            writeHead(status: number, headers: Record<string, string>): void;
            end(body: string): void;
          }
        ) => void
      ): {
        listen(port: number, host: string, cb: () => void): void;
        address(): { port: number } | string | null;
        close(): void;
        listening: boolean;
      };
    };

    return new Promise<OAuthTokenResponse>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
          const error = reqUrl.searchParams.get("error");
          const code = reqUrl.searchParams.get("code");
          const returnedState = reqUrl.searchParams.get("state");

          if (error) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`<h2>Authentication Failed</h2><p>${error}</p>`);
            server.close();
            reject(new Error(`Google OAuth error: ${error}`));
            return;
          }

          if (!code) {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("Waiting for Google OAuth callback...");
            return;
          }

          if (returnedState && returnedState !== state) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Invalid OAuth state parameter.");
            server.close();
            reject(new Error("OAuth state mismatch."));
            return;
          }

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head><title>Obsidian Google Drive Authenticated</title></head>
              <body style="font-family: system-ui, sans-serif; text-align: center; padding: 3rem;">
                <h2>Connected to Google Drive!</h2>
                <p>You can close this tab and return to Obsidian.</p>
              </body>
            </html>
          `);

          const address = server.address();
          const port = typeof address === "object" && address ? address.port : 0;
          const redirectUri = `http://127.0.0.1:${port}`;
          server.close();

          const tokens = await this.exchangeCodeForTokens(code, redirectUri, codeVerifier);
          resolve(tokens);
        } catch (err) {
          server.close();
          reject(err);
        }
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          reject(new Error("Failed to bind local loopback server."));
          return;
        }
        const redirectUri = `http://127.0.0.1:${address.port}`;
        const authUrl = this.buildAuthUrl(redirectUri, codeChallenge, state);
        onOpenUrl(authUrl);
      });

      // Timeout after 3 minutes so the loopback server never hangs forever
      setTimeout(() => {
        if (server.listening) {
          server.close();
          reject(new Error("OAuth login timed out after 3 minutes."));
        }
      }, 180_000);
    });
  }

  /**
   * Extracts an authorization code from either a raw code string OR a full localhost redirect URL
   * (used on Mobile where the user copies the final http://127.0.0.1/?code=... URL from their browser).
   */
  public static extractAuthCodeFromInput(input: string): string {
    const trimmed = input.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.includes("code=")) {
      try {
        const url = new URL(trimmed.startsWith("http") ? trimmed : `http://127.0.0.1/?${trimmed}`);
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
   * Exchanges an authorization code for access + refresh tokens.
   */
  public async exchangeCodeForTokens(
    rawCodeOrUrl: string,
    redirectUri: string,
    codeVerifier: string
  ): Promise<OAuthTokenResponse> {
    const code = GoogleOAuthManager.extractAuthCodeFromInput(rawCodeOrUrl);
    const { clientId, clientSecret } = this.getSettings();

    const bodyParams: Record<string, string> = {
      client_id: clientId.trim(),
      code,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    };

    if (clientSecret && clientSecret.trim()) {
      bodyParams.client_secret = clientSecret.trim();
    }

    const body = new URLSearchParams(bodyParams).toString();
    const response = await requestUrl({
      url: GOOGLE_TOKEN_ENDPOINT,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
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
   * Returns a valid access token, refreshing automatically if expired or near expiration.
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
    const { clientId, clientSecret, refreshToken } = this.getSettings();
    if (!clientId.trim() || !refreshToken) {
      throw new Error("Missing Google OAuth Client ID or Refresh Token.");
    }

    const bodyParams: Record<string, string> = {
      client_id: clientId.trim(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    };

    if (clientSecret && clientSecret.trim()) {
      bodyParams.client_secret = clientSecret.trim();
    }

    const response = await requestUrl({
      url: GOOGLE_TOKEN_ENDPOINT,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(bodyParams).toString(),
      throw: false,
    });

    if (response.status >= 400) {
      throw new Error(`Failed to refresh Google access token (${response.status}): ${response.text}`);
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
}
