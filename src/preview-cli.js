import { LocalPreviewServer, loadPreviewManifest } from "./preview-server.js";

const root = process.env.SITEPILOT_PREVIEW_WORKTREE;
if (!root) throw new Error("SITEPILOT_PREVIEW_WORKTREE must be an absolute worktree path");
const plan = await loadPreviewManifest(root);
const preview = new LocalPreviewServer({ plan, port: Number(process.env.PORT || 4173) });
const address = await preview.listen();
console.log(`SitePilot preview listening on http://${address.host}:${address.port}`);
process.once("SIGINT", () => preview.close().then(() => process.exit(0)));
process.once("SIGTERM", () => preview.close().then(() => process.exit(0)));
