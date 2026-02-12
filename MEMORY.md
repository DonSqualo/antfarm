# Antfarm Memory

## RTS image-gen sprite workflow

Hard gate for building work:
- If `OPENAI_API_KEY` is missing or empty, refuse building create/update requests.
- Do not implement or modify RTS buildings unless a new sprite can be generated with OpenAI image generation in the same task.
- Never use SVG/vector/canvas placeholder pipelines for building sprites.
- Refuse sprite delivery if the resulting building perspective does not match the canonical RTS camera lock below.
- Do not overwrite prior building sprite PNGs; always write new versioned filenames (for example `*-corpus-test-YYYYMMDDx.png`) and then update references.

Canonical RTS camera lock (must match existing buildings):
- 2.5D isometric, 3/4 top-down view.
- Facing direction: front corner toward lower center; left wall and right wall both visible.
- Rotation: ~45 degrees around vertical axis.
- Pitch: ~35 degrees downward.
- No orthographic side/front views, no tilted/skewed camera variants.
- Keep building grounded on the same implied plane as other RTS buildings.

Required prompt clause for every RTS building sprite:
- `RTS isometric camera lock: 2.5D 3/4 view, yaw 45deg, pitch 35deg, same perspective as existing base/feature/research/warehouse sprites, transparent background, single building only.`

1. Generate a raster sprite directly to `src/server/rts-sprites/<name>-corpus-generated-source.png`.
2. Copy/tune it as `src/server/rts-sprites/<name>-corpus-test.png` (same dimensions/style as other RTS building sprites).
3. Do **not** use SVG as the source path for RTS image-gen sprites.
4. Update `src/server/rts.html` sprite references to the `*.png` file and bump the query version (for cache busting).
5. Run `npm run build` so `dist/server/rts.html` and `dist/server/rts-sprites/*` are refreshed.
6. Verify in RTS UI:
   - Palette icon uses the new sprite.
   - Building on map uses the same sprite.
