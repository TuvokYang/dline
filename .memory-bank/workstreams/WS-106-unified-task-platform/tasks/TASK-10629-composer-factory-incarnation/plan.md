# TASK-10629 Plan

## Approach

交付宿主拥有的组合根与实例装配：`TaskProcessComposer`独占写入`TaskFacadeTable`并只在表未命中时组合稳定facade；角色中立的`TaskInstanceFactory`按准备模式产出未发布candidate；`TaskIncarnation`安装私有窄端口。生命周期编排、Slot发布与Snapshot采用属于TASK-10628；Prompt/Provider端口实现属于TASK-10630，本Task只定义Incarnation消费的端口合同。

## Architecture Design

组合根与facade表（细化`L1-creation-control-projection`）：

```mermaid
flowchart TB
    %% id: TASK-10629-composition
    %% layer: L2
    %% kind: structure
    %% refines: L1-creation-control-projection
    %% answers: who composes the one stable facade per Task identity and who may hold which handle
    Controller -->|lookup-or-compose the main stable facade through the single-flight facade table| Composer[TaskProcessComposer\nhost-owned composition root]
    Composer -->|constructs/opens and is sole writer of the live-facade table keyed by taskId bindingRevision creationNonce; issues one owner handle per entry plus delete and attached handles| FacadeTable[TaskFacadeTable\none live facade per key in this host]
    CreatedProcess -.->|correlated closed fact; Composer retires the entry once every handle it issued is disposed| Composer
    Controller -->|owns main facade handle; submits lifecycle intent and disposes only after correlated closed fact| CreatedProcess[TaskProcess]
    CreatedProcess -.->|correlated closed fact after endpoint unpublish| Controller
```

候选装配（细化`L3-task-assembly`中Factory段）：

```mermaid
flowchart TB
    %% id: TASK-10629-task-assembly
    %% layer: L4
    %% kind: flow
    %% refines: L3-task-assembly
    %% concept: MaintenanceWriter = CanonicalWriter
    %% concept: OpeningValues = OpeningSnapshots
    %% concept: Selected = SelectedTools
    %% answers: how the factory prepares one unpublished candidate per mode and finalizes it under the original receipt
    Control[TaskControl] -->|prepare resource shell only after matching enrollment plus lock access or REC writer settlement| Factory[TaskInstanceFactory]
    Factory -->|holds only the exact granted stage during initialization or repair; existing read-only and healthy replacement modes never acquire it| MaintenanceWriter[CanonicalWriterGate]
    Factory -->|choose declared preparation mode| Mode{New binding current recovery or healthy replacement?}
    Mode -->|new instance| Reserve[Binding owner reserves TaskId root and creationNonce\nvalidate root overlap marker and parent admission]
    Mode -->|existing instance| Reconcile[Binding owner resolves committed record\nreserved state reconciles by nonce and marker]
    Reserve -->|valid reservation and lock| CoreStores[RepositoryStage opens journal/state\nrepair only under REC ordering]
    Reconcile -->|current data; retain diagnostics and use REC when needed| CoreStores
    CoreStores -->|new-instance initialization confirmed| Marker[Write matching identity marker]
    Marker -->|same reservation and root admission still valid| CommitBinding[Binding owner commits canonical binding]
    CommitBinding -->|canonical instance root ready| Shell[Factory-owned unpublished candidate shell\nwriter outbox and dispatch held]
    CoreStores -->|existing committed instance ready; no binding rewrite| Shell
    Mode -->|healthy replacement; no repair write| Borrow[Borrow stable handles or read-only prepare\nRP supplies later sealed cut]
    Borrow -->|owned and borrowed receipts recorded| Shell
    Shell -->|lazy handles only; no eager secondary-domain I/O| Lazy[Messages activities metrics views and enabled checkpoint\nactivate only on actual demand]
    Shell -.->|shell-ready fact with captured resolver inputs and original enrollment receipt| Inbox[ControlInbox]
    OpeningValues[OpeningSnapshots] -->|bind the exact adopted tuple into the shell| Shell
    Selected[SelectedToolSet] -->|bind the matching tool identity into the shell| Shell
    Control -->|after matching tuple receipt finalize without re-resolving| Finalize[TaskInstanceFactory finalization under the original receipt]
    Shell -->|matching tuple and owned receipts| Finalize
    Finalize -->|install private narrow ports; execution remains held| Candidate[UnpublishedOpeningCandidate]
    Candidate -.->|candidate-ready fact| Inbox
    Factory -.->|prepare failed settled or maintenance-not-required fact for read-only and healthy replacement modes| Inbox
```

