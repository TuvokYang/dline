# Repository, Branch, and Release Contract

This rule owns repository identity, branch roles, authorization, compatibility and release acceptance constraints. It does not duplicate execution procedures. Use `dev-version-bump` for version preparation and a development pre-release, `release` for production promotion, `hotfix-release` for urgent-fix coordination, and `create-pull-request` for ordinary PR work. These operations have different goals and are not one combined workflow.

Reusable guidance must reference this contract rather than hard-code repository owners, remote aliases, URLs or personal branches.

## 1. Stable branch roles

Only these branch roles are stable:

- `dev`: the integration branch. Local development and authorized commits may occur directly on `dev`; the full integration gate still applies before production promotion.
- `main`: the production branch. Direct development is prohibited; it only receives a release candidate after `dev` has passed the complete release gate.
- Independent development branches: `feature/*`, `bugfix/*`, `docs/*`, `refactor/*`, `chore/*`, or another task-specific non-shared branch. They are recommended for isolation and mandatory when creating an ordinary PR.

A remote name is never a branch role. Names such as `origin`, `upstream`, or any custom alias are not trusted facts.

## 2. Dynamic repository and remote discovery

Before proposing any Git or pull-request write, establish the current branch, working-tree changes, remote fetch/push URLs, upstream and tracking state. `create-pull-request` and `release` contain the operation-specific discovery commands.

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
- squash/commit on `main`;
- push `main`;
- back-merge the release commit into `dev`;
- create a local tag;
- push a tag;
- publish a GitHub Release, Marketplace package, or other external state.

A user instruction may explicitly authorize several named operations; do not ask again for the same granted scope. A workflow, version bump, successful check or existing commit grants no additional operation. In particular, local tag creation does not authorize tag push, and neither authorizes an unrelated publication or override.

Never use unconditional `--force`. When history replacement is explicitly approved, refresh the remote SHA and bind an explicit `--force-with-lease` to that SHA.

## 4. Worktrees and independent branches

- Every parallel worktree must use its own independent branch, never shared `dev` or `main`.
- The branch should express its purpose, such as `feature/<slug>` or `bugfix/<slug>`.
- Worktrees must not write the same branch or overlapping paths concurrently. Serialize the work or use the project's coordination mechanism.
- A commit inside an approved worktree does not authorize push, PR creation, merge, or worktree cleanup.
- Removing a worktree or branch, or rewriting shared history, requires separate authorization.

## 5. Ordinary development and pull requests

Development may proceed directly on `dev` or on an independent branch. Independent branches and worktrees are recommended when isolation, parallel work, review, or recovery benefits justify them.

Use `create-pull-request` for the ordered discovery, verification, preview and authorized writes. The PR contract is:

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
- applicable Webview, Storybook, or focused functional E2E tests;
- one VSIX packaged before the required E2E gate, one Linux work smoke, then each of four daily workflows on Linux, macOS and Windows against that exact artifact;
- full functional E2E only in production release validation or explicit investigation, and no dev-tier E2E in required CI or release gates;
- VSIX identity, content, and tested-artifact verification;
- version, lockfile, bilingual changelog, bilingual What's New, and manifest consistency for a release candidate.

Promotion may be proposed only when the release candidate's required checks pass, blockers are resolved, and the target commit is unambiguous. Passing tests on one feature branch is not equivalent to passing the integrated `dev` gate.

## 7. Promotion from dev to main

`main` keeps one squash commit per release, not the `dev` history. The production commit is `release: X.Y.Z`; its tree must equal the exact verified `dev` candidate. The release commit must become an ancestor of `dev` through an `ours` back-merge that leaves `dev` content unchanged. That back-merge must land before another promotion; otherwise a later squash can reapply already-released changes.

History that reached `main` before this rule (fast-forward promotions up to `v0.9.4`) stays as it is. Never rewrite `main` to remove it.

Use `release` for the fetch, candidate verification, push previews, separately authorized squash/back-merge/tag operations and publication observation. Its evidence must bind explicit remote-tracking `dev`/`main` SHAs, the verified tree and the tested artifact; bare local branch names are not remote facts.

The automatic `release.yml` gate requires the production tag at current `main` head. The separate manual override in `publish-vscode-marketplace.yml` requires main ancestry and an explicit reason; it is not the automatic continuation and is not an ordinary release shortcut. Neither shape requires the individual `dev` commits in `main` history.

