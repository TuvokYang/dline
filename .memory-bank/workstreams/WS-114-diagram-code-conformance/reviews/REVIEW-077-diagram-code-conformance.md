---
id: REVIEW-077
target: WS-114
conclusion: changes_requested
---

# WS-114 Diagram-Code Architecture Conformance 独立审查

## Scope

只读审查 WS-114 spec、plan、TASK-11401～11404，以及当前 diagram skills/workflows、verifier scripts、TypeScript import graph、package/CI/TS/Webview/Proto 配置。未读取其它 Review 或历史 Workstream 设计结论。

## Sources Read

- `.memory-bank/workstreams/WS-114-diagram-code-conformance/**`
- `.agents/skills/designing-workstream-diagrams/SKILL.md`
- `.agents/skills/verify-architecture-diagrams/SKILL.md`
- `.agents/skills/verify-architecture-diagrams/scripts/**`
- `.agents/workflows/diagram-driven-task.md`
- `.agents/workflows/executing-diagram-task.md`
- `src/core/task/__tests__/architecture/import-graph.ts`
- `package.json`、`tsconfig.json`、`webview-ui/tsconfig.app.json`
- `vitest.backend-projects.ts`、`.github/workflows/test.yml`、`buf.yaml`

## Acceptance Assessment

机械图合同已能表达 opt-in、code facts、conformance 和 integration 顺序，但 A1 中若干关键事实仍依赖自由文本或未声明 parser/provider，不能满足“减少人工核对”的目标。审查结论为 `changes_requested`。

## Findings

1. **B1 — 非 import proof 无机器 schema。** 自由文本 ledger 无稳定 edge id、proof kind 和 emit/receive contract，会形成第二事实源。
2. **B2 — `owns` 混合写权限、artifact expectation 和 canonical writer。** 删除/generated Task 无法表达，会产生 completed missing 误报。
3. **B3 — 一节点多 artifact 没有 parser ownership。** 当前 `%% module:` Map 会覆盖重复 node binding。
4. **B4 — CodeFactSnapshot 缺 root/Webview multi-project、Proto canonical source 与 generated provenance。** clean/generated checkout 可能得出不同结论。
5. **B5 — target-only scope 与当前 root `status.yml` 读取冲突。** verifier 仍越出目标 WS。
6. **B6 — 缺默认 aggregate scope。** 需要人工分别运行 workstream/tasks/cross-task 并汇总。
7. **H1/H2 — mode grammar 与 severity matrix 不完整。** absent/unknown/malformed、diagram/record/code/proof × status × confidence 边界可能漂移。
8. **H3/H4 — actual-edge 范围与 barrel symbol provenance 未定义。** 可能产生全仓 warning 或只停在 barrel。
9. **H5/H6 — import graph 不能证明 writer；boundary selector 没有可计算 lattice。** 存在伪 blocking/伪 clean 风险。
10. **H7/H8 — Task 共享 Integration 节点造成 zero-hop dependency；identity 缺唯一 Unicode 算法。**
11. **H9/H10 — CI 缺独立 tooling command；硬编码其它 WS marker 是第二 allowlist。**
12. **M1～M3 — JS/CommonJS、正交 verdict、unknown node annotation 需明确处理。**

## Conclusion

A1 不应直接实施。应先建立版本化 Architecture Evidence、分离 owns/artifact/authority、定义 CodeFactWorkspace、移除 root status 依赖、增加 scope all，并统一 identity、severity、boundary 和 tooling test contracts。

## Disposition

- **accepted — B1/B2/B3：** A2 新增 schema-v1 Architecture Evidence、repeatable `%% artifact:`、`present|absent|generated` expectation；`owns` 只保留写边界，authority claim 独立。
- **accepted — B4：** CodeFactWorkspace 扩展为 root/Webview TypeScript/JavaScript project、Proto service/method canonical facts 与 generated provenance；不自动运行 generator。
- **accepted — B5/B6：** target-only filesystem tripwire、移除 root status 架构依赖，并新增默认 `--scope all` 聚合报告。
- **accepted — H1/H2/M2：** A2 定义 exact mode grammar、finding classification matrix 与 `conformant|incomplete|not_applicable|failed|tooling_error` verdict。
- **accepted — H3/H4/M1：** actual-edge 仅扫描 current WS artifact-set importers；保留 barrel hop/final declaration provenance并声明 JS/CommonJS 支持边界。
- **accepted — H5/H6：** code writer 承诺收窄到显式 authority claim/sink；whole_file/module/symbol 使用可计算 lattice，其它 selector 只 warning。
- **accepted — H7/H8/M3：** TASK-11403 不再共享 Integration node；Depends On 要求至少一条 edge；新增 canonical Unicode identity module和所有 node-targeted annotation 校验。
- **superseded — H9/H10：** A2 曾把 Skill verifier 接入 package 与主 CI；该处置违反 Skill 生命周期。WS114-A4 已撤销 package/CI/source/test coupling，并在 L0–L5、TASK-11402 与 TASK-11404 的图和 Evidence 中明确 Skill 私有生命周期与产品零依赖；其它 WS marker 仍由各自 owner 管理。
- **verification after disposition：** WS114-A4 的 workstream、TASK-11401～11404、cross-task 与 code conformance aggregate 为 `incomplete`/exit 0，0 tooling、0 blocking、0 unverifiable、0 pending；保留政策允许的 warning/not-checked。
- **review status：** 后续独立复审被用户取消，未产生结果；本 Review 保持 `changes_requested` 历史结论，不伪造 pass。A4 的 Skill 隔离修正由用户直接要求并已重新验证，不把取消的复审改写为 pass。
