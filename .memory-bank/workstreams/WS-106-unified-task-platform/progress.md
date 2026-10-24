---
status: active
completed_ac: []
verification:
  - check: VER-WS-106-CONTRACT
    result: passed
    conclusion: "WS-106 spec、plan、INVEST-119、absorbed Workstream 状态、execution、PK-002/PK-003 与 TASK-10601～TASK-10620 合同已建立；20 个 Task 目录均含 goals/plan/progress，Task Graph、status 投影与 Keystone 引用一致。"
  - check: REVIEW-059
    result: failed
    conclusion: "独立总体架构审查为 changes_requested；H1-H8、M1-M5、L1-L2 已 accepted 并用于重写 identity/ownership/storage/child/approval/plugin/views/skills/cutover 与 DAG。"
  - check: REVIEW-060
    result: failed
    conclusion: "独立 storage/approval/plugin 安全审查为 changes_requested；schema criticality、checkpoint、fencing、manifest、AI aggregate/privacy、effect ledger 与 verification findings 已 accepted。"
  - check: REVIEW-061
    result: failed
    conclusion: "复审发现 delete intent、extension selection、effectful semantic bootstrap、AI escalate、operation fence 与 Task编号六项残留；均已 accepted并修订。"
  - check: REVIEW-062
    result: passed
    conclusion: "最终聚焦复审确认 Task Graph、并行规则与 Integration Order 一致；WS-106 设计可进入精确 Task 合同创建阶段。"
  - check: REVIEW-063
    result: failed
    conclusion: "Task架构初审原为changes_requested；细粒度AC、拆Task与中间wiring-test建议已按用户架构导向纠正，后续以canonical diagrams和独立review约束偏移。"
  - check: REVIEW-064
    result: failed
    conclusion: "总体架构图初审为changes_requested；lifetime、Main/child/AI creation、capability hot path、ExtensionPlatform、persistence、cutover与协议图finding均已accepted并重画。"
  - check: REVIEW-065
    result: failed
    conclusion: "历史独立GPT复审为changes_requested；逐项处置见REVIEW-065 Disposition，其中H3的Ledger/static gate已按用户图驱动决定撤回，其余设计修缮继续以当前图表达。"
  - check: REVIEW-066
    result: passed
    conclusion: "独立reviewer-gpt对当时方案给出pass，无High/Medium blocker；该历史结果不覆盖后续图修缮。Ledger/static gate的后续撤回及结论适用范围见REVIEW-066 Disposition。"
  - check: REVIEW-067
    result: passed
    conclusion: "两路独立审查对当时设计给出pass与主观质量评分；建议合理性、评分局限及用户授权后的图修缮处置见REVIEW-067 Disposition，不把分值或P0建议视为当前验收门禁。"
  - check: REVIEW-067-DOCUMENT-CONSISTENCY
    result: passed
    conclusion: "专用文件读取与搜索已核对spec Goal/AC-25、相关图、plan、TASK-10609/10610/10618/10620及REVIEW-065～067 Disposition：图驱动定位、opening失败安全条件和revision语义一致，新增Ledger/static/P0门禁已撤回，20个Task与DAG保持原分工。本项仅记录执行者文档核对，未运行Mermaid渲染、产品检查或新的独立复审，不新增验收门禁。"
  - check: REVIEW-068
    result: failed
    conclusion: "历史两路独立四维审查均为changes_requested，另有opening状态接续聚焦复核；原发现与后续修缮处置见REVIEW-068，修订后的设计结论见REVIEW-069。本项不表示执行了失败的产品测试。"
  - check: REVIEW-069
    result: passed
    conclusion: "独立reviewer-gpt自总体职责和生命周期向下复核，确认REVIEW-068 H1/H2/M1在设计上关闭，无新增结构性阻塞；两项非阻塞表达建议和执行者后续处理见REVIEW-069 Disposition。Pass不代表产品运行通过，也不自动提供架构修改授权。"
  - check: REVIEW-069-DOCUMENT-CONSISTENCY
    result: passed
    conclusion: "用户随后指示审查检查后做修改；本轮据此核对并澄清资源drain命令归属和root claim/child location表达，回读对应图边、相关Task合同与治理流程一致。未新增Task/AC/VER/门禁，未运行Mermaid渲染或产品检查；后续架构修正仍独立审查并由用户确认。"
  - check: REVIEW-070
    result: passed
    conclusion: "两路独立reviewer-gpt对当时总体图向下审查并给出设计pass，无新结构性finding；原始四维评分与建议保留在REVIEW-070。该评估阶段未修改架构或执行产品验证；后续用户授权改图的处置见其Disposition与REVIEW-071，不将评分转为验收门禁。"
  - check: REVIEW-071
    result: passed
    conclusion: "用户授权按REVIEW-070建议修改六张既有图后，独立GPT自上而下复核为设计pass，无新增结构性finding、authority或验收门禁。复核后的未发布失败恢复标签澄清单独记录于REVIEW-071 Disposition；未重新评分或运行产品验证。"
  - check: REVIEW-072
    result: passed
    conclusion: "用户要求修订后再次四项审查，两路新独立GPT均对当前完整设计给出pass，无当前结构性finding；各自四维分数、依据、非阻塞建议与实现敏感点保留于REVIEW-072。未读历史Review或继承旧评分，本轮未改架构或运行产品验证，主观分差不表示实测质量趋势。"
  - check: REVIEW-073
    result: failed
    conclusion: "该轮两路独立GPT四项对抗审查均为changes_requested，原反例与评分保留于REVIEW-073；用户后续继续调整的授权及设计处置见其Disposition。该历史结果不改写，本轮仅评分不产生新的pass/changes_requested结论，也不表示运行过产品测试。"
  - check: INVEST-121-PROVIDER-ADMISSION-CAPABILITY
    result: passed
    conclusion: "运行时代码与双 extension-host 日志证明 2.3～9.7 秒 local preparation 普通尖峰主要由同一 provider generation 的重复 rules/workflows/skills/subagents discovery/content hashing 在资源争用下放大；WS-106 已新增 TaskCapabilitySnapshot/single-flight invalidation、provider-admission fairness、分段 timing 与 AC-27。"
  - check: INVEST-122-WORKSPACE-WATCHER
    result: passed
    conclusion: "调查时registry已有process sharing、subscriber fanout、exact-path refs与shutdown dispose，观察到单cwd key、零subscriber无限warm及barrier/recovery/resource budget缺口；这些是相邻修复前的历史证据，不代替当前实现核对。终态logical topology/physical pool、scoped overlay、barrier/ack、full fence与bounded recovery已写入设计。"
  - check: INVEST-122-WATCHER-REREVIEW
    result: passed
    conclusion: "独立复审第一轮 B1～B5/H1～H4 均已 accepted并修订；第二轮结论为 pass with remaining implementation decisions，无不可实施、双authority、DAG循环、owner缺失或不可判定验收 blocker。"
  - check: VER-WS-106-DIAGRAMS-2026-10-18
    result: passed
    conclusion: "对2026-10-18 22:53版spec运行verify-diagrams --scope workstream：37张图，exit 0，0 blocking/unverifiable/tooling，变异自检通过；not-checked含53条跨lifetime边、粗层节点未细化与Task Graph缺失。仅为结构机械结论，不证明语义正确。"
  - check: REVIEW-074
    result: failed
    conclusion: "Task拆分前的两路独立审查（GPT/Opus）均为changes_requested：combined checkpoint顺序、同host facade唯一性无owner、executor写journal路径未定义、self-healing数据失败升级路径、extension binding resolver第二producer共5项；执行者已逐项核对属实，处置见REVIEW-074 Disposition。"
  - check: VER-WS-106-BASELINE-2026-10-18
    result: passed
    conclusion: "只读git核对：当前checkout为dev，HEAD a502880906ee66ca898efbfe6a9c87b920c5c7a7，git status --short为空（工作树干净）。"
  - check: VER-WS-106-DIAGRAMS-2026-10-19
    result: passed
    conclusion: "用户2026-10-19确认REVIEW-074“全部修正，按你的来”；按Disposition修订L4-checkpoint-recovery、L0-ownership、L1-creation-control-projection、L0-persistence-authority、L2-runtime-core、L4-self-healing、L0-extension-authority及相关正文，并把DPTL交付纳入WS-106（spec §Prompt、AC-15、plan）。verify-diagrams --scope workstream exit 0，0 blocking/unverifiable/tooling，变异自检通过；独立复审尚未进行。"
  - check: REVIEW-075
    result: passed
    conclusion: "REVIEW-074修正后的三轮隔离复审（opus+gpt，随后opus复核）：5项原阻塞与DPTL纳入均确认修正；复审新发现N1 facade handle权限、N2 work级委托撤销、N3 lock-loss窗口均已accepted并落实，最终pass。verify-diagrams --scope workstream exit 0。"
  - check: VER-WS-106-TASK-DIAGRAMS-2026-10-19
    result: passed
    conclusion: "TASK-10621～10639合同与plan Task Graph已建立（19个Task，status.yml投影planned）。verify-diagrams逐个--scope task:TASK-10621～10639均exit 0（仅planned导致的ast-postponed pending）；--scope workstream exit 0；--scope cross-task exit 0，变异自检通过。校验器修正四处误判：checks-interlevel resolveNode同id同concept优先（ParentInbox误解析为ChildJournal）、checks-b3仅以solid边判方向冲突（命令/事实回报对不算冲突）、split-authority只认命令动词且同一writer跨Task不算分裂、bare节点按Mermaid默认视为rect；tmp/verify-b3-mutation-check.mjs 7例确认真冲突仍被报告。仅为结构机械结论，不证明语义正确。"
  - check: VER-WS-106-PRESENTATION-PARITY-CONTRACT
    result: passed
    conclusion: "用户追问错误卡片等细节是否回归后，核对spec只有“已完成行为必须保留”总原则、未逐项列出呈现合同；已在TASK-10624/10631/10638合同新增PRESENTATION-PARITY/PARITY验证（api_req_failed/error_retry/api_req_retried、mistake_limit、resume、completion及combineErrorRetryMessages、InteractionRegistry、ErrorRenderer、InteractionHost、ChatRow.auto-retry测试断言不改）。未新增WS级AC，未运行产品测试。"
  - check: REVIEW-UR16-2026-10-19
    result: failed
    conclusion: "UR-16/PF合同初稿经两路隔离复审（reviewer-gpt、reviewer-opus）均为changes_requested：卡片字段与额度/消费上限数据缺失、finalizer不可强制、执行器非终态重试语义遗漏、codec生产者/消费者依赖倒置、工具呈现第二表、后端kind生产者无owner、BD-3/BD-4事实描述不准、旧失败路径未纳入切换清单。已全部accepted并修订。"
  - check: REVIEW-UR16-R2-2026-10-19
    result: failed
    conclusion: "第二轮隔离复审（reviewer-gpt、reviewer-opus）均为changes_requested：BD待定与PF/VER无条件要求矛盾、compaction重试循环与kernel/行writer/withRetry提取无owner、准备阶段失败归类不清、窗口增量投影语义缺失、跨层VER不足、可信链接过滤未列BD、Profile撤回/手动接管/superseded隐藏/倒计时页脚遗漏、工具呈现需按variant作键、旧行升级不应在Webview、策略需按role×operation、owns重叠。除“10624改依赖合同里程碑”外全部accepted并修订；另自查发现combineApiRequests/combineCommandSequences被checkpoint、usage、environment投影共用，改为抽取共用规则函数。用户要求此后不再调用reviewer-gpt。"
  - check: REVIEW-UR16-R3-2026-10-19
    result: failed
    conclusion: "第三轮隔离复审（reviewer-opus、reviewer-opus5）均为changes_requested、无blocking：BD-3 compaction列与Dify/OpenRouter/SAP文本status不符、BD-1实为Anthropic SDK形态规则、Profile撤回应覆盖所有profile_failure与最近error_retry行、默认解释器顺序应额度先于status区间auth、充值回调按Dline站点origin、登录条件需完整Auth规则、parseApiErrorDetails整体迁移、eligibility需基于kind/status/statusSource谓词、compaction自动/手动与subagent行为需策略字段、切换前原地修改生产组件与kernel违反WS-106切换原则且10638无法运行旧路径。已全部accepted：新增PF-8迁移顺序与golden基线、BD表加受影响Task/VER列、10626→10624显式依赖、唯一失败呈现编码器、shared声明kind表、ToolCatalog声明旧tool kind、投影尾部事实/分组id/hooksEnabled。修订后verify-diagrams workstream（含自检）、task:10624/10626/10631/10635/10638/10640/10641与cross-task均exit 0。修订版尚未再复审。"
  - check: REVIEW-UR16-R4-2026-10-19
    result: failed
    conclusion: "第三轮修订后的聚焦复审（reviewer-opus）为changes_requested、无blocking，确认第三轮10项中1/3/6/7/10已修正。余下问题全部accepted并修订：默认解释器顺序改为按今日getErrorType与status区间（402不判balance、quota与非status auth信号定位）；登录提示改为独立signInPrompt字段，profile_change严格等于isRejectedCredentialError；explorationRuns路径更正为chat-view/utils；MAPPINGS静态检查限于新模块与本Task文件，残留旧检查列入10638移除；BD表受影响列精确到子步骤与取值；eligibility措辞统一为谓词；runInternalCompactionPass改为只读依赖；撤回规则按今日只看primary dialog；回调沿用app.dline.bot子串规则；10626工具呈现VER对照未改动组件。修订后verify-diagrams workstream、相关task与cross-task均exit 0，YAML解析8/8通过。修订版未再复审。"
  - check: REVIEW-UR16-R5-2026-10-19
    result: failed
    conclusion: "用户于2026-10-19采纳BD-1～BD-6后，reviewer-opus聚焦复审为changes_requested，6项全部accepted并修订：PF-2默认判定顺序只把402～428放在文本规则前，其余status移到rate-limit文本之后，并写明各步status查找深度、文本status不参与kind判定；Profile撤回措辞统一为当前primary待决交互加最近一条error_retry行（10624/10631/10641）；充值回调按app.dline.bot子串规则（10641）；10624的RETRY-OWNER纳入已采纳BD-3；10631旧tool kind来自ToolCatalog variant声明；补全被截断的PF-8 golden条目，写明BD-1收窄规则（CONTEXT_ERROR_PATTERNS证据），10638对runInternalCompactionPass改为只读引用。同日用户报告只剩Retry/Start New Task、错误卡片不显示，据此在PF-5、PF-8与AC-30新增失败卡片与失败动作同源不变量，golden基线不固化该缺陷，10624/10631/10640/10641的VER同步，BUGFIX-208记录该报告。修订后verify-diagrams workstream（含自检）、task:10624/10631/10638/10640/10641与cross-task均exit 0，YAML解析8/8通过。R5修订与同源不变量未再送独立复审。"
  - check: VER-WS-106-DIAGRAM-DRIVEN-V1-2026-10-24
    result: passed
    conclusion: "WS-106 已精确启用 Architecture-Mode: diagram-driven-v1；新增 L5 Task delivery DAG，TASK-10621～TASK-10641 均具 schema-v2 Architecture Evidence。默认 --scope all aggregate process exit 0、coverage complete、self-test passed、0 tooling、0 blocking、0 unverifiable；verdict incomplete，因21个Task仍为planned，保留209 warning、42 pending与2293 not-checked。Skill-local Node suite 51/51 passed。"