Never:

- merge a feature or bugfix branch directly to `main`;
- fast-forward or `--no-ff` merge `dev` into `main`;
- modify or push `main` before the integrated `dev` gate passes;
- push a squash commit whose tree differs from the verified `dev` candidate;
- start a new promotion while the previous release's back-merge into `dev` is missing;
- create a production tag from a commit outside `main` history;
- treat a release commit, main push, tag push, and external publication as one authorization.

## 8. Hotfixes

Hotfixes keep the same branch and acceptance contracts: the fix enters `dev` directly or through an independent bugfix PR, and production promotion still satisfies §6–§7. Use `hotfix-release` for the incident-specific checks; it delegates version files to `dev-version-bump` and production promotion to `release` rather than repeating those procedures.

Do not build a production side branch from an old release tag when that commit would not belong to `main` history.

If `dev` contains features that cannot ship with the hotfix, the default process is insufficient. Stop and obtain approval for a release-candidate and back-merge strategy that defines:

- how the fix enters both `dev` and `main`;
- how main ancestry remains valid;
- how unreleased features are excluded;
- tag, verification, back-merge, and recovery order.

Until that strategy is approved, the hotfix workflow must stop instead of inventing an old-tag cherry-pick path.

## 9. Tag semantics

- A development release tag must match `dev-vX.Y.Z` and point to exact current `dev` head. `Publish Pre-release` gates publication on full Vitest, one packaged VSIX, one Linux work smoke and each of four daily workflows on Linux, macOS and Windows against that artifact. Version preparation and the separately authorized development tag operations belong to `dev-version-bump`.
- A `dev-vX.Y.Z` tag is never a production baseline and must not trigger the Production Release or production Marketplace workflow.
- A production tag must match `vX.Y.Z` and point to a verified `main` commit.
- Creating a local tag, pushing it, and replacing a remote tag are separate operations.
- Never move or overwrite an existing tag without explicit approval and an impact assessment.

## 10. Distribution channels

`npm run vsix` derives the packaged identity from the current branch and the tag pointing at `HEAD`, so a single command produces the correct artifact for each channel. `scripts/package-vsix.mjs` owns this resolution; do not reintroduce a branch-only or tag-only heuristic.

| HEAD | Extension name | Version | Channel | Marketplace track |
| --- | --- | --- | --- | --- |
| `main` + `vX.Y.Z` | `dline` | `X.Y.Z` from the tag; `Y` even | `production` | Release |
| `dev` + `dev-vX.Y.Z` | `dline` | `X.Y.Z` from the tag; `Y` odd | `pre-release` | Pre-release |
| `dev` without a tag | `dline-insiders` | `major.<pre-release minor>.<unix-seconds>` | `insiders` | Release |

`tuvokyang.dline` carries both the release and the pre-release track; `dline-insiders` is a separate extension with its own version sequence. A pre-release keeps the production manifest identity and differs only by the VSIX pre-release marker (`Microsoft.VisualStudio.Code.PreRelease`, set by vsce `preRelease`) and by the GitHub asset name `dline-X.Y.Z-pre-release.vsix`. Registry gates reject a pre-release VSIX without the marker and a production VSIX that carries it. A Marketplace `version` accepts only three numeric segments, so a semver pre-release suffix such as `0.9.4-rc.1` cannot be published.

Release-content invariants:

- The paired changelogs have equivalent headings and user-visible scope. `Unreleased` records implemented, verified dev changes, not plans or internal-only churn.
- `Unreleased` is the cumulative user-visible difference from the latest published production release. Verify that release's tag/commit and its shipped behavior before writing entries; the preceding commit, PR, local version bump, or development checkpoint is not the baseline.
- Describe an unreleased feature once by its final behavior. Correct its existing Added/Changed entry as development evolves; do not list fixes to its unshipped intermediate versions as released-product regressions.
- Use Fixed only for a defect present in the release baseline. Omit reverted experiments, intermediate implementations, and changes with no net user-visible difference from that release; commit history is evidence, not a changelog outline.
- Rollout-gated (gray-release) features and their changes must not appear in either language of the changelog or What's New. Add them only when the rollout restriction is removed and they ship as regular released features.
- Tagged sections are non-empty. A production section covers all user-visible changes since the preceding production release, including the pre-release changes, rather than linking to a partial delta.
- A prepared version agrees across package, lockfile, both changelogs and both top What's New sections. The What's New editions agree on version and item count and follow the parser's supported syntax.
- Insiders is rolling: an untagged integration does not create a permanent version section or bump package/What's New for each commit.

