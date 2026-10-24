# TASK-11401 Plan

## Approach

先冻结 exact mode grammar、target-only filesystem boundary 和报告语义，使后续 code facts/conformance 只在 admitted WS 中运行。`--scope all` 是交付入口，focused scopes 只用于诊断。

## Architecture Design

```mermaid
flowchart LR
    %% id: TASK11401-opt-in
    %% layer: L5
    %% kind: flow
    %% refines: WS114-L5-delivery
    %% answers: opt-in admission and finding policy delivery
    %% concept: OptIn = Workstream Architecture Admission
    %% local-only: Ready
    OptIn[Opt-in admission and finding policy] -->|hands stable admission verdict and aggregate scope| Ready[Admission policy ready]
```

## Execution Baseline

- Workstream contract: `WS114-A5`
- Task diagram: `TASK11401-opt-in`
- Diagram verification: workstream、task:TASK-11401、cross-task exit `0` on 2026-10-23
- Write boundaries: `goals.yaml#owns`
- Required verification: `VER-TASK-11401-ADMISSION`、`REPORT`、`SCOPE`、`AGGREGATE`
- Upstream: none

## Node Ledger

| Node | Artifact | Writer | State | Owning section |
|---|---|---|---|---|
| OptIn | `ws-model.mjs` / `invocation.mjs` / `report.mjs` | admission/report owner | complete | mode parse, target-only orchestration, verdict |
| Ready | `verify-diagrams.mjs` | none | complete | thin Skill-local CLI dispatch and output |

## Edge Ledger

| Edge | Style | Emit side | Receive side | Proof |
|---|---|---|---|---|
| OptIn --> Ready `hands stable admission verdict and aggregate scope` | solid | admission result and aggregate summary | CLI renderer and process exit | `VER-TASK-11401-ADMISSION`, `REPORT`, `SCOPE`, `AGGREGATE` |

## Architecture Evidence

```yaml
architecture_evidence:
  schema_version: 2
  diagram_id: TASK11401-opt-in
  nodes:
    OptIn:
      artifacts:
        - {id: optin-mode-declaration, role: declaration, path: .agents/skills/verify-architecture-diagrams/scripts/lib/ws-model.mjs, symbol: readArchitectureMode, expectation: present}
        - {id: optin-scope-assembly, role: assembly, path: .agents/skills/verify-architecture-diagrams/scripts/lib/invocation.mjs, symbol: scopeSequence, expectation: present}
        - {id: optin-verdict-writer, role: writer, path: .agents/skills/verify-architecture-diagrams/scripts/lib/report.mjs, symbol: computeVerdict, expectation: present}
        - {id: optin-scope-emitter, role: emitter, path: .agents/skills/verify-architecture-diagrams/scripts/lib/invocation.mjs, symbol: scopeSequence, expectation: present}
    Ready:
      artifacts:
        - {id: ready-cli-assembly, role: assembly, path: .agents/skills/verify-architecture-diagrams/scripts/verify-diagrams.mjs, symbol: main, expectation: present}
        - {id: ready-cli-receiver, role: receiver, path: .agents/skills/verify-architecture-diagrams/scripts/verify-diagrams.mjs, symbol: main, expectation: present}
  edges:
    - id: TASK11401-opt-in/OptIn/hands/Ready
      from: OptIn
      to: Ready
      style: solid
      label: hands stable admission verdict and aggregate scope
      kind: composition
      emit: {node: OptIn, artifact: optin-scope-emitter}
      receive: {node: Ready, artifact: ready-cli-receiver}
      proof: [VER-TASK-11401-ADMISSION, VER-TASK-11401-REPORT, VER-TASK-11401-SCOPE, VER-TASK-11401-AGGREGATE]
```

## Steps

1. 按 spec grammar 解析唯一、位置固定的 `Architecture-Mode` 行，忽略 fence/quote/inline code。
2. 在 Mermaid、Task、root projection、自检或源码读取前执行 admission short circuit。
3. 删除 verifier 对 root `status.yml` 的读取；使用 filesystem tripwire 验证 target-only boundary。
4. 增加 Warning、Not applicable 和正交 verdict，保持 text/JSON 稳定排序。
5. 新增 `scope all`，一次加载后执行 Workstream、全部 Task、cross-task 与 conformance并去重。
6. 固定 0/1/2 exit，不把 incomplete/not_applicable 表述为 clean verified。

## Verification

- `VER-TASK-11401-ADMISSION`：mode grammar fixture matrix。
- `VER-TASK-11401-REPORT`：finding/verdict text/JSON 与 exit assertions。
- `VER-TASK-11401-SCOPE`：root/sibling read tripwire。
- `VER-TASK-11401-AGGREGATE`：all scope completeness、dedupe 与 single summary。

## Risks

- 不能把旧 spec 自然语言或 Mermaid 自动推断为 opt-in。
- root status 的 stale projection 不是架构结论，移除后仍由 Memory 协调流程维护。
