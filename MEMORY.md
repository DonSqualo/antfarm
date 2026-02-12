# Antfarm Memory

## RTS image-gen sprite workflow

Hard gate for building work:
- If `OPENAI_API_KEY` is missing or empty, refuse building create/update requests.
- Do not implement or modify RTS buildings unless a new sprite can be generated with OpenAI image generation in the same task.
- Never use SVG/vector/canvas placeholder pipelines for building sprites.

1. Generate a raster sprite directly to `src/server/rts-sprites/<name>-corpus-generated-source.png`.
2. Copy/tune it as `src/server/rts-sprites/<name>-corpus-test.png` (same dimensions/style as other RTS building sprites).
3. Do **not** use SVG as the source path for RTS image-gen sprites.
4. Update `src/server/rts.html` sprite references to the `*.png` file and bump the query version (for cache busting).
5. Run `npm run build` so `dist/server/rts.html` and `dist/server/rts-sprites/*` are refreshed.
6. Verify in RTS UI:
   - Palette icon uses the new sprite.
   - Building on map uses the same sprite.
