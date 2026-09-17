# Development E2E

This directory contains development-only fault injection, forensic capture, and narrowly scoped reproductions. These tests are not part of the required work or functional gates.

## Naming

Use one of these readable forms:

- `bug-<behavior>.test.ts`
- `feature-<behavior>.test.ts`
- `issue-<number>-<behavior>.test.ts`

Do not use Memory Bank object IDs as test names.

## Contracts

- Reuse the `e2e` fixture and Mock Provider; never use real credentials or user task history.
- Keep workers at `1`, retries at `0`, and retain traces on failure through `playwright.dev.config.ts`.
- Write diagnostic JSON and screenshots only through `testInfo.outputPath(...)`.
- Stable, minimal, user-visible regressions belong in `../functional/`; continuous user journeys belong in `../work/`.
- When a bug is fixed, graduate the smallest black-box contract to functional and keep only genuinely forensic observation here.

Run one diagnostic with a unique run ID:

```powershell
$env:DLINE_E2E_RUN_ID = "dev-webview-layout-20260917"
npm run e2e:dev -- src/test/e2e/dev/bug-webview-blank-layout.test.ts --project "development e2e tests" --workers=1 --retries=0
```
