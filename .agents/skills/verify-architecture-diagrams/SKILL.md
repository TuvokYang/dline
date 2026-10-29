---
name: verify-architecture-diagrams
description: Verify a Workstream or task diagram set top-down for acyclic dependencies, declared layer refinement, task-to-Workstream coverage, cross-task conflicts and recorded implementation gates, reporting blocking, pending, unverifiable, not-checked and tooling findings with a deterministic exit code; use it before implementing against a diagram, and do not use it to author or redesign diagrams.
---

# Verify Architecture Diagrams

Run the verifier, read its five report sections, and act on the finding that owns the defect. Do not repair a lower layer to make an upper-layer finding disappear.

Companion skill: `designing-workstream-diagrams` owns how a diagram set is authored. This skill only decides whether an existing set holds.

## 1. Run it

Only a spec whose first non-empty body line after the H1 is exactly `Architecture-Mode: diagram-driven-v1` is applicable. Missing mode is `not_applicable`; an unknown mode is a warning; duplicated, misplaced or malformed declarations are tooling errors.

```bash
node .agents/skills/verify-architecture-diagrams/scripts/verify-diagrams.mjs \
  --workstream .memory-bank/workstreams/<WS-dir> \
  [--scope all|workstream|task:<TASK-ID>|cross-task|code-conformance] \
  [--json] [--no-self-test]
```

| Option | Meaning |
| --- | --- |
| omitted / `--scope all` | Workstream, every current Task in sorted order, cross-task, then code conformance; one deduplicated report |
| `--scope workstream` | Workstream spec diagrams: parsing, cycles, intra-diagram structure, inter-level refinement |
| `--scope task:<ID>` | one task: its own diagrams, its Workstream mapping, then its recorded implementation gate |
| `--scope cross-task` | the plan's `Depends On` against Workstream reachability, then horizontal comparison across every task diagram |
| `--json` | schema-versioned machine report with coverage, self-test evidence, metrics and findings; exit code is unchanged |
| `--no-self-test` | skip the vendored Tree-sitter mutation self-test; coverage becomes incomplete and the run cannot be `conformant` |

Task diagrams are read from each task's `plan.md` only.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | no blocking, unverifiable or tooling findings |
| `1` | at least one blocking or unverifiable finding |
| `2` | tooling problem; the design verdict is withheld |

`2` outranks `1`: when the verifier itself is unsound, its design conclusion is not evidence.

## 2. Stage order

Stages run top-down. A later stage never compensates for an earlier failure.

```
0  parse            1  cycles (solid edges, by kind)   2  intra-diagram structure
3  B1 L0 -> L5      4  B2 task vs Workstream          5  B3 Depends On and task vs task
6  recorded implementation gate (Tree-sitter)         7  bounded diagram-code conformance
```

## 3. Stage 0: parsing

The parser accepts a declared Mermaid subset: `flowchart`/`graph` with any direction, the standard node shapes, `-->`, `---`, `-.->`, `==>`, `|label|` and inline edge labels, quoted and unquoted node labels, `subgraph`/`end`, `%%` comments and annotations, plus `style`/`classDef`/`class`/`linkStyle`, which are ignored.

A statement outside that subset becomes a **tooling problem**, never a design finding. Report it to the user as a tool defect and extend the parser rather than "fixing" the diagram to match a parser bug.

Annotations the verifier reads:

