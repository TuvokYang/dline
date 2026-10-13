---
name: write-workflow
description: Create or revise Dline workflows as concise ordered procedures with parser-valid metadata, stable capability-name references, explicit safety boundaries, and evidence-based verification; do not use it to author skills.
---

# Write a Workflow

Use this skill to create, replace, or revise a workflow that Dline can discover and load with `load_workflow` or inject through the `/workflow:<name>` slash command. Both paths deliver only the file body, so the workflow must be self-contained.

## Workflow vs. Skill

Choose the artifact before writing:

| Workflow | Skill |
| --- | --- |
| An ordered procedure for completing a recognizable operation | Reusable methods, domain expertise, constraints, and best practices |
| Loaded with `load_workflow` | Loaded with `load_skill` |
| Tells the agent what sequence to execute and where to stop | Teaches the agent how to reason and work in a domain |
| Stored as one Markdown workflow file | Stored in a named skill directory with `SKILL.md` |
| Should be short, operational, and outcome-oriented | May be broader and include patterns, examples, and diagnostic guidance |

Do not use this skill to create or revise a skill. If the requested content is primarily reusable knowledge rather than an ordered operation, stop and recommend skill authoring instead. Do not create a `SKILL.md` file from this procedure.

## 1. Confirm the Workflow Contract

Before editing, define:

- the operation and observable result;
- when the workflow should be loaded;
- required inputs and how they are discovered;
- preconditions and explicit stop conditions;
- ordered steps and dependencies;
- local and external side effects;
- authorization boundaries;
- verification and final reporting;
- behavior that belongs in an existing rule or skill instead.

A workflow should have one coherent operational goal. Do not combine unrelated procedures merely because they share tools.

## 2. Inspect Existing Capabilities

Search existing workflow names and descriptions before adding a new file. Reuse or revise an existing workflow when its operation and safety contract match.

Reference capabilities by stable name. Rules are injected automatically, so reference them by name ("Follow repository-and-release"); load skills with `load_skill` and workflows with `load_workflow`. Do not embed their directory path or filename in prose.

New project workflows belong in `.agents/workflows/`. Global workflows live in the Dline documents root and legacy `.clinerules/workflows/` is still scanned, but when names collide the first discovered wins (workspace before global before remote), so a same-named global or legacy workflow is shadowed.

Avoid duplicate redirect workflows. When an old workflow has been fully replaced and no compatibility consumer requires its name, remove it instead of advertising a deprecated stub.

## 3. Create Parser-Valid Metadata

Create the workflow as `.agents/workflows/<workflow-name>.md` with leading YAML frontmatter. Do not use `.mdx`: `load_workflow` reads it, but `/workflow:<name>` derives the command name by stripping only `.md` or `.txt`, so an `.mdx` workflow cannot be invoked from the slash menu.

```yaml
---
name: stable-workflow-name
description: One concise sentence explaining when and why to load this workflow.
---
```

Requirements:

- `name` uses lowercase kebab-case and equals the file name without its extension; `load_workflow` and the slash menu show `name`, but `/workflow:<name>` matches the file name, so a mismatch advertises a name that cannot be invoked;
- `description` is non-empty, specific, and operational, one line under 240 characters (the catalog collapses whitespace and cuts at 240), with the trigger condition in the first 80 characters (the slash menu shows only those);
- frontmatter starts at the first byte of the file (no BOM) and has a closing `---` block;
- metadata parses with `parseYamlFrontmatter` (js-yaml `JSON_SCHEMA`), the parser Dline uses;
- the visible title may be human-friendly but must not redefine the stable name.

The runtime can fall back to a filename or empty description, but workflow authors must not rely on those fallbacks.

## 4. Write the Ordered Procedure

Use a small structure such as:

```markdown
# Human-Readable Title

One sentence describing the result.

## Preconditions

## 1. Discover inputs

## 2. Validate state

## 3. Perform the operation

## 4. Verify the result

## 5. Report
```

Each step should state:

- what evidence to read;
- what decision is made from that evidence;
- what action is allowed;
- when to stop;
- what result is passed to the next step.

Use placeholders such as `<repository>`, `<remote>`, `<base-ref>`, and `<target-version>` when values must be discovered. Explain the discovery source; never substitute a maintainer-specific repository, remote alias, URL, personal branch, or machine path.

## 5. Keep Safety and Authorization Explicit

Separate:

- read-only discovery;
- ordinary project-file edits;
- local Git writes;
- remote writes;
- review, merge, deployment, publication, messages, and other external writes.

Do not infer one authorization from another. A workflow may describe an operation that requires authorization, but it must stop before the side effect unless the current user instruction already grants that exact operation and scope.

Commands must be shell-neutral where possible. When shell-specific syntax is necessary, label the shell. Do not use repository-local temporary files, hidden fallback branches, guessed remotes, or destructive cleanup to make the procedure appear successful.

For Git, pull-request, or release workflows, follow the authoring and minimum-verification sections of repository-and-release, including failing when a base cannot be determined instead of falling back to `HEAD`.

## 6. Reference Capabilities by Name

Cross-capability references must use stable names only:

```text
Follow repository-and-release.
Load create-pull-request when an ordinary PR is requested.
Load use-vitest for full-suite Vitest execution.
```

Do not write capability paths such as `.agents/rules/...`, `.agents/workflows/...`, or `.agents/skills/.../SKILL.md`. Names survive directory and extension changes; paths become stale implementation details.

## 7. Keep Workflow and Product Documentation Separate

A workflow is internal execution guidance, not user documentation or a project architecture specification.

- Put stable engineering contracts in rules.
- Put reusable methods and domain expertise in skills.
- Put user or developer documentation in the project documentation set.
- Put one ordered operational procedure in a workflow.

If the procedure needs extensive conceptual teaching before the steps make sense, move that knowledge to a skill and have the workflow load it by name.

## 8. Validate the Workflow

Before completion:

1. confirm the frontmatter parses with `parseYamlFrontmatter` and that `name` equals the file name;
2. confirm the name and description appear in the Workflows capability catalog;
3. confirm `load_workflow` with the exact name returns the workflow and `/workflow:<name>` expands it;
4. scan for stale capability paths, hard-coded repositories/remotes/URLs, obsolete commands, and cross-platform shell assumptions;
5. verify every referenced command against `package.json` and every project path against current source;
6. test important stop conditions and unsafe counterexamples when the workflow controls Git, release, migration, deletion, or publication behavior;
7. remove a superseded workflow when retaining it would create a duplicate catalog entry.

There is no automated static-contract check for workflow Markdown, and `npm run format` (Biome) does not validate it; the checks above are manual.

## Completion Checklist

- [ ] The artifact is truly an ordered workflow, not a skill or rule.
- [ ] Frontmatter has a stable kebab-case `name` equal to the file name and a non-empty one-line `description`.
- [ ] Inputs, preconditions, steps, stop conditions, verification, and reporting are explicit.
- [ ] Side effects and authorization boundaries are separated.
- [ ] Cross-capability references use names, not paths.
- [ ] Commands are current, fork-safe where relevant, and shell-neutral or labeled.
- [ ] No deprecated duplicate workflow remains advertised.
- [ ] Parser, catalog, `load_workflow`, slash-command, and focused behavior checks pass.