blockers: []
risks:
  - "统一改造横跨Runtime、持久化、视图、Provider与Webview多层，回归面大；按Task Graph与PF-8迁移顺序推进，旧路径在TASK-10638前持续服务生产。（本条原文曾被编辑截断，按现有合同重写）"
  - "“有失败动作而无失败卡片”在当前生产路径（0.11.0-b78b54d00）仍可复现，根因未确认；旧路径修复由BUGFIX-208负责，WS-106新路径以PF-5同源不变量和独立断言防止重现，golden中相应场景标注为已知缺陷。"
  - "BUGFIX-210的最新progress记录共享catalog修复完成；本轮未重新验证其最终代码。Review中cwd key、live StateManager与watcher路径是读取时观察，不代表当前缺陷。后续Task从稳定基线复读并原地演进共享catalog，不另建平行authority。"
  - "WorkspaceCapabilityCatalog key若遗漏ordered roots、remote source revisions、source policy或watch plan会错误跨workspace复用；Task view若遗漏configuration/toggle revision会复用过期prompt facts，不能用TTL或每轮重扫兜底。"
  - "External settings若通过多条manual flush或live read传播，可能乱序或漏失效；当前图以revisioned TaskConfigurationFeed集中传递，并保留独立撤权fence。"
  - "Watcher的multi-root、资源回收与degraded recovery仍属于终态设计关注点；INVEST-122记录的旧代码观察在相邻修复后重新核对，不直接据其断言当前缺陷。"
  - "用户已取消 branch/worktree 路线；此前仅限 worktree 的 Git 写入/提交授权不扩展到当前 checkout。历史 Task 已按用户决策退出兼容与迁移范围。"
