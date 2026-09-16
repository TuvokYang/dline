# Repository, Branch, and Release Contract

This rule defines repository discovery, fork safety, branch roles, worktree isolation, pull requests, releases, and hotfixes. Other `.agents` workflows and skills must reference this contract instead of hard-coding remote names, repository owners, repository URLs, or personal branches.

## 1. Stable branch roles

Only these branch roles are stable:

- `dev`: the integration branch. Local development and authorized commits may occur directly on `dev`; the full integration gate still applies before production promotion.
- `main`: the production branch. Direct development is prohibited; it only receives a release candidate after `dev` has passed the complete release gate.
- Independent development branches: `feature/*`, `bugfix/*`, `docs/*`, `refactor/*`, `chore/*`, or another task-specific non-shared branch. They are recommended for isolation and mandatory when creating an ordinary PR.

A remote name is never a branch role. Names such as `origin`, `upstream`, or any custom alias are not trusted facts.

## 2. Dynamic repository and remote discovery

Before proposing any Git or pull-request write, perform read-only discovery:

```text
git branch --show-current
git status --short
git remote -v
git rev-parse --abbrev-ref --symbolic-full-name "@{upstream}"
git branch -vv
```

Resolve the repository, remote, and destination in this order:

1. An explicit repository, remote, and ref in the user's current instruction.
2. The current branch's configured upstream, when it matches the intended hosting service.
3. Base repository, head repository, base ref, and head ref returned by the PR/MR platform.
4. In a fork flow, a writable fork remote owned by the current user or the PR head owner.

Stop and ask the user when:

- the current branch has no upstream;
- more than one remote may be writable;
- fetch and push URLs differ and the intent is unclear;
- the operation would write to a base repository, organization repository, or another user's fork;
- the target hosting service is ambiguous;
- a remote, tracking branch, push default, or repository configuration would need to be added or changed.

Never:

- trust a remote merely because it has a conventional name;
- push to the first remote found;
- hard-code a repository owner, URL, or remote alias in reusable instructions;
- mix GitHub PR and GitLab MR commands without an explicit target;
- silently add, rename, or replace a remote to make a command work.

## 3. Push preview and authorization

Before each remote write, show:

- the resolved target repository and push URL;
- source branch/ref and commit SHA;
- destination ref;
- whether this is a normal push, tag push, or forced update;
- the expected remote SHA for force-with-lease;
- commits that would leave the destination branch history.

Treat these as separate authorizations:

- commit;
- push the current development branch;
- force-with-lease;
- create a PR/MR;
- submit a review or reply;
- merge a PR/MR;
- push `dev`;
- promote or push `main`;
- create and push a tag;
- publish a GitHub Release, Marketplace package, or other external state.

Never use unconditional `--force`. When history replacement is explicitly approved, refresh the remote SHA and bind an explicit `--force-with-lease` to that SHA.

## 4. Worktrees and independent branches

- Every parallel worktree must use its own independent branch, never shared `dev` or `main`.
- The branch should express its purpose, such as `feature/<slug>` or `bugfix/<slug>`.
- Worktrees must not write the same branch or overlapping paths concurrently. Serialize the work or use the project's coordination mechanism.
- A commit inside an approved worktree does not authorize push, PR creation, merge, or worktree cleanup.
- Removing a worktree or branch, or rewriting shared history, requires separate authorization.

## 5. Ordinary development and pull requests

Development may proceed directly on `dev` or on an independent branch. Independent branches and worktrees are recommended when isolation, parallel work, review, or recovery benefits justify them.

An ordinary PR uses this mandatory path:

```text
independent feature/bugfix/docs/refactor/chore branch
  -> focused local verification
  -> authorized push to the dynamically resolved fork/upstream
  -> PR to dev
  -> CI and review
  -> merge to dev
  -> dev integration verification
```

Hard requirements:

- The source/head of an ordinary PR must be an independent development branch.
- Direct work on `dev` is allowed, but if that work must be submitted as an ordinary PR it must first be placed on an independent source branch. `main` is never a development branch.
- Feature and bugfix branches must enter `dev`; they must not target `main` directly.
- Repository identity, base/head repositories, and base/head refs must come from platform metadata or explicit parameters.
- Fork PRs must keep the base and head repositories distinct and must never push a contributor branch to the base repository.
- Before PR creation, show title, body, repository, head, base, draft state, and verification evidence.

`dev -> main` is a release promotion, not an ordinary PR. If a platform represents promotion as a PR, the head is `dev`, the base is `main`, and the release gate applies.

## 6. Dev integration gate

After changes enter `dev`, run and record the checks required by the actual blast radius:

- TypeScript and generated-code checks;
- formatting and lint;
- Smoke and Vitest;
- applicable Webview, Storybook, or real VS Code E2E tests;
- production VSIX packaging and content verification;
- version, lockfile, bilingual changelog, and manifest consistency for a release candidate.

Promotion may be proposed only when the release candidate's required checks pass, blockers are resolved, and the target commit is unambiguous. Passing tests on one feature branch is not equivalent to passing the integrated `dev` gate.

## 7. Promotion from dev to main

Perform release promotion in this order:

1. Fetch and read explicit `refs/remotes/<remote>/dev` and `refs/remotes/<remote>/main` SHAs, then compute the merge base and diff from those refs; never treat bare local `dev` or `main` as remote facts.
2. Confirm that integrated `dev` passed the complete release gate.
3. Confirm version, lockfile, bilingual changelog, and VSIX contracts.
4. Show the promotion method and resolved destination.
5. Obtain authorization to write `main`.
6. Promote `dev` to `main`.
7. Verify the final `main` commit again.
8. Obtain separate authorization to create and push the production tag.
9. Create `vX.Y.Z` only from that verified `main` commit.
10. Observe the automated Release, VSIX, and Marketplace gates.

