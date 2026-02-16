import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import type { Server } from "node:http";
import { startDashboard } from "../dist/server/dashboard.js";

function pickPort(): number {
  const base = 45500;
  const spread = 1000;
  return base + Math.floor(Math.random() * spread);
}

test("PWA manifest metadata exists and is copied to dist/server", () => {
  const root = process.cwd();
  const srcManifestPath = path.join(root, "src", "server", "manifest.webmanifest");
  const distManifestPath = path.join(root, "dist", "server", "manifest.webmanifest");
  const distServiceWorkerPath = path.join(root, "dist", "server", "service-worker.v1.js");
  const distIcon192Path = path.join(root, "dist", "server", "icon-192.png");
  const distIcon512Path = path.join(root, "dist", "server", "icon-512.png");

  assert.equal(fs.existsSync(srcManifestPath), true, "Expected src/server/manifest.webmanifest to exist");
  const manifest = JSON.parse(fs.readFileSync(srcManifestPath, "utf-8")) as {
    name?: string;
    short_name?: string;
    display?: string;
    start_url?: string;
    theme_color?: string;
    icons?: Array<{ src?: string }>;
  };
  assert.ok(manifest.name, "Expected manifest name");
  assert.ok(manifest.short_name, "Expected manifest short_name");
  assert.ok(manifest.display, "Expected manifest display");
  assert.ok(manifest.start_url, "Expected manifest start_url");
  assert.ok(manifest.theme_color, "Expected manifest theme_color");
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 1, "Expected manifest icons entries");

  assert.equal(fs.existsSync(distManifestPath), true, "Expected manifest to be copied to dist/server");
  assert.equal(fs.existsSync(distServiceWorkerPath), true, "Expected service worker to be copied to dist/server");
  assert.equal(fs.existsSync(distIcon192Path), true, "Expected icon-192 to be copied to dist/server");
  assert.equal(fs.existsSync(distIcon512Path), true, "Expected icon-512 to be copied to dist/server");
});

test("PWA manifest and service worker endpoints return 200 with expected MIME types", async () => {
  const port = pickPort();
  const server = startDashboard(port) as Server;
  if (!server.listening) await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const manifestResp = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestResp.status, 200);
    assert.match(manifestResp.headers.get("content-type") || "", /^application\/manifest\+json/i);

    const swResp = await fetch(`${baseUrl}/service-worker.v1.js`);
    assert.equal(swResp.status, 200);
    assert.match(swResp.headers.get("content-type") || "", /^application\/javascript/i);

    const iconResp = await fetch(`${baseUrl}/icon-192.png`);
    assert.equal(iconResp.status, 200);
    assert.match(iconResp.headers.get("content-type") || "", /^image\/png/i);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