next_action: "PF-1～PF-8与BD-1～BD-6已定稿（R5修订后，含失败卡片与失败动作同源不变量）。Task实施以TASK-10621/10626/10640为起点（lane A/B/C最多3路并行），10625由最先空出的lane承接；TASK-10640 Step 1先采集golden基线，并标注“有动作无卡片”已知缺陷场景；10635/10636/10637的plan Step 1是实施前补细化图门禁。"
keystones: [PK-002, PK-003]
---

# Workstream Progress

## Current Milestone

WS-106 已完成统一范围调查与第一版终态合同：

- `INVEST-119` 确认吸收 WS-075、WS-090、WS-091、WS-093、WS-096、WS-097、WS-099、WS-101；
- spec 已定义 TaskProcess、TaskLoop、TaskOperationCoordinator、TaskIncarnation、现有 TaskRuntime microkernel、TaskInstanceFactory、统一 Main/child Task、bounded repositories/read model、hierarchical skills 与 AI approval；
- DPTL 已设计为独立 `src/core/prompts/dptl` module，WS-106 只通过 TaskPromptBindingAdapter 消费 ResolvedPromptContract；Subagent/AI approval 不保留字符串 Prompt 拼装器；
- ExtensionPlatform 的 discovery/manifest/catalog/enablement/grant/activation/typed registry/snapshot/invocation/revoke/quarantine/audit 模块与运行流已写入 spec；
- spec已加入完整模块架构图、open/control/recovery/child/approval流程、唯一TaskOpeningCoordinator、External Settings→TaskConfigurationFeed图与每个TASK-106xx的architecture calibration循环；
- capability终态由source owners → 唯一process-owned per-workspace WorkspaceCapabilityCatalog → opening-bound TaskCapabilitySnapshot表达；后续基于BUGFIX-210稳定产物演进，source复用与Task scope/permission投影分开，不建立平行catalog；
- openingGeneration、configurationRevision、capabilityRevision、promptRevision与ProviderRoundIdentity已分离；Artifact进入TaskExtensionSnapshot，UI进入HostUiExtensionSnapshot；Third-party Provider固定credential reference与shared observed transport；
- spec Goal、AC-25与plan入口已统一为图驱动；Ledger/static门禁和本轮review附加的量化P0门禁已撤回，Task数量、DAG及10618组合／10619切换／10620最终运行验证的分工不变；
- `INVEST-122`已补齐workspace watcher终态：canonical multi-root identity、one physical watcher/key、watch-before-scan、full revision fence、bounded warm-idle/overflow、EPERM/ENOSPC recovery与resource budgets；
- REVIEW-066～073保留各自原始结论、分数及Disposition；本轮由主执行者按用户继续调整要求完成跨域协议修改与自检，后续仅收集独立四项分数，不再让子代理提出修改或据返回结果改图，不将评分当作新的独立通过结论；
- 本轮修缮通过Provider结果、Catalog projection、External Settings、Work/resource图表达热路径、scope、安全传播与资源回收；步骤、类型和调度实现仍可随现场证据演进；
- 当前 SubagentRunner replacement 与首版 `useForApproval`/`aiApprovalEnabled` AI 审批器已进入同一终态平台范围；
- 用户已决定历史 Task 不再做 schema/feature 兼容迁移：未知字段和 retired optional feature 被忽略，核心合同缺失时显示 legacy-unsupported 而不 resume。