| Annotation | Effect |
| --- | --- |
| `%% id: <diagram-id>` | stable identity; a duplicate id in one set is blocking; a layered diagram without one is reported once as not checked |
| `%% layer: L<n>` | enables inter-level checks; without it, refinement is unverifiable |
| `%% kind: structure\|flow` | selects the cycle rule; omitted means structure and is reported once as not checked; any other value is blocking |
| `%% refines: <id>[, <id>]` | declares the coarser diagram(s); an unknown id is blocking; without it the pairing is inferred and its findings are reported for review only |
| `%% answers: <question>` | recorded in the report; several lines accumulate; missing is not checked |
| `%% cycle: allowed nodes=A|B owner=<task> reason="<why>"` | exempts exactly the named structure SCC; missing nodes, owner or reason, duplicate node sets, and declarations that match no SCC are blocking |
| `%% module: <node> = <path>` | compatibility shorthand for one declaration/present artifact |
| `%% artifact: <node> role=<role> path=<path> [symbol=<symbol>] [expect=present\|absent\|generated]` | repeatable node artifact; unknown node, role or expectation is reported |
| `%% concept: <node> = <ConceptName>` | gives a node its cross-diagram identity; resolved before id and label |
| `%% local-only: <node>` | exempts a task node from Workstream existence checks |
| `%% note-node: <node>` | excludes a visible constraint node from isolation and graph checks; naming a node the diagram does not draw is blocking |
| `%% ignore: owner=<task> reason=<why>` | skips a diagram; missing owner or reason is itself blocking |
| `%% note: <text>` | prose; never expressed as an edge |

## 4. Stage 1: cycle detection

Two graphs are built from one diagram, and which one must be acyclic depends on the diagram kind.

| Graph | Edges | Cycle allowed |
| --- | --- | --- |
| dependency graph of a `structure` diagram | `-->` solid only | no |
| step graph of a `flow` diagram | `-->` solid only | yes, when every loop has a solid edge leaving it |
| fact and constraint graph | `-.->` dotted only | yes |

- In a structure diagram a solid self-loop or a solid cycle of any length is **blocking**, reported with its full path.
- In a flow diagram a loop with an exit is accepted and counted once as not checked; a loop with no solid edge leaving it is **blocking** (`flow-loop-without-exit`) because the protocol cannot converge.
- Dotted edges are never part of cycle detection. A request/response pair is `A --> B` plus `B -.-> A`; that is the control model, not a defect.
- A genuinely required structure cycle must be declared as `%% cycle: allowed nodes=A|B owner=<task> reason="<why>"`. The sorted node set must exactly equal one detected SCC; one declaration never exempts another SCC. Missing fields, duplicate node sets and unmatched declarations are blocking.
- Note nodes are excluded from both graphs.

## 5. Stage 2: intra-diagram structure

| Rule | Severity |
| --- | --- |
| `subgraph` names an undeclared parent | blocking |
| `subgraph` has no lifetime label | blocking |
| Nodes with no edge at all and not declared `%% note-node:` | blocking, one finding per diagram |
| Solid edge without a label | blocking, one finding per diagram |
| A structure diagram at L0 or L1 whose solid labels use **none** of the declared categories | blocking, one finding per diagram |
| Solid labels that are descriptive while the diagram does use declared categories | not checked |
| Solid labels of a flow diagram or a diagram below L1 | not checked; the declared categories do not bind them |
| Dotted label that is an instruction | blocking |
| Dotted label that is neither a fact nor a constraint | unverifiable |
| Solid edge crossing unrelated lifetimes without commit or write semantics | not checked, for review |

Three decisions are deliberate:

1. **The normative label sentence names meaning categories, not an exhaustive vocabulary.** Requiring every label to be one of five literals rejects ordinary descriptive architecture labels and produces one finding per edge. The verifier instead requires that each diagram actually uses the declared categories, and accepts descriptive labels as detail.
2. **The sentence binds ownership and control composition, which only L0 and L1 structure diagrams express.** A hot-path, failure or delivery diagram describes behaviour and is not held to it.
3. **Lifetime containment is not declared by the spec.** Two subgraphs in one diagram may legitimately nest. Crossing them is therefore a review item rather than a defect.

## 6. Stage 3: B1 inter-level refinement

A finer layer may refine a coarser one. It may not invent authority, scope, direction or style.

Pairing comes from `%% refines:`. When a diagram declares none, the verifier pairs it with the single coarser diagram that overlaps it most and downgrades every `unverifiable` finding of that pair to `not checked`, because a guessed anchor cannot support a blocking verdict. A declared pairing keeps full severity.