Never:

- merge a feature or bugfix branch directly to `main`;
- modify or push `main` before the integrated `dev` gate passes;
- create a production tag from a commit outside `main` history;
- treat a release commit, main push, tag push, and external publication as one authorization.

## 8. Hotfixes

The default hotfix path remains on the mainline. The fix may be developed directly on `dev` or on a recommended independent bugfix branch. If a PR is used, its source must be independent and its base must be `dev`:

```text
fix on dev, or independent bugfix branch -> optional PR to dev -> dev gate -> dev promotion to main -> production tag on main
```

Do not build a production side branch from an old release tag when that commit would not belong to `main` history.

If `dev` contains features that cannot ship with the hotfix, the default process is insufficient. Stop and obtain approval for a release-candidate and back-merge strategy that defines:

- how the fix enters both `dev` and `main`;
- how main ancestry remains valid;
- how unreleased features are excluded;
- tag, verification, back-merge, and recovery order.

Until that strategy is approved, the hotfix workflow must stop instead of inventing an old-tag cherry-pick path.

## 9. Tag semantics

- A development release tag must match `dev-vX.Y.Z`, point to the exact current `dev` head, and may be pushed only after tag creation is authorized. It triggers the `Publish Draft Release (Dev)` workflow, whose GitHub draft-release job consumes the tested VSIX only after the complete reusable Tests workflow, including full Vitest, three-platform E2E, and package success.
- A `dev-vX.Y.Z` tag is never a production baseline and must not trigger the Production Release or production Marketplace workflow.
- A production tag must match `vX.Y.Z` and point to a verified `main` commit.
- Creating a local tag, pushing it, and replacing a remote tag are separate operations.
- Never move or overwrite an existing tag without explicit approval and an impact assessment.

## 10. Distribution channels

`npm run vsix` derives the packaged identity from the current branch and the tag pointing at `HEAD`, so a single command produces the correct artifact for each channel. `scripts/package-vsix.mjs` owns this resolution; do not reintroduce a branch-only or tag-only heuristic.

| HEAD | Extension name | Version | Channel |
| --- | --- | --- | --- |
| `main` + `vX.Y.Z` | `dline` | `X.Y.Z` from the tag | Production |
| `dev` + `dev-vX.Y.Z` | `dline-preview` | `X.Y.Z` from the tag | Release candidate |
| `dev` without a tag | `dline-insiders` | `major.minor.<unix-seconds>` | Rolling build |

The three names are independent Marketplace extensions with independent version sequences. A Marketplace `version` accepts only three numeric segments, so a semver pre-release suffix such as `0.9.4-rc.1` cannot be published; the preview channel therefore reuses the exact tag version and the insiders channel replaces the patch with a timestamp.

Packaging rules:

- A tagged channel is a release candidate, so the tag version, `package.json`, and every changelog language edition must already agree before packaging starts. A missing `## [X.Y.Z]` heading in either edition fails the run.
- The untagged insiders channel is a rolling build and skips the changelog gate, because it does not represent a documented release.
- Reject rather than guess: `main` without a tag is the unfinished middle of a promotion, a `vX.Y.Z` tag outside `main` or a `dev-vX.Y.Z` tag outside `dev` means the tag was created on the wrong branch, and any other branch has no channel.
- Tag formats must be matched exactly (`^v\d+\.\d+\.\d+$` and `^dev-v\d+\.\d+\.\d+$`). An exact-match tag lookup without format validation makes a development tag package a production identity.
- `package.json` and `README.md` are mutated during packaging and must be restored even when the run aborts.

A deleted Marketplace extension ID cannot be reused, so renaming a channel means creating a new extension entry and losing its installed base. Treat a channel name as a stable public contract.

Packaging is not publishing. Producing a VSIX never implies authorization to publish it; Marketplace publication remains a separate external write under §3.

## 11. Workflow and skill authoring rules

Git, PR, and release instructions must:

- use dynamic placeholders such as `<repository>`, `<remote>`, `<head-ref>`, and `<base-ref>`;
- explain how each value is discovered;
- separate read-only inspection, local Git writes, and remote writes;
- use shell-neutral commands or label the required shell explicitly;
- avoid repository-local temporary output files;
- fail when a base cannot be determined instead of falling back to `HEAD`;
- omit maintainer-specific repositories, remotes, and personal branches;
- avoid execution links or examples from another repository.

## 11. Minimum verification scenarios

After changing a Git workflow or skill, verify at least:

1. a clone whose remote is not conventionally named;
2. a fork remote with an arbitrary name;
3. a branch with no upstream;
4. multiple writable remotes;
5. different fetch and push URLs;
6. a feature worktree PR to `dev`;
7. a bugfix worktree PR to `dev`;
8. rejection of an ordinary PR from `dev`;
9. rejection of ordinary development or PR creation from `main`;
10. rejection of promotion when the `dev` gate fails;
11. authorized promotion after the complete `dev` gate passes;
12. `dev-vX.Y.Z` development release tags only from the exact `dev` head, with GitHub draft release creation blocked until full Vitest, three-platform E2E, and package jobs pass;
13. production tag creation only from the final verified `main` commit.
