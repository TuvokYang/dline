---
name: dev-version-bump
description: Prepare a release version and bilingual notes on dev or an isolated branch; optionally create an authorized dev pre-release after integration. Production promotion remains in release.
---

# Version and Development Pre-release Preparation

Prepare version files for a production release, patch or pre-release directly on `dev` or a recommended isolated branch. This is the shared version-writing procedure used by `release` and `hotfix-release`. The optional development-tag stage applies only when the user requests a pre-release; it does not promote `main` or create a production tag.

Follow `repository-and-release` for branch and version policy.

## 1. Confirm the development branch

Inspect the current branch and working tree:

```text
git branch --show-current
git status --short
git branch -vv
```

Stop on `main`. Direct preparation on `dev` is allowed. An independent branch such as `chore/release-X.Y.Z` is recommended for isolation and is mandatory only when the preparation will be submitted through a PR.

Do not include unrelated or unknown working-tree changes.

## 2. Establish the version range

Confirm the requested channel, target `X.Y.Z` and exact previous release ref. For production notes, use the preceding valid `vX.Y.Z` in verified `main` history. For a pre-release delta, use the preceding applicable `dev-vX.Y.Z` on that line; for its first pre-release, explicitly establish the preceding production baseline instead. Resolve refs to commits and inspect ancestry, not just spelling. Never choose a baseline by lexicographic tag order or substitute `HEAD` when it is unresolved.

Choose the target using `scripts/release-version-policy.mjs` and the version policy in `repository-and-release`: production has an even minor, pre-release an odd minor, and the minor never decreases. Start a production line at the next even minor, a fix release at the next patch of the current even minor, and a pre-release line at the next odd minor. Stop on wrong parity or a requested older minor. If a hotfix would require lowering the current dev line or excluding its changes, use the exceptional-strategy decision in `hotfix-release`; do not silently downgrade version files.

```text
git --no-pager log --oneline <previous-version-ref>..HEAD
git --no-pager diff --stat <previous-version-ref>..HEAD
```

Review implementation and tests to establish the actual changes for the changelog. Separately verify the latest actual production publication and its tag/commit for the cumulative `Unreleased` baseline; a pre-release delta ref does not replace that baseline.

Before writing, read the single current section in `CHANGELOG.md` and `docs/changelog/CHANGELOG_en.md`, package/lock versions and both top What's New sections. Establish whether current still holds an older exact version `<current-version>` or the cumulative `Unreleased` section, and read its complete bilingual content. Stop on missing, empty, conflicting or mismatched section content. Archive and version preparation are not publication evidence and must not assign a release date or advance the production baseline.

## 3. Update the release files

Update all six release facts together; every version bump, including a patch or pre-release, touches all of them:

- `CHANGELOG.md` (Chinese current body);
- `docs/changelog/CHANGELOG_en.md` (English current body);
- `docs/whats-new/WHATS_NEW.md` (Chinese);
- `docs/whats-new/WHATS_NEW_en.md` (English default; the dialog renders the active language edition);
- `package.json`;
- `package-lock.json`.

### Append the older exact version before replacing current

Follow `repository-and-release`. When current holds an older exact version, run the maintenance check and preview append for that version, not the target version. When current holds `Unreleased`, no append happens here; verify the baseline and final net change before renaming that section in the step below.

```text
npm run changelog:check
npm run changelog:append -- --version <current-version> --dry-run
```

Review the preview, then explicitly append that version (skip both commands when current holds `Unreleased`):

```text
npm run changelog:append -- --version <current-version>
```

Normal append requires `--version <X.Y.Z>` with a numeric version and reads only that exact frozen section from the current bodies. It archives it into `docs/changelog/history.zh-CN.md` and `docs/changelog/history.en.md` (one file per language, one section per version, never a per-version directory) and leaves current unchanged. Append never modifies current, package/lock or What's New, does not archive `Unreleased` and does not publish anything; builds, Insiders timestamps and temporary manifest edits do not invoke it.

An existing version with identical content in both languages is a no-op. Different content, unrelated missing versions, or unknown guard/temp state stops the operation without permission to overwrite. Confirm both history files before replacing current. The two files are sequential replacements, not a cross-file power-loss transaction: inspect any guard/temp left by an interrupted run first. Only the same frozen current version with identical already-published text and otherwise paired history can resume; preserve unknown state for manual investigation.

### Replace the single current section with the target

Write both current bodies so each keeps exactly one section. There are two preparation paths:

```markdown
## [Unreleased]     # development: the only section in both current bodies

## [X.Y.Z]          # frozen: replaces Unreleased once the target is exact and matches the manifest
```

- If current already holds an older exact version, append it as above, then replace that section with a genuinely curated target section and do not leave the old body relabelled as the target.
- If current holds `Unreleased`, verify the production baseline and the final net change for the target, then rename that one section to the exact candidate.

Either way current keeps exactly one section with the same name in both languages and never holds `Unreleased` and a version together. The target section must be non-empty and standalone, with only categories that have real entries. Both languages must describe the same changes in the same order, using one concise sentence per entry. Stop if the target conflicts with existing history, the editions differ in scope, or either body is empty.

- A pre-release snapshot covers the applicable delta established in step 2; do not clear the cumulative `Unreleased` record on each pre-release or preparation.
- A production snapshot covers the final net changes since the preceding verified production publication, including the pre-release work and final dev changes. Reconcile against implementation and tests; neither the last delta alone nor a mechanical concatenation of historical snapshots is sufficient.
- After an actual production publication is verified, explicitly maintain the cumulative record against what that release shipped. Retain newer dev changes if development has continued. Neither append nor this preparation advances that baseline.

Routine dev integrations update cumulative `Unreleased`; they do not create a permanent Insiders version or change package/What's New on each commit.

