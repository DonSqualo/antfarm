# Repo Health Regression Root-Cause Summary (US-005)

This summary maps each fixed regression (US-001 through US-004) to its root cause, impacted module, scoped fix, and targeted coverage.

## 1) Malformed context handling
- **Module:** `src/installer/step-ops.ts`
- **Root cause:** Step claim/complete paths assumed valid JSON in `runs.context` and `steps.loop_config`; malformed or missing values could throw and abort state transitions.
- **Scoped fix:** Added safe parse fallbacks and string-safe template interpolation behavior for missing keys.
- **Regression coverage:** `tests/step-context-parsing-regression.test.ts`

## 2) Loop retry consistency (abandoned + verify-each)
- **Module:** `src/installer/step-ops.ts`
- **Root cause:** Some retry/reset paths did not consistently clear `current_story_id`, leaving loop/story/step state out of sync across re-queues and retry exhaustion.
- **Scoped fix:** Unified retry transitions to clear stale story pointers and preserve expected retry semantics (`newRetry > max_retries`).
- **Regression coverage:** `tests/loop-retry-state-consistency.test.ts`

## 3) RTS null/stale layout reconciliation
- **Module:** `src/server/dashboard.ts`
- **Root cause:** Hydration/dedup logic was brittle with null or mixed-format repo/worktree paths and stale `run_id` references, causing duplicate/misaligned feature entities.
- **Scoped fix:** Canonicalized path handling, null-safe key derivation, and stale run reconciliation during RTS state assembly.
- **Regression coverage:** `tests/rts-layout-nullpath-reconciliation.test.ts`

## 4) Deletion idempotency and RTS artifact purge
- **Module:** `src/server/dashboard.ts`
- **Root cause:** Cleanup paths could mutate RTS state for unknown runs and did not consistently strip all run-linked artifacts across repeated or prefix-based deletes.
- **Scoped fix:** Centralized run-reference cleanup; made purge operations no-op safe for absent runs while supporting unique-prefix cleanup.
- **Regression coverage:** `tests/rts-run-deletion-idempotency.test.ts`

## US-005 regression suite wrapper
- **Suite entry:** `tests/repo-health-regression-suite.test.ts`
- **Purpose:** Provides one focused suite-level execution path that validates all four regression areas together without introducing unrelated module refactors.
