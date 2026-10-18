---
name: diagram-driven-task
description: Advance one Workstream task from diagram-first design through layered diagram verification and confirmed architecture correction before implementation.
---

# Diagram-Driven Task

Run one task through the diagram contract instead of starting from code. The diagram decides what may be built; verification decides whether the diagram is trustworthy; the user decides whether an architecture change happens.

Load the capabilities when this workflow reaches them: `designing-workstream-diagrams` at step 3, `verify-architecture-diagrams` at step 4, `executing-diagram-task` at step 7.

This workflow owns design, verification, confirmation and reporting. It does not own implementation mechanics: step 7 delegates to `executing-diagram-task`.

## Preconditions

- The Workstream spec exists and has its diagram set under `.memory-bank/workstreams/<WS>/spec.md`.
- The task has `goals.yaml` (with `owns` and `required_verification`) and `progress.md`.
- Read the real code the task owns before drawing. A diagram describes verified code or an approved design, never an assumption.
- Stop if the task's `blockers` names a dependency the user has not resolved; a postponed implementation gate cannot be advanced by editing diagrams.
- A non-empty `waiting_for` does not stop the task: it fences only the regions it names. Design, verification and work in other owned regions continue, as the memory collision protocol defines.
- A Workstream spec written before the diagram contract has unannotated diagrams. Bring it in through `designing-workstream-diagrams` §7a first; until then the verifier's exit code is an inventory, not a verdict.

## 1. Read the contract and the gate

Read the Workstream spec diagrams, the task `goals.yaml`, the task `progress.md` frontmatter, the Workstream plan's Task Graph row for this task, and the modules the task owns.

Report which layer (L0–L5) the task refines and which canonical authority it adds or moves. Stop when the task cannot be placed in a layer, because that means the Workstream cut is wrong and must be fixed above this task.

## 2. Establish the current facts

Read the owning implementation, its consumers, and its tests. Record for each node you intend to draw whether it exists today, exists but is not wired, or is proposed.

Do not describe an unwired edge as working. `not yet verified` plus an owning task is the only honest form for work that is not reachable yet.

## 3. Draw the task diagram

Load `designing-workstream-diagrams`. Add or update the task's `## Architecture Design` diagram in the task's `plan.md` (the only file the verifier reads task diagrams from; `progress.md` records state and must not carry the diagram), and annotate it:

- `%% id:`, `%% layer:`, `%% kind:` and `%% refines: <workstream-diagram-id>` so the anchor is declared, not guessed;
- `%% answers:` for the question it refines;
- `%% module:` for every node that maps to a real module;
- `%% concept:` where the task uses a different id than the Workstream for the same thing;
- `%% local-only:` for task-local detail;
- `%% cycle: allowed owner=… reason=…` only for a genuine request/response pair in a structure diagram.

Keep the diagram smaller than the Workstream diagram it refines. A task diagram that restates the whole Workstream proves nothing.

## 4. Verify top-down

Load `verify-architecture-diagrams` and run:

```bash
node .agents/skills/verify-architecture-diagrams/scripts/verify-diagrams.mjs \
  --workstream .memory-bank/workstreams/<WS> --scope task:<TASK-ID>
```

The mutation self-test runs by default; do not pass `--no-self-test` in this workflow.

When the task changes a shared contract, the plan's Task Graph, or several task diagrams, also run `--scope cross-task`.

Read the exit code by what produced it. Blocking findings in a declared pairing or in the task's own diagram are design verdicts. Findings the report marks as inferred (`workstream-reference-inferred`, `refinement-undeclared`) are review items: declare the anchor instead of accepting them.

## 5. Route each finding to its owner

| Finding | Where it is repaired |
| --- | --- |
| `[diagram]` local to this task | back to step 3 |
| `[diagram]` attributed to the Workstream | back to the Workstream diagrams, not this task |
| `[record]` | the task record: either the status or the verification claim is wrong |
| `pending` | nothing; the task is genuinely unfinished and stays that way |
| `unverifiable` | resolve the identity (`%% concept:`), declare the anchor (`%% refines:`), bind the edge, or record the decision needed |
| `depends-on-not-explained-by-diagram` | the Workstream diagram omits an edge or the task cut is wrong; repair in the Workstream, not by editing `Depends On` |
| tooling problem, exit code 2 | report the tool defect to the user and stop; do not read it as a design verdict |

Never clear a Workstream-attributed finding inside the task diagram. That hides the defect instead of fixing it.

## 6. Obtain confirmation for architecture change

If step 5 requires changing an approved Workstream diagram, contract, ownership boundary or acceptance criterion, present the change with its evidence and wait for explicit user confirmation.

A clarification that preserves all observable behavior and every declared interface may proceed. Anything that moves authority, changes a lifecycle, adds a layer scope or edits acceptance criteria requires confirmation.

## 7. Implement inside the confirmed boundary

Load `executing-diagram-task` and follow it. It turns the verified diagram into a node and edge ledger, implements in topological order, and requires proof that both sides of every edge exist.

This workflow keeps only the boundary: implement nothing the verified diagram does not describe, and return to step 3 when implementation reveals a structural fact the diagram does not capture. The ledger, ordering and proof rules belong to `executing-diagram-task`.

## 8. Report the outcome

Report three lists, separately:

- implemented and verified;
- implemented but not wired, with the owning task;
- not verified, with the reason and what would prove it.

Then re-run the task-scope verification and report its exit code unchanged.

## Stop conditions

- The task cannot be placed in a layer.
- The gate is postponed by `blockers` and the user has not resolved it.
- The only regions the task may still write are named in `waiting_for`.
- Verification exits `2`, meaning the tool is unsound.
- A required architecture change is unconfirmed.
- Implementation contradicts the verified diagram.

## Prohibited

- Repairing a Workstream defect inside a task diagram.
- Using a fake adapter, mock composition or temporary adapter to make an unwired edge appear verified.
- Implementing an unconfirmed architecture change.
- Treating `unverifiable`, `not checked` or a `pending` gate as a pass.
- Editing `status.yml` to change what the verification reports; `progress.md` is authoritative.
- Broadening the task's `owns` boundary to absorb a finding owned by another task.
