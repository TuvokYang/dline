---
name: release
description: Promote a verified dev candidate through a main squash, content-preserving back-merge and production tag, then observe automatic validation, the tested GitHub Release and enabled registries.
---

# Production Release

Squash a verified release candidate from `dev` into one `main` commit, back-merge it into `dev`, create the production tag, and observe the actual validation/publication chain. `main` keeps one commit per release, not the `dev` history. Version selection and writing the bilingual release files belong to `dev-version-bump`; this workflow verifies those prepared files, not a second copy of their writing procedure.

Follow `repository-and-release`. Discover repository identity, remote URLs and writable destinations from the current checkout.

## Preconditions

- `dev-version-bump` preparation was completed on `dev`, either directly or through an ordinary PR from an independent source branch.
- The integrated `dev` commit is unambiguous and the working tree used for verification is clean.
- `package.json`, `package-lock.json`, `CHANGELOG.md`, `docs/changelog/CHANGELOG_en.md`, `docs/whats-new/WHATS_NEW.md`, and `docs/whats-new/WHATS_NEW_en.md` describe the same target version.
- No unresolved release blocker or unrelated work is being included.
- The release version has an even minor, as the version bump rules in repository-and-release require; stop and prepare a new version with dev-version-bump when it is odd.
- The user has not yet implicitly authorized any commit, push, merge, tag, Release edit, or Marketplace publication.

## 1. Discover repository state

Run the read-only discovery required by the repository contract, then resolve `<repository>` and the remote that exposes both `dev` and `main`.

```text
git branch --show-current
git status --short
git remote -v
git rev-parse --abbrev-ref --symbolic-full-name "@{upstream}"
git branch -vv
```

Fetch only after the user authorizes the network operation. Bind the remote branch tips to explicit remote-tracking refs instead of assuming local `dev` or `main` is current:

```text
git fetch <remote> refs/heads/dev:refs/remotes/<remote>/dev refs/heads/main:refs/remotes/<remote>/main --tags
git rev-parse refs/remotes/<remote>/dev
git rev-parse refs/remotes/<remote>/main
git merge-base refs/remotes/<remote>/dev refs/remotes/<remote>/main
```

Record those exact remote `dev` and `main` SHAs, their merge base, and the changes proposed for promotion. Use the fully qualified refs for every diff, ancestry check, gate binding, and promotion preview; bare local `dev`/`main` refs are not remote facts.

The remote `main` head must already be an ancestor of the remote `dev` head:

```text
git merge-base --is-ancestor refs/remotes/<remote>/main refs/remotes/<remote>/dev
```

A failure means the previous release's back-merge is missing. Stop and complete that back-merge on `dev` first; squashing on top of it would reapply already-released changes.

## 2. Verify the release contract on dev

Confirm:

- the target version matches `X.Y.Z`;
- both changelogs contain `## [X.Y.Z]` and equivalent user-visible content;
- both What's New editions start with a `## X.Y.Z` section that stands alone for this release and has the same number of items, as dev-version-bump requires; the What's New Vitest file passes on the candidate;
- `package.json` and `package-lock.json` use `X.Y.Z`;
- the release candidate is not marked as preview;
- no production `vX.Y.Z` tag already exists locally or remotely;
- any development release tag such as `dev-vX.Y.Z` belongs to the `dev` pre-release chain (the `Publish Pre-release` workflow) and is never a production baseline.

Do not repair a version mismatch directly on `main`. Fix it on `dev` directly, or use an independent release-preparation branch and merge it into `dev` first.

## 3. Complete the integrated dev gate

Load `e2e-validation`, then use current scripts and the actual blast radius. These local development/preparation checks are useful, but the source-mode work run followed by a new package is not evidence that the resulting VSIX passed the release gate:

```text
npm run check-types
npm run format -- --since=<comparison-base>
npm run lint
npm run test:smoke
npm run test:run -- <focused-test-file>
npm run test:e2e:work
npm run vsix
```

Load `use-vitest` for the complete Vitest run through its repository-identified background UI process; the focused command above is not a substitute for that full gate. `test:e2e:work` defaults to source mode. A later `npm run vsix` creates a different artifact boundary; never attach the source-run result to that VSIX. Use `use-e2e` for packaged-mode inspection/reproduction and keep exact artifact identity in the required CI/release evidence below. Full functional E2E runs in Production Release Validation after the production tag is pushed, one shard per functional folder against the release VSIX; locally use focused files when contracts change, and full functional only on explicit request. Dev-tier E2E never satisfies a release gate.

Equivalent successful CI evidence from the exact `dev` commit may satisfy a check. The reusable Tests workflow must package one VSIX before E2E, run one work smoke on Linux, then each of four daily workflows on Linux, macOS, and Windows against that exact artifact, and expose it to release jobs. Record the workflow/run, SHA, and artifact identity rather than assuming a feature-branch run covers integrated `dev`.

`npm run vsix` invokes `scripts/package-vsix.mjs`. Use `npm run vsix -- --out <artifact-path>` to select the .vsix output path; the script logs the resolved tag, channel and version. Inspect the artifact's publisher/name/version, pre-release marker and packaged assets against that resolved channel.

