# Obsidian Drive View (`obsidian-drive-view`)

An Obsidian plugin for **Desktop and Mobile** that mounts a Google Drive folder as a virtual vault backend by replacing `app.vault.adapter` at runtime (`GoogleDriveDataAdapter`), backed by an in-memory + IndexedDB cache.

## How It Works

1. **Minimal Local Stub Folder:**
   - Your local Obsidian vault directory only needs to hold `.obsidian/` (settings, plugins, workspace state).
   - Requests to `.obsidian/*` are transparently routed to Obsidian's native platform adapter (`FileSystemAdapter` on Desktop, `CapacitorAdapter` on Mobile).
2. **Virtual `GoogleDriveDataAdapter`:**
   - All vault files and folders outside `.obsidian/` are served from a fast in-memory + **IndexedDB** cache backed by the **Google Drive v3 REST API**.
   - Embedded images, audio, and PDFs (`![[image.png]]`) are served via in-memory `blob:` URLs (`URL.createObjectURL`) from `getResourcePath()` without writing files to your local disk.
3. **Debounced Uploads & Delta Polling:**
   - Rapid auto-saves while typing update RAM/IndexedDB immediately (`<1ms`) and coalesce into a single debounced `multipart/related` upload to Google Drive.
   - Remote changes on Google Drive are polled via `changes.list` and reconciled directly into Obsidian's `Vault`, `MetadataCache`, and open `MarkdownView` editors.

---

## Setup Instructions

### 1. Build & Test the Plugin (Zero `node_modules` with Bun)
```bash
bun test
bun run build
```

Copy `main.js` and `manifest.json` into your stub vault's plugin directory:
```text
<YourVault>/.obsidian/plugins/obsidian-drive-view/
├── main.js
└── manifest.json
```

### 2. Sign In & Select a Folder
- **On Desktop:** Open **Settings → Obsidian Drive View**, click **Sign in with Google**, and then click **Browse / Create Folder...** to pick or create a Google Drive folder for your vault.
- **On Mobile (iOS / Android):**
  - **Option A (Fastest):** Click **Copy Auth Bundle** in the Desktop plugin settings and paste it into the **Quick Cross-Device Auth Bundle** field on Mobile.
  - **Option B (Direct Mobile Sign-In):** Tap **Sign in with Google** on Mobile, approve access in your mobile browser, copy the resulting `http://127.0.0.1/?code=...` URL from your browser's address bar, and paste it into the modal.