REVIEW-068后的生命周期/跨opening修订已取得REVIEW-069独立设计pass，并按用户随后“审查检查后做修改”的本轮指令落实；Spec、plan及相关Task保持同一自上而下关系，两项非阻塞图示已核对并澄清。用户明确的架构确认原则也适用于当前任务：后续新架构修正不因本次指令而获得自主决定权限。本轮没有修改产品代码、并行Bugfix或共享status，也未运行产品类型检查、测试、E2E或Mermaid渲染。TASK-10601仍因稳定产品基线未确认而blocked，不把设计完成写成产品完成。

四维评估由两个隔离上下文的reviewer-gpt完成并归档REVIEW-070；用户随后明确要求“根据审查意见重新修改架构设计图”。该轮已修订spec六张既有图及必要说明、同步plan入口，并取得REVIEW-071新的独立GPT设计pass。复核后仅按其建议补清未发布replacement失败的恢复标签，具体处置与审查边界见REVIEW-070/071 Disposition。Task合同、产品、共享status与既有产品基线blocker保持不变；REVIEW-070评分对应修订前版本，该改图阶段没有重新评分、扩大架构授权或增加验收门禁。

REVIEW-072后的修改经REVIEW-073对抗审查未通过；该阶段的反例、原分数和责任归属均保留。用户随后要求重新调整、完成后再评分，禁止子代理访问历史评分文件，并明确不得在评分后修改设计。主执行者已据此在既有owner内完成删除准入/集合封闭、无排他占用的审批等待、当前Runtime恢复执行资格与新审批generation、控制/工作就绪分离、selection pending/effective收敛；相关TASK-10602/05/07/08/09/10/11/12/13/16/17计划已同步，具体处置见REVIEW-073 Disposition。自检纠正无source视图绕过Task adoption的图边，保留同一opening/target fence；没有新增Task、AC/VER或产品改动。