Use `dev-version-bump` for base selection, changelog freezing, cumulative notes, What's New writing and file updates. Keep that procedure out of this rule and out of the production promotion steps.

Version policy:

- A registry keys a version only by publisher, name, and number; the pre-release track is a flag on that number. Production and pre-release therefore split one version space by minor parity, as the VS Code publishing guide recommends.
- Production releases use an even minor (`0.10.0`, `0.10.1`, `0.12.0`). Pre-releases use an odd minor (`0.11.0`, `0.11.1`, `0.13.0`). A pre-release never reuses a number a production release needs.
- Insiders follows the pre-release line: its major and minor are the package version's when the minor is odd, and the next odd minor when the package minor is even, with the patch replaced by a timestamp. Every Insiders build therefore sorts above the production release it follows.
- Production preparation targets the next even minor, or the next patch of the current even minor for a fix release; a new pre-release line targets the next odd minor. The minor never decreases.
- Every version bump includes a standalone top `## X.Y.Z` What's New section in both editions. `webview-ui/src/__tests__/vite-whats-new.test.ts` checks it against the package version and bilingual item count; a package-only bump does not satisfy the release contract.
- `scripts/release-version-policy.mjs` is the single source of these rules. `scripts/package-vsix.mjs` rejects a `vX.Y.Z` tag with an odd minor and a `dev-vX.Y.Z` tag with an even minor before packaging.
- Versions released before this rule, up to `0.9.4`, keep their numbers; `0.10.0` is the first release under it.

Packaging rules:

- A tagged channel is a release candidate, so the tag version, `package.json`, and every changelog language edition must already agree before packaging starts. A missing `## [X.Y.Z]` heading in either edition fails the run.
- The untagged insiders channel is a rolling build and skips the versioned changelog gate, because it does not represent a documented release; its draft may still render the current `Unreleased` section.
- An explicit `--channel insiders` (the dev push Tests run) ignores release tags at `HEAD`. A `dev-vX.Y.Z` tag must name the dev head, so the same commit is packaged both as the tagged pre-release and as a timestamped Insiders build; rejecting tagged commits would fail every pre-release's dev Tests run.
- Reject rather than guess: `main` without a tag is the unfinished middle of a promotion, a `vX.Y.Z` tag outside `main` or a `dev-vX.Y.Z` tag outside `dev` means the tag was created on the wrong branch, and any other branch has no channel.
- Tag formats must be matched exactly (`^v\d+\.\d+\.\d+$` and `^dev-v\d+\.\d+\.\d+$`). An exact-match tag lookup without format validation makes a development tag package a production identity.
- `package.json` and `README.md` are mutated during packaging and must be restored even when the run aborts.

A deleted Marketplace extension ID cannot be reused, so renaming a channel means creating a new extension entry and losing its installed base. Treat a channel name as a stable public contract.

Packaging is not publishing. Producing a VSIX never implies authorization to publish it; Marketplace publication remains a separate external write under §3.

Registry publication currently defaults to Open VSX only. `publish-vsix-registries.yml` skips the VS Code Marketplace job unless a caller passes `publish_marketplace: true`; a skipped/disabled target is not a successful publication. The ordered automatic and manual paths are documented in `release`.

The Open VSX job checks the track of an existing version before publishing. A track mismatch fails; a skipped duplicate is not reported as a new publication.

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

## 12. Minimum verification scenarios

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
11. authorized squash promotion after the complete `dev` gate passes, with a tree-equality check against the verified `dev` SHA and the `ours` back-merge into `dev`;
12. `dev-vX.Y.Z` development release tags only from exact `dev` head, with GitHub pre-release and enabled registry publication blocked until full Vitest, one package job, one Linux work smoke and all four daily workflows on all three platforms pass against the same VSIX;
13. production tag creation only from the final verified `main` commit.