健康替换中的Factory职责（细化`L3-opening-replacement`）：

```mermaid
flowchart LR
    %% id: TASK-10629-opening-replacement
    %% layer: L4
    %% kind: flow
    %% refines: L3-opening-replacement
    %% concept: Control = Control
    %% concept: Prepare = Factory
    %% answers: what the factory prepares, owns and abandons during a replacement
    Control[TaskControl\npure phase table; fence and sealed cut are its state] -->|effects: prepare adopt abandon through the factory port; all I/O inside prepare RP-1| Prepare[Factory prepares candidate resources and bindings]
    Prepare -.->|candidate ready adopted or failed facts as events via ControlInbox| Control
    Prepare -->|unpublished; writer and dispatch disabled; adopt effect later hands it the sealed cut| Candidate[Candidate Runtime]
    Prepare -->|available optional precomputed values; no blocking source demand| Prepared[Prepared immutable domain inputs]
    Control -->|failure while factory still owns receipts; abandon only those resources| Failed[Factory releases untransferred candidate resources]
    Failed -.->|abandoned and settled facts| Control
```

- Owner/write boundary：`src/core/task/composition`、`src/core/task/factory`、`src/core/task/incarnation`（均为新模块）。
- 命令/事实方向：只有Composer写facade表；Factory只在TaskControl下令时准备并以事实回报；发布由OpeningSlot完成。
- 失败/释放：Factory失败只放弃自己持有的receipt；maintenance stage由TaskControl授予与撤销；facade条目在全部handle释放后才退役。

### Delivery Evidence Anchor

```mermaid
flowchart LR
    %% id: TASK-10629-delivery
    %% layer: L5
    %% kind: structure
    %% refines: L5-task-delivery
    %% answers: which code boundary TASK-10629 owns before downstream Tasks may consume it
    %% local-only: T10629Source
    %% artifact: T10629Source role=emitter path=src/core/task/composition symbol=DeliveryContract expect=present
    %% artifact: T10629 role=receiver path=src/core/task/composition symbol=DeliveryBoundary expect=present
    T10629Source[Task-local delivery contract] -->|assembles owned delivery boundary| T10629["TASK-10629 not yet verified\nowner TASK-10629"]
```

## Steps

1. 定义facade key、owner/delete/attached handle类型与生命周期；实现单飞lookup-or-compose与退役规则。
2. 实现Composer注入的命名端口（inbox、kernel、lock、snapshot、checkpoint），只在表未命中时组合稳定facade。
3. 实现Factory四种准备模式、未发布shell、懒句柄与finalize；只在初始化/修复中持有授予的stage。
4. 实现TaskIncarnation与私有窄端口安装合同（Prompt/Provider、domain adapters由下游实现）。
5. 用同一组合路径覆盖main、child、resident蓝图数据差异。
6. 补并发、失败放弃与handle释放测试。

## Architecture Evidence

```yaml
architecture_evidence:
  schema_version: 2
  diagram_id: TASK-10629-delivery
  nodes:
    T10629Source:
      artifacts:
        - id: task10629-delivery-emitter
          role: emitter
          path: src/core/task/composition
          symbol: DeliveryContract
          expectation: present
    T10629:
      artifacts:
        - id: task10629-delivery-receiver
          role: receiver
          path: src/core/task/composition
          symbol: DeliveryBoundary
          expectation: present
  edges:
    - id: task10629-delivery-edge
      from: T10629Source
      to: T10629
      style: solid
      label: assembles owned delivery boundary
      kind: composition
      emit: {node: T10629Source, artifact: task10629-delivery-emitter}
      receive: {node: T10629, artifact: task10629-delivery-receiver}
      proof: [VER-TASK-10629-FACADE]
```

## Verification

- `VER-TASK-10629-FACADE`：`npm run test:run -- src/core/task/composition`，并发lookup-or-compose与乱序dispose，断言facade唯一与退役时机。
- `VER-TASK-10629-FACTORY`：`npm run test:run -- src/core/task/factory`，在临时root中逐模式准备、注入失败，断言磁盘状态、receipt与stage持有。
- `VER-TASK-10629-SHARED`：以三种蓝图数据组合，断言使用同一Factory/Runtime/repository实现。
- 改动文件运行`npx biome check`与`npm run check-types`。

## Risks

- facade表是多个holder的共享事实源，退役竞态会造成过期路由；以并发测试锁定。
- Incarnation端口合同若与10630实现不一致，会在10637首次真实组合时暴露；端口变更须同步。