Add a What's New section for the exact target version at the top of both What's New files, above the previous release, which stays below as history:

```markdown
## X.Y.Z

- **Short summary**: one sentence on what users can now do or what no longer goes wrong.
```

- The webview build ships only the first `##` section, and its heading must be a bare `X.Y.Z`. `## Unreleased` is invalid here, not a draft section. Do not place any other `##` heading above it.
- That section must stand alone for the version. For a patch, carry forward the highlights of the current minor line that still apply and add the patch's user-visible fixes; do not write only "bug fixes".
- Independently select at most five highlights from the target changelog, each within 128 characters including its bold lead-in. Do not pad the list, insert placeholder highlights, or generate it by concatenating changelog entries. Allowed syntax is one flat `- ` list, two-space continuation lines, `**bold**`, `` `code` ``, and absolute `https://` links, without nesting; unsupported syntax fails the build.
- The Chinese edition carries the same version, scope, number of items and order, with equivalent meaning.

After the current content is written (and the older exact version is appended, when current held one), synchronize package/lock and both What's New editions to the target without changing dependency ranges. If using a package-manager command to synchronize versions, that dependency/tooling operation requires the applicable authorization and its resulting diff must be reviewed. Then run the read-only consistency check:

```text
npm run changelog:check
```

There is no generated index to refresh: `CHANGELOG.md` and `docs/changelog/CHANGELOG_en.md` are the current bodies, so writing them is the only current-side step. Check and build never write, and no compatibility index or source footer is generated around the bodies.

This multi-file preparation is not one atomic transaction. If interrupted or left inconsistent, keep the complete history, report the mismatched files and stop packaging until the intended target state is repaired. Do not automatically restore old notes under a new version, and do not claim that temporary-file cleanup or `finally` recovers a power interruption.

## 4. Validate the prepared state

At minimum run:

```text
npm run check-types
npm run lint
npm run test:smoke
npm run changelog:check
npx vitest run webview-ui/src/__tests__/vite-whats-new.test.ts src/__tests__/changelog.test.ts src/__tests__/extract-changelog-section.test.ts
```

`changelog:check` uses the shared extraction CLI's read-only `--check` mode to validate current/manifest, bilingual versions and complete history, and it never writes. CI and E2E packaging use the same one read-only current body and report the effective manifest version. The What's New test fails when either edition is malformed, when the first section's version differs from `package.json`, or when the two editions differ in version or item count. Review scope, order, the five-item/128-character budgets and lockfile version separately; all six release facts must match the target. Missing or mismatched current content must block packaging, never select old history as fallback notes.

Run focused Vitest, functional E2E, Storybook, or package checks required by the changed release surface. When preparing the exact integrated release candidate, load `e2e-validation` and run `npm run test:e2e:work`; do not substitute full functional or dev-tier E2E for the required work gate. Review the final diff and ensure only intended release-preparation files and approved companion changes are present.

## 5. Commit and PR boundaries

A commit is optional and requires its own authorization. If approved, stage only owned files and use the repository commit-message convention, for example:

```text
chore(release): prepare X.Y.Z
```

Push and PR creation require separate authorization. If an ordinary PR is created, its head must be an independent release-preparation branch and its base must be `dev`; direct `dev` work is not itself submitted as a PR source.

Do not create `vX.Y.Z` here. Preparation, commit, push and PR operations do not authorize a development tag either; use the guarded stage below only for a requested pre-release.

## 6. After merge to dev

Re-run the integrated checks on exact `dev` head, whether preparation was direct or arrived through a PR. For production or a production patch, hand the prepared candidate to `release`; for a development pre-release, continue below only when that operation is requested.

## 7. Development pre-release only

1. Resolve the writable repository/remote through `repository-and-release` and refresh remote facts only under the applicable network authorization. Verify that the prepared commit is both local and resolved remote `dev` head. Stop if dev moved, the version is not an odd minor, the release files disagree, or the exact tag already exists locally or remotely.
2. Show repository and push URL, exact dev SHA, tag name and destination ref. Obtain local tag-creation authorization separately from tag-push authorization; a user instruction may grant both explicitly.
3. Only after local tag creation is authorized, create it at the verified dev commit:

   ```text
   git tag -a dev-vX.Y.Z <verified-dev-sha> -m "Dline X.Y.Z pre-release"
   ```

   Inspect its target read-only and require equality with the verified dev SHA:

   ```text
   git rev-parse "dev-vX.Y.Z^{commit}"
   ```

4. Refresh the dev-head fact under the applicable network authorization and stop if it moved. Show the tag object, target SHA and exact destination in the push preview. Only after tag push is authorized, run:

   ```text
   git push <remote> refs/tags/dev-vX.Y.Z:refs/tags/dev-vX.Y.Z
   ```

   Never move or overwrite an existing tag. Local creation does not authorize this remote write.
5. Observe `release-draft.yml` (`Publish Pre-release`): it checks exact dev head and calls `test.yml` with the pre-release channel. Publication waits for full Vitest and both publisher-specific final VSIX files to pass one Linux work smoke and all four daily workflows on Linux, macOS and Windows. Record commit, run, and each artifact's name and SHA-256.
6. Verify the public GitHub pre-release and `publish-vsix-registries.yml` results. Both registries are enabled by default and each receives its own tested artifact; Marketplace uploads run only in GitHub Actions. Report each result separately because the aggregate gate requires at least one registry to succeed; disabled/skipped is not published. Do not rebuild or replace a tested asset to repair a publication failure.

## 8. Report

Report channel, target version, exact baseline and candidate SHAs, changed release files, verification and outstanding commit/push/PR work. For a requested pre-release, also report tag target, tag-push status, workflow run, tested VSIX identity and actual publication results. Do not imply production promotion occurred.