| Rule | Severity |
| --- | --- |
| `%% refines:` names an id no layered diagram declares | blocking |
| Fine layer is not finer than its reference | blocking |
| Fine node is neither an id, a normalized label, nor `local-only` | unverifiable |
| Solid fine edge inverts the coarse solid direction | blocking |
| Solid fine edge has no coarse counterpart | unverifiable |
| Coarse solid command drawn as a fine fact edge | blocking |
| Coarse fact edge drawn as a fine command edge | blocking |
| Fine subgraph introduces a lifetime absent from the coarse layer | unverifiable |
| Coarse node never appears below | not checked |
| A layer is skipped | unverifiable |

## 7. Stage 4: B2 task diagram against the Workstream

Attribution rule: **existence defects belong to the Workstream; coverage defects belong to the task.**

| Rule | Attribution |
| --- | --- |
| Task node absent from the Workstream and not `local-only` | task |
| Task draws a solid edge the Workstream does not declare | task |
| Task inverts a Workstream solid direction | task |
| Task subgraph absent from the Workstream and not `local-only` | task |
| Task adds a dotted fact edge | not checked |
| Task solid label outside the declared categories | task |
| `not yet verified` node that names no owning task | unverifiable |

A task diagram that shares no node with any Workstream diagram is unverifiable: it is not anchored to the contract at all.

## 8. Stage 5: B3 Depends On and task against task

The plan's Task Graph is checked first: when B depends on A, a solid path through the merged Workstream diagrams must lead from a node A draws to a node B draws (identity: concept, then normalized label, then id). A dependency the diagrams cannot explain is `unverifiable` (`depends-on-not-explained-by-diagram`); a dependency involving a task with no anchored diagram is counted once as not checked; a cross-Workstream dependency (`WS-xxx/TASK-yyy`) is not judged locally.

| Rule | Severity |
| --- | --- |
| Two tasks draw the same edge in opposite directions | blocking |
| Two tasks both commit to the same node | blocking, split authority |
| Merging the task graphs forms a solid cycle | blocking, the task cut is wrong |
| The same node is drawn with different shapes | unverifiable |
| A task participates while its own gate is postponed | pending |

## 9. Stage 6: recorded implementation gate

The gate decides whether code checking is meaningful. It never invents a defect, because an unfinished task has not claimed implementation.

| Condition | Effect |
| --- | --- |
| `progress.md` `status` is not `completed` | implementation checks postponed |
| `blockers` is not empty | postponed; an honest blocker is not a design defect |
| `waiting_for` is not empty | postponed; coordination is normal |
| a `Depends On` task is not `completed` | postponed |
| a `required_verification` id has no `progress.md` record | postponed |
| a recorded result differs from `required_result` | postponed |

Only a task that passes every condition is code-checked, and then:

| Check | Severity |
| --- | --- |
| `owns[].path` with `kind: module` does not exist | unverifiable |
| `owns[]` with `kind: symbol`: a declaration fact matches | proven; an absent capture is unverifiable, never inferred missing |
| `%% module:` binding points at a missing module | unverifiable |
| A drawn solid edge whose source module never imports the target module | not checked; dependency inversion is the prescribed shape, so the edge is proven by the task's execution ledger (emit side, receive side, breaking test), not by an import |
| `kind: structured_node` / `section` / `line_range` / `whole_file` | checked for path existence only |
| Mutation self-test does not detect a seeded defect | tooling problem, exit code 2 |

Record contradictions are reported with `[record]` attribution and are blocking, because a completed task contradicting its own record cannot be trusted:

- `status: completed` but a required verification is not satisfied;
- `status: completed` with a non-empty `blockers` or `waiting_for`;
- `progress.md` verification naming an id absent from `goals.yaml`.

A stale `status.yml` projection is **not** a defect. `progress.md` is authoritative; the mismatch is listed under stale projections and never changes the exit code.

## 10. Bounded diagram-code conformance

