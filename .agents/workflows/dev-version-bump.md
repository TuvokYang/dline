---
name: dev-version-bump
description: Prepare package and bilingual changelog versions on dev or an isolated branch, with independent source branches required only when creating a PR into dev.
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

```text
git --no-pager log --oneline <previous-version-ref>..HEAD
git --no-pager diff --stat <previous-version-ref>..HEAD
```

Review implementation, tests, and user-visible behavior rather than deriving release notes only from commit subjects.

## 3. Update the release files

Update all four release facts together:

- `CHANGELOG.md` (Chinese);
- `docs/changelog/CHANGELOG_en.md` (English);
- `package.json`;
- `package-lock.json`.

Use the existing changelog structure and include only sections that contain real entries:

```markdown
## [X.Y.Z]

### Features
### Changed
### Fixed
```

The two changelogs must describe the same user-visible changes, not independent release scopes.

Update package and lockfile versions without changing dependency ranges. If using a package-manager command to synchronize them, that dependency/tooling operation requires the applicable authorization and its resulting diff must be reviewed.

## 4. Validate the prepared state

At minimum run:

```text
npm run check-types
npm run lint
npm run test:smoke
```

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

Report the target version, previous ref, changed release files, verification evidence, and any uncommitted, unpushed, or unmerged work.
