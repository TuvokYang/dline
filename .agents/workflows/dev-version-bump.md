---
name: dev-version-bump
description: Prepare package, bilingual changelog, and bilingual What's New versions on dev or an isolated branch, with independent source branches required only when creating a PR into dev.
---

# Development Version Preparation

Prepare a release version directly on `dev` or on a recommended isolated branch. This workflow does not publish, promote `main`, or create a production tag.

Follow `repository-and-release` first.

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

Confirm the target `X.Y.Z` and a precise previous version ref. Never infer the base from the newest lexicographic tag alone because development and production tags have different roles.

Choose the target by the version bump rules in repository-and-release: a production release (`vX.Y.Z`) uses an even minor, a pre-release (`dev-vX.Y.Z`) uses an odd minor, and the minor never decreases. Start a new production line at the next even minor, a fix release at the next patch of the current even minor, and a pre-release line at the next odd minor. Stop when the requested target has the wrong parity for its channel; packaging rejects it.

```text
git --no-pager log --oneline <previous-version-ref>..HEAD
git --no-pager diff --stat <previous-version-ref>..HEAD
```

Review implementation, tests, and user-visible behavior rather than deriving release notes only from commit subjects.

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
- For a production release after one or more pre-releases, write a standalone cumulative `## [X.Y.Z]` section covering every user-visible change since the preceding production release; consolidate the odd-minor pre-release sections and any final `Unreleased` delta instead of copying only the latest delta or referring readers elsewhere.
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

The two changelogs must describe the same user-visible changes, not independent release scopes. Routine dev integrations update only `Unreleased`; they do not update package versions or What's New until this version-preparation workflow runs.

Add a What's New section for the exact target version at the top of both What's New files, above the previous release, which stays below as history:

```markdown
## X.Y.Z

- **Short summary**: one sentence on what users can now do or what no longer goes wrong.
```

- The webview build ships only the first `##` section, and its heading must be a bare `X.Y.Z`. Do not place any other `##` heading above it.
- That section must stand alone for the version. For a patch, carry forward the highlights of the current minor line that still apply and add the patch's user-visible fixes; do not write only "bug fixes".
- Write three to six highlights selected from the changelog, each led by a bold summary. Allowed syntax is one flat `- ` list, two-space continuation lines, `**bold**`, `` `code` ``, and absolute `https://` links, without nesting; anything else fails the build.
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

Do not create `vX.Y.Z` here. A `dev-vX.Y.Z` development release tag may be created only after the prepared commit is the exact `dev` head, its target SHA is explicit, and tag creation is separately authorized. Pushing the tag triggers `Publish Draft Release (Dev)`; GitHub draft release creation remains blocked until the complete reusable Tests workflow finishes full Vitest, packages one VSIX, and runs the three-platform work smoke plus four daily workflows against that same artifact.

## 6. After merge to dev

Re-run the integrated checks on the exact `dev` commit. Only the production release workflow may promote a passing release candidate to `main` and create `vX.Y.Z`.

Report the target version, previous ref, changed release files including both What's New editions, verification evidence, and any uncommitted, unpushed, or unmerged work.
