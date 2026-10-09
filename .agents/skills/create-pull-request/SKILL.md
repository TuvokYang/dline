---
name: create-pull-request
description: Create a fork-safe pull request from an independent development branch into dev. Discovers repository and remote topology dynamically, previews all writes, follows the project template, and keeps commit, push, PR creation, reviewers, and labels as separate authorizations.
---

# Create Pull Request

Create an ordinary development PR without assuming a remote alias, repository owner, URL, or writable base repository.

Follow `repository-and-release` before using this skill.

## 1. Check local and platform prerequisites

Use read-only checks:

```text
git branch --show-current
git status --short
git remote -v
git branch -vv
git rev-parse HEAD
gh --version
gh auth status
```

If `gh` is unavailable or unauthenticated, report the blocker. Installing software or changing credentials requires separate user action or authorization.

Do not stash, discard, restore, commit, rebase, or switch branches merely to make the working tree clean. Unknown or unrelated changes must be preserved and reported.

## 2. Enforce the branch contract

The current branch must be an independent branch such as `feature/*`, `bugfix/*`, `docs/*`, `refactor/*`, or `chore/*`.

Stop when the current branch is `dev` or `main`. Ordinary PRs must not use either shared branch as the source/head. Require a dedicated branch or worktree instead.

The ordinary PR base is `dev`. A `dev`-to-`main` PR is a release promotion and must use the release workflow, not this skill.

## 3. Resolve repository and fork topology

Resolve:

- `<base-repository>`: the repository that owns the target `dev` branch;
- `<head-repository>`: the repository that will host the contributor branch;
- `<push-remote>`: the local remote whose push URL maps to `<head-repository>`;
- `<head-owner>` and `<head-ref>`;
- the current base SHA and head SHA.

Use explicit user input, branch upstream configuration, platform metadata, and remote URLs in the order defined by the repository contract.

Stop when:

- the branch has no upstream;
- more than one remote may be writable;
- fetch and push URLs imply different repositories and intent is unclear;
- pushing would write the contributor branch to the base repository without explicit authorization;
- the GitHub repository cannot be distinguished from another hosting target;
- adding or changing a remote/tracking configuration would be required.

## 4. Analyze the proposed PR

Compare against the resolved `dev` base or merge base:

```text
git --no-pager log <base-ref>..HEAD --oneline --decorate
git --no-pager diff --stat <base-ref>...HEAD
git --no-pager diff --name-status <base-ref>...HEAD
git --no-pager diff <base-ref>...HEAD
```

Read changed implementation, tests, consumers, and relevant project contracts. Confirm the branch represents one coherent goal and contains no unrelated workspace changes or commits.

Do not rewrite history merely for cosmetic commit preferences. Rebase, squash, reset, or force-with-lease are Git writes that require an explicit impact preview and separate authorization.

## 5. Verify before remote writes

Run the checks appropriate to the blast radius. At minimum, record focused tests and the applicable type, lint, format, build, or package checks.

Feature-branch verification does not replace the integration checks that run after the PR enters `dev`.

Contributors must not create changelog-entry files, add What's New sections, or perform release version bumps unless the user explicitly requested release preparation. Maintainers curate release versions, changelogs, and What's New through the release workflow.

## 6. Prepare the PR body

Read `.github/pull_request_template.md` and preserve its current section structure when applicable. Fill it with evidence from the actual diff and verification.

Include:

- problem and motivation;
- solution and important design decisions;
- user-visible or compatibility impact;
- tests and manual verification;
- risks, screenshots, or follow-up work when relevant;
- a real issue reference only when one exists. Use the template's documented no-issue value rather than leaving a fake placeholder.

Determine whether the PR should be draft. Do not mark unchecked work as completed.

## 7. Preview each write

Before pushing, show:

- `<head-repository>` and `<push-remote>` push URL;
- local branch and head SHA;
- destination branch;
- commits to be uploaded;
- normal push or force-with-lease and its expected remote SHA.

Obtain push authorization. If force-with-lease is required, refresh the remote SHA immediately before the write and bind the lease to that SHA. Never use unconditional force.

Before PR creation, show:

- `<base-repository>`;
- `head=<head-owner>:<head-ref>`;
- `base=dev`;
- title, full body, and draft state;
- verification evidence.

PR creation requires authorization separate from push.

## 8. Create the PR

Use repository-qualified arguments:

```text
gh pr create --repo <base-repository> --head <head-owner>:<head-ref> --base dev --title <title> --body-file -
```

Add `--draft` only when the approved preview is draft.

For multiline bodies, use a shell-appropriate standard-input mechanism. If a temporary file is necessary, use an approved system temporary location, not a repository-local file, and remove it afterward.

If a PR already exists for the same base/head pair, stop and show it. Updating an existing PR is a separate external write.

## 9. Keep follow-up writes separate

Do not automatically add reviewers, labels, milestones, comments, or merge the PR. Each is an external write requiring its own preview and authorization.

After creation, report the PR URL, repository, head/base refs, head SHA, draft state, verification, and remaining CI or review work.

## Completion checklist

- [ ] Repository and fork topology were discovered, not assumed.
- [ ] Source is an independent branch; base is `dev`.
- [ ] Unknown workspace changes were preserved.
- [ ] Diff, commits, and verification were reviewed.
- [ ] Push target and PR payload were previewed separately.
- [ ] Only explicitly authorized remote writes were performed.
- [ ] No release versioning, reviewer, label, review, or merge action was inferred.
