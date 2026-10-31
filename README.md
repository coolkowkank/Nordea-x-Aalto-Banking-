<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/8fb23cbd-15fa-415e-a3bd-7c8740e2a253

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Open the developer monitor

The developer monitor is a separate, read-only page. To use it while the mobile app is running:

1. Check out the `dev-context-monitor` branch and start the app with `npm run dev`.
2. Keep the server running. The mobile app remains at the root path `/`.
3. Open a second browser tab at the same address and port shown by the dev server, adding `/dev-monitor.html` to the end. For example, if the app is at `http://localhost:3000/`, open `http://localhost:3000/dev-monitor.html`.

Use your actual port if it differs from `3000`. The monitor is display-only and does not provide controls.
