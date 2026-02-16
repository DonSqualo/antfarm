import fs from "node:fs";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function read(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function run(): void {
  const root = process.cwd();
  const srcHtmlPath = path.join(root, "src/server/rts.html");
  const distHtmlPath = path.join(root, "dist/server/rts.html");

  const srcHtml = read(srcHtmlPath);
  const distHtml = read(distHtmlPath);

  for (const [label, html] of [["src", srcHtml], ["dist", distHtml]] as const) {
    assert(html.includes('<link rel="manifest" href="/manifest.webmanifest" />'), `${label}: manifest link missing`);
    assert(html.includes('<meta name="theme-color" content="#081427" />'), `${label}: theme-color meta missing`);
    assert(html.includes('<meta name="apple-mobile-web-app-capable" content="yes" />'), `${label}: apple mobile capable meta missing`);

    assert(html.includes("if (!('serviceWorker' in navigator)) return;"), `${label}: service worker feature detection missing`);
    assert(html.includes("navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' })"), `${label}: service worker registration call missing`);

    assert(html.includes("window.addEventListener('beforeinstallprompt'"), `${label}: beforeinstallprompt listener missing`);
    assert(html.includes("deferredInstallPrompt = event;"), `${label}: deferred install prompt state missing`);
    assert(html.includes("installBtn.hidden = !deferredInstallPrompt;"), `${label}: install prompt conditional render missing`);
  }

  console.log("PASS: RTS PWA metadata, service worker bootstrap, and install prompt state are wired.");
}

run();
