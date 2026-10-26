import { App, ButtonComponent, Modal, Notice, TextComponent } from "obsidian";
import { generatePkcePair, GoogleOAuthManager } from "../auth/GoogleOAuth";

export class ManualOAuthModal extends Modal {
  private codeVerifier = "";
  private redirectUri = "http://127.0.0.1";
  private authUrl = "";

  constructor(
    app: App,
    private readonly oauth: GoogleOAuthManager,
    private readonly onSuccess: () => Promise<void>
  ) {
    super(app);
  }

  public async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Sign in with Google Drive" });

    try {
      const pkce = await generatePkcePair();
      this.codeVerifier = pkce.codeVerifier;
      const state = Math.random().toString(36).substring(2, 12);
      this.authUrl = this.oauth.buildAuthUrl(this.redirectUri, pkce.codeChallenge, state);
    } catch (err) {
      contentEl.createEl("p", {
        text: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    contentEl.createEl("p", {
      text: "1. Tap the button below to open Google Sign-In in your browser.",
    });

    const openBtnDiv = contentEl.createDiv({ attr: { style: "margin-bottom: 1em;" } });
    new ButtonComponent(openBtnDiv)
      .setButtonText("Open Google Sign-In")
      .setCta()
      .onClick(() => {
        window.open(this.authUrl, "_blank");
      });

    contentEl.createEl("p", {
      text:
        "2. After approving access, Google will redirect your browser to http://127.0.0.1/?code=... " +
        "(which may show 'This site can't be reached' on mobile). Copy that entire URL from your browser's address bar and paste it below:",
    });

    let pastedInput = "";
    const inputDiv = contentEl.createDiv({ attr: { style: "margin-bottom: 1em;" } });
    const textInput = new TextComponent(inputDiv)
      .setPlaceholder("http://127.0.0.1/?code=4/0A... or paste code")
      .onChange((val) => {
        pastedInput = val;
      });
    textInput.inputEl.style.width = "100%";

    const submitDiv = contentEl.createDiv({
      attr: { style: "display: flex; gap: 8px; justify-content: flex-end;" },
    });

    new ButtonComponent(submitDiv).setButtonText("Cancel").onClick(() => {
      this.close();
    });

    new ButtonComponent(submitDiv)
      .setButtonText("Complete Sign-In")
      .setCta()
      .onClick(async () => {
        if (!pastedInput.trim()) {
          new Notice("Please paste the redirect URL or authorization code first.");
          return;
        }
        try {
          await this.oauth.exchangeCodeForTokens(
            pastedInput,
            this.redirectUri,
            this.codeVerifier
          );
          new Notice("Successfully authenticated with Google Drive!");
          this.close();
          await this.onSuccess();
        } catch (err) {
          new Notice(
            `Authentication failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      });
  }

  public onClose(): void {
    this.contentEl.empty();
  }
}
