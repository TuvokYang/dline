# WS-114 Implementation Plan

## Architecture

WS-114 只服务显式 opt-in 的单个当前 Workstream。admission 在任何图、Task、root projection 或源码读取前决定 `not_applicable|admitted|unsupported|tooling_error`。admitted invocation 通过 Skill-local vendored Tree-sitter、bounded closure、Proto source 与显式 generated provenance 形成 immutable snapshots；不读取目标 package/tsconfig 或产品源码。

## Contract References

- `WS-114/AC-01`～`WS-114/AC-18`。
- `designing-workstream-diagrams`：L0–L5、concept identity、authority 与 Task slicing。
- `verify-architecture-diagrams`：现有 Stage 0–6、finding attribution 与 exit code 基线。
- `.agents/skills/verify-architecture-diagrams/scripts/`：Skill 私有 verifier、scanner 与 hermetic tests，不对产品源码或 CI 暴露依赖。
- 用户确认：图外代码结构与未完成 Task 只 warning；不做跨 WS 或历史 WS 校验。

## Task Graph

| Task | Goal Contract | Depends On | Execution Mode | Integration |
|---|---|---|---|---|
| TASK-11401 | `tasks/TASK-11401-opt-in-report-policy/goals.yaml` | [] | serial | exact opt-in、target-only scope、aggregate invocation、verdict/exit policy |
| TASK-11402 | `tasks/TASK-11402-typescript-code-facts/goals.yaml` | [TASK-11401] | parallel_when_ready | vendored Tree-sitter 多语言 facts、bounded closure、Proto 与 explicit generated provenance |
| TASK-11403 | `tasks/TASK-11403-diagram-code-conformance/goals.yaml` | [TASK-11401, TASK-11402] | serial | artifact/evidence binding、identity、SCC、authority 与 severity checks |
| TASK-11404 | `tasks/TASK-11404-command-tests-adoption/goals.yaml` | [TASK-11403] | serial | Skill 私有 CLI、hermetic fixtures、隔离门禁与 skill/workflow contract |

## Integration Order

1. TASK-11401 固定 mode grammar、非图驱动 skip、target-only filesystem boundary、`--scope all` aggregation、finding/verdict/exit policy。
2. TASK-11402 在 Skill 内 vendoring runtime/grammars/queries/licenses，建立 13-language facts、bounded closure、runtime/type 分类与 SCC，并保持 Proto/generated provider 独立。
3. TASK-11403 扩展 repeatable `%% artifact:` 和 schema-v2 Architecture Evidence；artifact 使用稳定 id，edge endpoint 以 `{node, artifact}` 强绑定 source/target 与角色，并拆分 write boundary、artifact expectation 与 authority claim。schema v1 只保留迁移读取，不能支撑 completed conformant。
4. TASK-11403 统一 Unicode identity、完整 Task SCC、非零跳 Depends On、layer lineage、owned-boundary lattice 与 diagram/code 双向 conformance。
5. TASK-11404 通过 Skill 自身脚本提供 aggregate CLI 与 hermetic suite，并以隔离测试禁止 package、主 CI、产品源码和产品架构测试依赖 Skill。
6. 其它 Workstream marker 不由 WS-114 批量写入；各 WS owner 在自己的变更中 opt-in。

## Verification

- Workstream、四个 Task 与 cross-task diagram verifier。
- Opt-in grammar、missing/unknown/duplicate/misplaced mode、root/sibling read tripwire及 verdict/text/JSON fixtures。
- 13-language facts、TypeScript/Python Stage 6、bounded closure/SCC、Proto/generated 与 copied-Skill non-Node CLI fixtures。
- Conformance mutation fixtures：actual-edge warning、planned expectation warning、completed present/absent mismatch、three-task SCC、zero-hop、Unicode ambiguity、authority claim、owned-boundary lattice和多 artifact proof。
- 现有 `TaskImportGraph.test.ts`、kernel/executor architecture tests 独立通过，且不导入 Skill。
- Skill hermetic Node tests、`npm run check-types` 与目标 Biome lint。
- 隔离断言证明 package、主 CI、产品源码和产品架构测试不依赖 Skill；具体 WS 由 Skill invocation 显式传入。

## Risks

- 设计 edge 不等于 direct import；proof model 必须覆盖合法依赖倒置和 composition。
- 一个概念跨多个 artifact；单路径 module binding 不足，重复 artifact parser 必须先落地。
- import graph 不能证明实际 mutation writer；authority 只能由显式 claim/sink 证明，其他情况保持 not-checked。
- Webview/Proto/generated 使用不同事实源；Skill 私有 provider 必须保持 project/provenance 边界，且不能要求产品测试或 CI 为其提供公共层。
- 自由文本 section/structured selector 不可可靠计算 overlap；默认 warning 而非伪证明。
- 其它 WS 的 opt-in 由其 owner 管理，WS-114 不维护中央 allowlist。