The default aggregate reads only the target Workstream and artifacts bound by `%% artifact:`, `%% module:`, Task `owns|reads`, or schema-v2 `## Architecture Evidence`. From those explicit seeds it builds a bounded dependency closure with vendored Tree-sitter grammars; it needs no target package, tsconfig, Python or product source, and never enumerates sibling or historical Workstreams.

Architecture Evidence is the sole Task-local diagram-to-code fact source. Schema v2 gives every node artifact a Workstream-stable `id`; each edge endpoint is `{node, artifact}` and must resolve to the edge's source/target node and the required role (`emitter`, `receiver`, `declaration` contract or `assembly`). Endpoint-local paths or symbols are rejected so an unrelated file cannot prove an edge. Schema v1 remains readable only for migration and cannot establish completed conformance. Evidence validates exact diagram edge identity and supports `direct_import`, `injected_port`, `composition`, `event`, `callback` and canonical Proto `rpc` proofs. `owns` is write permission, not artifact existence or writer authority.

Completed expectation, direct-runtime contradiction, prohibited runtime SCC, conflicting completed writer claims and computable completed boundary overlaps block. Unfinished expectations warn. Direct import and observable composition wiring may be proven structurally; injected-port, event, callback and RPC prerequisites that do not prove runtime delivery are `unverifiable`. Actual code edges absent from the current WS contract warn; type-only and external-package facts never become runtime writer/cycle blockers.

Identity is shared by every stage: concept, exact id, then NFKC/lowercase Unicode letter-number label. Multiple candidates are ambiguity, never a guess. Depends On requires an artifact-owned upstream node to reach an artifact-owned downstream node through at least one solid edge.

## 11. Node identity

```
1. declared concept match (%% concept: on the fine node, against the coarse node's concept, id or label)
2. exact id match
3. normalized label match (whitespace, case and punctuation removed)
4. otherwise unresolved -> unverifiable
```

Level 1 lets one concept carry different ids and label suffixes across diagrams without being read as several authorities. Level 3 keeps a renamed node from being read as a newly invented authority. Level 4 refuses to guess.

## 12. Report sections

```
Tooling problem   tool defect; design verdict withheld; exit code 2
Blocking          [diagram], [record] or [code] contradiction
Warning           incomplete or diagram-undeclared implementation; exit remains 0
Pending           postponed work with its reason
Unverifiable      an undecidable relation; still blocks
Not checked       skipped checks, exemptions, accepted descriptive labels
Not applicable    exact opt-in marker is absent
```

Rule of thumb when reading: a finding is repaired at the layer that owns it. A `[diagram]` finding in stage 3 or 4 is repaired in the coarser diagram, not in the task.

Verdicts are `conformant | incomplete | not_applicable | failed | tooling_error`. `conformant` additionally requires delivery coverage: `--scope all`, every required scope executed, and the default Skill-local self-test passed. Focused scopes and `--no-self-test` are diagnostic only. Warning, pending and not-checked produce `incomplete` but do not change the 0/1/2 exit code.

## 13. Anti-patterns

| Symptom | Correct response |
| --- | --- |
| relaxing a rule because a real spec trips it many times | check whether the rule models a fact the spec declares; if not, downgrade the rule, not the spec |
| declaring `%% kind: flow` on a dependency diagram to hide a cycle | the kind must match what the edges mean; a module cycle in a "flow" diagram is still a split authority |
| adding `%% concept:` to force two different authorities to resolve as one | a concept is one thing; two writers under one concept is the split authority B3 reports |
| deleting a task diagram to clear stage 6 | the task then has no anchor, which is unverifiable, not clean |
| treating `not checked` or `unverifiable` as a pass | exit code 1 already treats unverifiable as blocking |
| fixing `status.yml` to silence a projection mismatch | `progress.md` is authoritative; repair the projection, never the exit code |
| adding `%% cycle: allowed` to every cycle | an exemption without an owner and a reason is itself blocking |
| running only `--scope task:<ID>` and reporting success | task scope never proves the Workstream contract |
