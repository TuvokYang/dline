---
name: release
description: Squash a fully verified release candidate from dev into one main commit, back-merge it into dev, create the production tag, and observe the tested GitHub Release and Marketplace gates.
---

# Production Release

Squash a verified release candidate from `dev` into one `main` commit, back-merge that commit into `dev`, create the production tag, and observe the automated GitHub Release and Marketplace gates. `main` keeps one commit per release, not the `dev` history.

Follow `repository-and-release` before using this workflow. Repository identity, remote aliases, URLs, and writable destinations must be discovered at runtime.

## Preconditions

- Release preparation was completed on `dev`, either directly or by merging an ordinary PR from an independent source branch.
- The integrated `dev` commit is unambiguous and the working tree used for verification is clean.
- `package.json`, `package-lock.json`, `CHANGELOG.md`, and `docs/changelog/CHANGELOG_en.md` describe the same target version.
- No unresolved release blocker or unrelated work is being included.
- The user has not yet implicitly authorized any commit, push, merge, tag, Release edit, or Marketplace publication.

## 1. Discover repository state

Run the read-only discovery required by the repository contract, then resolve `<repository>` and the remote that exposes both `dev` and `main`.

```text
git branch --show-current
git status --short
git remote -v
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
- `package.json` and `package-lock.json` use `X.Y.Z`;
- the release candidate is not marked as preview;
- no production `vX.Y.Z` tag already exists locally or remotely;
- any nightly tag such as `dev-vX.Y.Z` belongs to the `dev` Nightly Release chain and is never a production baseline.

Do not repair a version mismatch directly on `main`. Fix it on `dev` directly, or use an independent release-preparation branch and merge it into `dev` first.

## 3. Complete the integrated dev gate

Load `e2e-validation`, then use the current project scripts and the actual blast radius. The complete local release gate includes:

```text
npm run check-types
npm run format -- --since=<comparison-base>
npm run lint
npm run test:smoke
npm run test:run
npm run test:e2e:work
npm run vsix
```

`test:e2e:work` is the required local Electron gate. Full functional E2E is not a default release prerequisite; run focused functional files when the release changes their contracts, and reserve full functional execution for nightly or explicit investigation. Dev-tier E2E never satisfies a release gate.

Equivalent successful CI evidence from the exact `dev` commit may satisfy a check. The reusable Tests workflow must package one VSIX before E2E, run the three-platform work smoke and four daily workflows against that exact artifact, and expose the same artifact to release jobs. Record the workflow/run, SHA, and artifact identity rather than assuming a feature-branch run covers integrated `dev`.

Inspect the produced VSIX identity, version, release channel, and required packaged assets. A failed or incomplete gate blocks promotion.

## 4. Preview dev-to-main promotion

Show the user:

- `<repository>` and the resolved destination URL;
- verified `dev` SHA and current remote `main` SHA;
- the squash method and the release commit message `release: X.Y.Z`, whose body summarizes the release from the bilingual changelog;
- `git diff --stat refs/remotes/<remote>/main <verified-dev-sha>`, the change set entering `main`;
- the back-merge that will follow on `dev`;
- verification evidence;
- recovery approach if the destination changes before the write.

Obtain a separate authorization to write `main`; it covers the squash commit, the `main` push, and the back-merge push to `dev`. If a hosting platform represents promotion as a PR, use its squash-merge mode with head `dev` and base `main`; this is a release promotion, not an ordinary feature PR, and the back-merge below is still required.

## 5. Squash, back-merge, and re-verify

Perform only the approved promotion. Do not merge a feature or bugfix branch directly to `main`, and never fast-forward or `--no-ff` merge `dev` into `main`.

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
- version and changelog files are unchanged;
- the production tag does not yet exist.

If remote `main` or `dev` moved unexpectedly, stop instead of overwriting it.

## 6. Create and push the production tag

Tag creation and tag push require authorization separate from the `main` promotion.

Create `vX.Y.Z` only at the final verified squash commit at the `main` head, then show the tag object and target SHA before pushing it to the resolved remote. `release.yml` rejects a tag that is not the current `main` head.

Never move an existing tag and never create a production tag from a commit outside `main` history.

## 7. Observe automated release gates

Pushing `vX.Y.Z` triggers `.github/workflows/release.yml` (`Production Release`), which:

1. verifies tag format, package version, and `main` ancestry;
2. calls `.github/workflows/test.yml` with the `release` package profile;
3. runs TypeScript, Biome/protobuf lint, smoke, and Vitest, then packages one VSIX and runs the three-platform work smoke plus four daily workflows against that artifact;
4. creates or updates the non-draft, non-prerelease GitHub Release with the same tested `dline-X.Y.Z.vsix`.

After that workflow succeeds, `.github/workflows/publish-vscode-marketplace.yml` verifies the triggering workflow, release asset, tag ancestry, tested-artifact SHA-256, VSIX identity, version, and release channel before entering the protected Marketplace environment.

Do not manually replace the release asset or publish a locally rebuilt VSIX. Marketplace publication must use the verified tested artifact.

## 8. Final report

Report:

- repository, final `main` squash SHA, and the `dev` back-merge SHA;
- release version and production tag;
- dev integration and production workflow evidence;
- GitHub Release and VSIX asset status;
- Marketplace workflow status;
- any operation that remains unperformed or requires separate authorization.
