---
name: e2e-validation
description: Select and run the smallest Dline E2E tier that proves a change, preserving work-gate, diagnostic, and artifact boundaries.
---

# E2E Validation

Run a bounded real VS Code validation and report evidence without silently expanding to full functional or development suites.

Load `use-e2e` before executing this workflow.

## Preconditions

- Read `package.json`, the selected Playwright config, and the owning test files.
- Identify the changed behavior, the smallest observable acceptance boundary, and whether a packaged VSIX is required.
- Stop if another active task has uncommitted changes in the selected test's implementation, fixture, config, or artifact path; resume after that owner finishes or the user decides how to isolate the run.
- Run `npm run e2e:lock:status` before a build. `dist/` is shared by every tier, so a build is refused while another build or test run owns it. Wait for the reported holder instead of deleting `dist/.e2e-lock/`.

## 1. Select the tier

- Use **work** for the required continuous gate and end-to-end user journeys.
- Use **functional** for a stable focused black-box regression.
- Use **dev** for fault injection, forensic capture, or a narrow reproduction; never use it as required-gate evidence.
- Use **pressure** only for explicitly requested load or soak behavior.
- Use demo, legacy, or Storybook only when their distinct product surface is the acceptance target.

Do not run the root default suite or full functional suite merely to gain confidence. Broaden only when evidence shows the change crosses the selected boundary.

## 2. Establish isolation

Set a unique `DLINE_E2E_RUN_ID` containing the task, behavior, and date. Use `--workers=1 --retries=0` for focused functional and dev reproduction unless the behavior under test is parallel isolation itself.

Preserve existing `tmp/test-result/<run-id>/` artifacts. Never delete another run's output or shared temporary state.

The run ID does not isolate `dist/`. To run more than one tier at the same time, build once and then start read-only runs against that build; do not start a second command that rebuilds.

## 3. Execute the bounded command

Use the current package scripts:

```text
# Complete required gate
npm run test:e2e:work

# One work project; its configured dependencies still run
npm run test:e2e:work -- --project "<work-project>"

# One functional file or name
npm run test:e2e:functional -- <functional-file> --project "functional e2e tests" --workers=1 --retries=0

# One development diagnostic
npm run e2e:dev -- <dev-file> --project "development e2e tests" --workers=1 --retries=0
```

The work and functional tiers run in source mode against the `pree2e` dev bundle. Use `test:e2e`, `test:e2e:optimal`, or `test:e2e:pressure` when the acceptance target is the installed VSIX itself.

Use raw `npx playwright test -c <config>` only when the required build or VSIX artifact is already current and skipping npm lifecycle hooks is intentional; note that it also bypasses the `dist/` lock, so never pair it with a concurrent build. In CI, download the package job's VSIX, normalize it to `dist/e2e.vsix`, and run only `playwright.work.config.ts`; do not rebuild a second VSIX inside E2E jobs.

## 4. Diagnose failures before changing code

Inspect, in order:

1. the first Playwright assertion or timeout;
2. `test-failed-1.png` and `vscode-failure.png`;
3. `dline-output.log` and VS Code logs;
4. persisted Task state;
5. Mock Provider consumptions and contract errors;
6. `trace.zip` when the timeline is still ambiguous.

Distinguish startup, fixture, locator, provider-contract, and product failures. Do not increase timeouts, add retries, suppress logs, or change production behavior until the evidence identifies the failing boundary.

## 5. Verify the original contract

After a fix, rerun the original failing file or project first. Then run only the nearest functional or work coverage required by the changed shared contract.

For release evidence, the passing work gate must use the same packaged VSIX later consumed by the release job. Full functional remains nightly or explicit; dev remains development-only.

## 6. Report

Record:

- exact command, run ID, files/projects, platform, workers, retries, and duration;
- passed/failed test counts and the first meaningful evidence;
- artifact availability and the Mock Provider contract checked;
- adjacent checks run and suites intentionally not run;
- whether the tested VSIX identity is the same artifact used by the CI/release chain.
