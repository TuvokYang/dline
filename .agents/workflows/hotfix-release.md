---
name: hotfix-release
description: Ship an urgent patch through dev, optionally using an isolated bugfix branch, then pass the dev gate before main promotion and a production tag.
---

# Hotfix Release

Ship an urgent patch through the same protected branch and release path as ordinary development.

Follow `repository-and-release` and load `release` before using this workflow.

## Default path

```text
fix directly on dev, or use an independent bugfix branch
  -> focused verification
  -> if using a PR: independent source branch -> dev
  -> complete integrated dev gate
  -> squash promotion to main and back-merge into dev
  -> vX.Y.Z on the verified main squash commit
```

A hotfix does not authorize direct development on `main`, a feature/bugfix PR to `main`, or a production tag from an old detached tag.

## 1. Establish the production baseline

Dynamically discover `<repository>`, the remote containing the production refs, current `main`, current `dev`, and the latest valid production tag matching `vX.Y.Z`.

Do not select `dev-vX.Y.Z` as the production baseline. It identifies a tested nightly from `dev`; verify that the chosen production tag belongs to `main` history.

Record the production symptom, affected versions, exact fixes required, non-goals, and recovery requirements.

## 2. Implement on dev or an isolated branch

Direct implementation on `dev` is allowed. Use a `bugfix/<slug>` branch or dedicated worktree when isolation is valuable or when a PR is required. Any worktree branch must have a clear owner and must not overlap another active worktree's writes.

Validate the original production symptom and add regression coverage when the behavior is stable and observable.

Commit, push, and PR creation are separate operations. The ordinary hotfix PR base is `dev`, not `main`.

## 3. Prepare the patch version

Load `dev-version-bump` on `dev` or a recommended independent release-preparation branch to update:

- `CHANGELOG.md`;
- `docs/changelog/CHANGELOG_en.md`;
- `package.json`;
- `package-lock.json`.

Merge both the fix and version preparation into `dev`, then run the complete integrated gate on the exact resulting commit.

## 4. Promote and release

Only after the `dev` gate passes, load `release` to squash `dev` into one `main` commit, back-merge it into `dev`, re-verify the final `main` commit, and create the production `vX.Y.Z` tag.

The standard Release and Marketplace workflows must package and publish the tested artifact. Do not rebuild or manually replace the release VSIX.

## 5. When dev contains changes that cannot ship

Stop. The default hotfix path cannot selectively publish an older product state while preserving the required ancestry.

Before continuing, obtain explicit approval for a release-candidate and back-merge strategy that defines:

- the exact branch and base commit;
- how the fix enters both `dev` and `main`;
- how unreleased features are excluded;
- how the final tag remains in `main` history;
- validation, conflict handling, back-merge, and recovery order.

Do not invent a detached-tag cherry-pick path and do not weaken the production workflow's `main` ancestry check.

## 6. Final report

Report the fixed behavior, patch version, source and destination SHAs, dev gate evidence, production workflow status, released VSIX identity, and any back-merge or follow-up work.