## 4. Preview dev-to-main promotion

Show the user:

- `<repository>` and the resolved destination URL;
- verified `dev` SHA and current remote `main` SHA;
- the squash method and the release commit message `release: X.Y.Z`, whose body summarizes the release from the bilingual changelog;
- `git diff --stat refs/remotes/<remote>/main <verified-dev-sha>`, the change set entering `main`;
- the back-merge that will follow on `dev`;
- verification evidence;
- recovery approach if the destination changes before the write.

Confirm explicit authorization for the `main` squash/commit, `main` push, `dev` back-merge, and `dev` push as distinct operations. Approval for one does not cover the others; a user instruction can explicitly authorize several, and an already granted scope need not be asked again. This workflow grants none. If a hosting platform represents promotion as a PR, use its squash-merge mode with head `dev` and base `main`; this is a release promotion, not an ordinary feature PR, and the back-merge below is still required.

## 5. Squash, back-merge, and re-verify

Perform only the approved operations in the examples below, stopping before any write not covered by the user's authorization. Preview each push as `repository-and-release` requires. Do not merge a feature or bugfix branch directly to `main`, and never fast-forward or `--no-ff` merge `dev` into `main`.

On a checkout of `main` that matches `refs/remotes/<remote>/main`:

```text
git merge --squash <verified-dev-sha>
git commit -m "release: X.Y.Z" -m "<summary from the changelog>"
git diff --quiet <verified-dev-sha> HEAD
git push <remote> HEAD:refs/heads/main
```

`git diff --quiet` must succeed: the squash commit's tree has to equal the verified `dev` tree. Any difference blocks the push, because the tested artifact would no longer describe what `main` ships.

Then back-merge on `dev` so the squash commit becomes an ancestor of `dev` without changing `dev` content:

```text
git switch dev
git merge -s ours --no-edit <squash-sha>
git diff --quiet <verified-dev-sha> HEAD
git push <remote> HEAD:refs/heads/dev
```

If remote `dev` moved after the verified SHA, merge the squash commit into the current `dev` head instead; the tree check then compares against that head before the merge. The back-merge push is a normal fast-forward; never force it.

Fetch both refs again and verify:

```text
git fetch <remote> refs/heads/main:refs/remotes/<remote>/main refs/heads/dev:refs/remotes/<remote>/dev
git rev-parse refs/remotes/<remote>/main
git merge-base --is-ancestor refs/remotes/<remote>/main refs/remotes/<remote>/dev
```

- the final `main` SHA is the squash commit and its parent is the previous `main` head;
- the squash commit's tree equals the verified `dev` tree;
- `main` is an ancestor of `dev`, so the back-merge landed;
- version, changelog, and What's New files are unchanged;
- the production tag does not yet exist.

If remote `main` or `dev` moved unexpectedly, stop instead of overwriting it.

## 6. Create and push the production tag

Tag creation and tag push are distinct authorizations, both separate from `main` promotion. A request for local tag creation alone does not authorize pushing it.

Create `vX.Y.Z` only at the final verified squash commit at the `main` head, then show the tag object and target SHA before pushing it to the resolved remote. `release.yml` rejects a tag that is not the current `main` head.

Never move an existing tag and never create a production tag from a commit outside `main` history.

## 7. Observe automated release gates

Pushing `vX.Y.Z` triggers `release.yml` (`Production Release Validation`). Follow the jobs in the repository rather than inferring behavior from a filename:

1. `verify-tag` checks the exact tag format, package version and current `main` head.
2. `tests` calls `test.yml` with `package_profile: release` and `package_channel: production`. It runs the type/lint/smoke/Vitest gates, builds a separate final VSIX for each registry publisher, then runs one Linux work smoke and all four daily workflows on Linux, macOS and Windows against each artifact.
3. `functional-e2e` runs the production functional folders against both registry-specific release VSIX files; a successful reusable Tests run alone is not the whole production gate.
4. Only after those jobs pass, `publish` calls `publish-production-release.yml`. It verifies and publishes the default-publisher VSIX to the stable GitHub Release, then passes each registry's existing artifact and its own SHA-256 to `publish-vsix-registries.yml`.

Both registries are enabled by default. VS Code Marketplace uploads run only in GitHub Actions; local commands only build and package. Verify the actual GitHub Release asset and each registry result: the aggregate gate requires at least one registry to succeed, and disabled/skipped is not published. Do not replace an asset, rewrite its manifest or substitute a locally rebuilt VSIX after testing.

`publish-vscode-marketplace.yml` is currently `Production Release (Manual Override)`, invoked by dispatch with a tag and reason. It is not an automatic follow-up: it validates main ancestry and builds fresh publisher-specific packages before invoking the shared production publisher. Do not invoke it as a routine retry or use it to claim the normal tested-artifact gate passed. Any exceptional override needs its own explicit authorization and an assessment of the validation/artifact evidence it lacks.

## 8. Final report

Report:

- repository, final `main` squash SHA, and the `dev` back-merge SHA;
- release version and production tag;
- dev integration and production workflow evidence;
- GitHub Release and VSIX asset status;
- each registry's actual published, failed or disabled/skipped status;
- any operation that remains unperformed or requires separate authorization.
