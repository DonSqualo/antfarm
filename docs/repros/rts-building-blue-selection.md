# RTS repro: selecting/dragging buildings sometimes turns the building fully blue (text selection highlight)

## Minimal reproduction

**Context:** RTS dashboard (`/rts`) world entities are DOM nodes with text content (e.g. port label, notices). When a user presses and drags slightly on a building (or attempts to drag-move it), the browser may start a native text selection inside the entity, causing a full blue highlight overlay (similar to selecting text on a web page).

### Steps

1. Open the RTS dashboard page (e.g. `http://localhost:<port>/rts`).
2. Ensure there is at least one building with visible text (e.g. any building showing a `.port-chip` label).
3. Click a building and **slightly drag** the pointer (mousedown + small mousemove) while still within the building.

### Expected

- The building becomes selected (outline/glow), and optional drag-move begins with no text selection highlight.

### Actual

- The building (or its text contents) becomes highlighted **solid blue** as if native text selection started.

## Root cause analysis

This is **native text selection** (CSS `user-select` behavior), not a `pointer-events` issue.

### DOM elements involved

- Buildings are rendered as `.entity.building` elements with text children like:
  - `.port-chip` (port label + number)
  - `.notice` (status text)

The highlight appears when the browser creates a selection range inside those text nodes.

### Event sequence that triggers it

- `renderWorld()` wires a `mousedown` handler on each building entity for drag-move:
  - File: `src/server/rts.html`
  - Function: `renderWorld()`
  - Handler: the `el.onmousedown = (e) => { ... }` block for buildings
  - Behavior: calls `e.stopPropagation()` but **does not call `e.preventDefault()`**

Because `mousedown` is not prevented, a subsequent mousemove with the button pressed can start browser text selection within `.entity.building`.

### Relevant selectors / nodes

- `#worldWrap` (world interaction surface)
- `.entity` / `.entity.building` (building nodes)
- `.entity .port-chip` and `.entity .notice` (text that gets selected)

## Notes / next-step fix direction (not implemented in this story)

A typical mitigation is to prevent native selection for the world surface, e.g.:

- CSS: `user-select: none;` on `#worldWrap` and/or `.entity`
- JS: `e.preventDefault();` when initiating entity drag (`onmousedown`) and/or on `#worldWrap` drag gestures

This story only documents the reproduction + the exact elements and event path.
