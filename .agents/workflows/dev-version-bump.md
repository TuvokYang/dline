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

Review implementation and tests to establish the actual changes for the changelog.

## 3. Update the release files

Update all six release facts together; every version bump, including a patch or pre-release, touches all of them:

- `CHANGELOG.md` (Chinese);
- `docs/changelog/CHANGELOG_en.md` (English);
- `docs/whats-new/WHATS_NEW.md` (Chinese);
- `docs/whats-new/WHATS_NEW_en.md` (English, rendered in the What's New dialog);
- `package.json`;
- `package-lock.json`.

Freeze the paired changelogs according to repository-and-release before changing the package version:

- For a new pre-release or a production patch, move the applicable non-empty `Unreleased` body into the exact `## [X.Y.Z]` section.
- For a production release after one or more pre-releases, write a standalone cumulative `## [X.Y.Z]` section covering the actual release changes since the preceding production release; consolidate the odd-minor pre-release sections and any final `Unreleased` delta instead of copying only the latest delta or referring readers elsewhere.
- Recreate an empty `## [Unreleased]` section above the new version and keep all prior version sections as history.
- Stop if the target section already exists with conflicting content, the two language editions describe different scopes, or the target section would be empty.

Use the existing changelog structure and include only sections that contain real entries below the empty rolling section:

```markdown
## [Unreleased]

## [X.Y.Z]

### Features
### Changed
### Fixed
```

The two changelogs record the same changes in the same order, using one concise sentence per entry. Routine dev integrations update only `Unreleased`; they do not update package versions or What's New until this version-preparation workflow runs.

Add a What's New section for the exact target version at the top of both What's New files, above the previous release, which stays below as history:

```markdown
## X.Y.Z

- **Short summary**: one sentence on what users can now do or what no longer goes wrong.
```

- The webview build ships only the first `##` section, and its heading must be a bare `X.Y.Z`. Do not place any other `##` heading above it.
- That section must stand alone for the version. For a patch, carry forward the highlights of the current minor line that still apply and add the patch's user-visible fixes; do not write only "bug fixes".
- Write at most five highlights selected from the changelog, each led by a bold summary; do not pad the list to reach a minimum count. Allowed syntax is one flat `- ` list, two-space continuation lines, `**bold**`, `` `code` ``, and absolute `https://` links, without nesting; anything else fails the build.
- The Chinese edition carries the same version, the same number of items, and the same meaning.

Update package and lockfile versions without changing dependency ranges. If using a package-manager command to synchronize them, that dependency/tooling operation requires the applicable authorization and its resulting diff must be reviewed.

## 4. Validate the prepared state

At minimum run:

```text
npm run check-types
npm run lint
npm run test:smoke
npx vitest run webview-ui/src/__tests__/vite-whats-new.test.ts
```

The What's New test fails when either edition is malformed, when the first section's version differs from `package.json`, or when the two editions differ in version or item count.

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
