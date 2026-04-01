# Documentation Screenshots

Automated screenshot capture for the AgentHiFive Docusaurus docs.

## Quick Start

```bash
cd apps/docs/screenshots
npm install puppeteer-core
```

### Step 1 — Launch Chrome with remote debugging

Close Chrome completely, then relaunch with:

```
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

### Step 2 — Log in

Open https://app-integration.agenthifive.com in that Chrome and log in normally.

### Step 3 — Run the capture

```bash
node capture.mjs
```

Or against a local dev environment:

```bash
node capture.mjs --base-url=http://localhost:3000
```

Screenshots are saved as PNGs to `apps/docs/static/img/getting-started/`.

## How It Works

The script connects to your already-running Chrome via the Chrome DevTools Protocol (CDP) on port 9222. It navigates to each page by URL, optionally runs some in-page JavaScript to open modals, and takes a screenshot. Your existing login session is used — no credentials stored anywhere.

## Adding New Screenshots

Edit the `SCREENS` array in `capture.mjs`. Each entry needs:

- `name` — output filename (without `.png`)
- `url` — URL path to navigate to
- `prep` (optional) — async function that runs in-page JS to open modals, scroll, etc.

## Refreshing After UI Changes

Just re-run `node capture.mjs`. All screenshots are overwritten with fresh captures.