评分输入限定为当前spec与plan正文，不提供历史分数或结论；子代理禁止读/搜索reviews、progress、status、investigations、evidence以及其它文件。评分前完成全部设计编辑，返回后只记录分数和交付，不解释为验收通过，也不据此再改方案。未运行产品测试、性能测试或Mermaid渲染；既有产品基线blocker保持不变。

## Integration Status

- **Completed baselines:** WS-051、WS-056、WS-087、WS-104 的已验证行为作为实现输入和回归 oracle；
- **Independent authorities:** WS-041 Semantic Input、WS-105 plugin control-plane draft 保持独立，WS-106 交付稳定消费 port；
- **Absorbed work:** WS-075、090、091、093、096、097、099、101 已 archived/superseded，由 WS-106 继续其未交付行为；WS-086 的DPTL交付按用户2026-10-18决定并入WS-106，其spec保留为语言与compiler规范合同；
- **Downstream:** WS-089、092、102、103 以及未来插件实施将改为消费 WS-106 最终平台；
- **Project projection:** absorbed Workstream、旧 Task、`status.yml`、`execution.md`、PK-002 与 PK-003 已收敛到 WS-106；
- **Review:** REVIEW-059～073的独立正文与原分数保持不变；后续设计处置由执行者在Disposition记录。本轮按用户要求只做修改完成后的四项独立评分，不生成新的pass/changes_requested复审结论，产品运行验证仍未执行。
