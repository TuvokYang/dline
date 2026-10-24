# TASK-10631 Plan

## Approach

交付只读视图数据面：opening级`TaskReadModel`只消费已提交事实；按精确实例身份键控的`TaskViewProjectionOwner`统一服务main/child/resident，不依赖opening也能提供同一`TaskViewSource`；feed提供原子snapshot+subscribe基线、有界分页/增量、gap/reset与dispose；Webview侧改为有界store，ExtensionState不再携带增长内容。生命周期promotion属于TASK-10628，删除排空的调用方是TASK-10636，Controller surface安装在TASK-10638切换。

## Architecture Design

视图订阅（细化`L4-view-subscription`）：

```mermaid
flowchart TB
    %% id: TASK-10631-view-subscription
    %% layer: L5
    %% kind: flow
    %% refines: L4-view-subscription
    %% concept: ViewSource = ViewSource
    %% concept: ViewOwner = ViewProjectionOwner
    %% concept: Opening = Slot
    %% concept: Admission = RootAdmission
    %% answers: how read-only viewing differs from promotion and how bounded feeds reset and dispose
    Controller[Controller surface installation] -->|user intent| Mode{View or promote?}
    Mode -->|view; no lock or maintenance| Format{Explicit format evidence}
    Format -->|known old platform| Legacy[LegacyUnsupportedTaskView\nmetadata export and guarded delete]
    Format -->|current or damaged current data| ViewOwner[TaskViewProjectionOwner\nstable exact-identity view-handle lifetime; opens lazy bounded read-only adapters]
    Admission[RootAdmissionBoundary] -.->|current exact binding and delete-phase fact consumed immediately before and after adapter open; deleting or tombstoned closes the adapter| ViewOwner
    ViewOwner -->|owns facade independently of opening| ViewSource[Read-only TaskViewSource\ndiagnostics do not classify data as legacy]
    Mode -->|explicit promotion or resume| Process[TaskProcess]
    Process -.->|opening result or unavailable fact| Controller
    Opening[OpeningSlot] -.->|published replaced or closed opening fact attaches or detaches current ReadModel and emits reset| ViewOwner
    ViewSource -->|owner atomically establishes snapshot and baseline| Capture[Bounded snapshot and sequence]
    Capture -->|subscribe from captured baseline| Stream[Message / History / compact-shell feeds]
    Stream -->|page or bounded delta| Check{Identity sequence and buffer valid?}
    Check -->|yes| WebviewMessages[Client bounded view stores]
    Check -->|gap opening change or overflow| Reset[Reset; discard obsolete window]
    Reset -->|fetch a new bounded baseline| Capture
    Stream -->|surface closed or subscription replaced| Dispose[TaskViewProjectionOwner releases only this subscription; last surface closes owned read-only handles but not the Task]
    Legacy -->|read-only supported projection| WebviewMessages
```

读投影来源（细化`L0-persistence-authority`中视图段）：

```mermaid
flowchart LR
    %% id: TASK-10631-read-projection
    %% layer: L2
    %% kind: structure
    %% refines: L0-persistence-authority
    %% concept: Layout = InstanceStores
    %% answers: which committed sources feed the read model and view owner without any writer
    Journal[journal.db\nconversation control interaction child instance link result extension selection and typed jobs] -->|projects opening committed facts| ReadModel[TaskReadModel\nopening-scoped committed-fact producer]
    State[state.json plus backup\nkernel aggregate revision durable outbox] -->|projects opening committed facts| ReadModel
    Messages[messages.db\nderived UI message window] -->|projects opening committed facts| ReadModel
    Activities[activities.db\nactivity history] -->|projects opening committed facts| ReadModel
    Layout[InstanceLayout] -->|opens bounded read-only query adapters without CanonicalWriterGate or opening| ViewProjectionOwner[TaskViewProjectionOwner\nowns lazy read-only query adapters feeds opening attachment reset and dispose]
    ReadModel -.->|current-opening committed-delta and attachment-lifecycle facts| ViewProjectionOwner
    GlobalHistory[TaskHistoryRepository\ntaskHistory.db] -->|bounded listing queries| ViewProjectionOwner
    ViewProjectionOwner -->|owns and projects| HistoryFeed[TaskHistoryFeed]
    ViewProjectionOwner -->|owns and projects; falls back to bounded store queries without opening| MessageFeed[TaskMessageFeed]
    ViewProjectionOwner -->|owns and projects| Shell[Compact shell state]
    MessageFeed -->|snapshot page delta reset| WebviewMessages[WebviewMessageWindowStore]
```

- Owner/write boundary（与`goals.yaml`一致）：
  - `src/core/task/views`（含增量行投影宿主、旧行只读升级调用与`TaskViewState`重试阶段投影）；
  - `src/core/controller/taskView`；
  - `proto/dline/task_view.proto`；
  - `webview-ui/src/stores/taskView`；
  - `chat-view`中接线组件的输入重构。`messageUtils`、`failurePresentation`、`explorationRuns`的规则抽取与`ToolGroupRenderer`的工具switch迁出属于TASK-10641；`ChatView.tsx`的数据源切换属于TASK-10638；
  - `ExtensionStateContext.tsx`中的增长字段段。
- 命令/事实方向：视图只读已提交事实，从不接收command或写canonical store；opening附着只来自OpeningSlot事实。
- 失败/释放：gap/overflow/opening变化一律reset后重取有界基线；删除时停止新附着、排空查询并释放root读句柄；最后一个surface关闭只关闭只读句柄，不关闭Task。

### Delivery Evidence Anchor

```mermaid
flowchart LR
    %% id: TASK-10631-delivery
    %% layer: L5
    %% kind: structure
    %% refines: L5-task-delivery
    %% answers: which code boundary TASK-10631 owns before downstream Tasks may consume it
    %% local-only: T10631Source
    %% artifact: T10631Source role=emitter path=src/core/task/views symbol=DeliveryContract expect=present
    %% artifact: T10631 role=receiver path=src/core/task/views symbol=DeliveryBoundary expect=present
    T10631Source[Task-local delivery contract] -->|assembles owned delivery boundary| T10631["TASK-10631 not yet verified\nowner TASK-10631"]
```

## Steps

1. 盘点当前Controller→Webview的messages/taskHistory/ExtensionState推送路径与已有分页上限。
2. 定义TaskViewSource/feeds合同与`task_view.proto`，运行`npm run protos`生成客户端。
3. 实现TaskReadModel（只消费committed facts）与TaskViewProjectionOwner（精确身份键控、懒只读adapter、opening附着/reset、删除排空、dispose）。
4. 实现feeds的原子snapshot+subscribe、有界page/delta、gap/reset与背压。
5. 实现LegacyUnsupportedTaskView（仅显式旧格式证据）。
6. 实现Webview有界store并从ExtensionState移除增长字段（生产路由切换在TASK-10638）。
7. 补规模、背压、reset与删除排空测试；Webview组件测试。
8. 在`TaskViewProjectionOwner`中按提交顺序托管TASK-10641的增量行投影：
   - cursor与carry随视图基线一起建立；
   - page与delta携带已投影行与稳定row id；
   - 重启、checkpoint恢复、generation变化或carry超限时，发出reset并从基线重算。
9. 发送前对当前Task中已有的旧格式行做只读升级：失败行调用TASK-10640的`upgradeLegacyFailureRow`；工具行按TASK-10626在ToolCatalog `presentationVariants`上声明的旧`UiSayTool.tool`值升级，这是旧tool kind映射的唯一来源；不改写存储，也不在Webview解析旧文本。
10. 把Runtime的重试阶段事实投影进`TaskViewState`（截止时间、attempt/maxAttempts、`retryNow`、`forceTruncateAvailable`），取代`TaskViewMessageAdapter`读取gate的做法；`interaction_withdrawn`对应交互的行由投影隐藏，并与今日一样隐藏最近一条`error_retry`行。
11. 对`MessagesArea`、`MessageRenderer`、`ExplorationRunRenderer`、`PendingApprovalCard`、`useChatState`与滚动hook做行为保持重构：尾部行事实、分组与请求状态改为输入。旧路径由现有推导提供这些输入，新路径由投影行与`TaskViewState`提供。按PF-8，新数据路径在TASK-10638切换前只在组件测试与Storybook中可达；`ChatView.tsx`的切换与combiner调用的移除属于TASK-10638。

## Architecture Evidence

```yaml
architecture_evidence:
  schema_version: 2
  diagram_id: TASK-10631-delivery
  nodes:
    T10631Source:
      artifacts:
        - id: task10631-delivery-emitter
          role: emitter
          path: src/core/task/views
          symbol: DeliveryContract
          expectation: present
    T10631:
      artifacts:
        - id: task10631-delivery-receiver
          role: receiver
          path: src/core/task/views
          symbol: DeliveryBoundary
          expectation: present
  edges:
    - id: task10631-delivery-edge
      from: T10631Source
      to: T10631
      style: solid
      label: assembles owned delivery boundary
      kind: composition
      emit: {node: T10631Source, artifact: task10631-delivery-emitter}
      receive: {node: T10631, artifact: task10631-delivery-receiver}
      proof: [VER-TASK-10631-FEEDS]
```

## Verification

- `VER-TASK-10631-FEEDS`、`VER-TASK-10631-OWNER`：`npm run test:run -- src/core/task/views`，用真实SQLite store驱动并发提交、慢消费者与opening替换，断言序列、reset与上限。
- `VER-TASK-10631-SHELL`：50K消息/10K history fixture下测量shell字节与消息变更时的shell推送次数。
- `VER-TASK-10631-LEGACY`：旧格式证据与损坏当前数据分别驱动，断言分类。
- Webview：`webview-ui`相关Vitest；`npm run protos`后`npm run check-types`、`npm run lint`。
- `VER-TASK-10631-PROJECTION-HOST`：`npm run test:run -- src/core/task/views`，以真实store与提交序列驱动以下场景并断言行、row id与`TaskViewState`：分页、增量、重启、checkpoint恢复、generation变化、旧行升级与`interaction_withdrawn`。倒计时页脚、`retryNow`与强制截断入口的输入，与当前`TaskViewMessageAdapter`测试的期望一致。另断言spec PF-5的同源不变量：上述每个场景以及消息窗口重同步之后，`TaskViewState`中的失败动作（Retry、Start New Task、`retryNow`、强制截断）只与同一交互的可见失败卡片行同时出现。
- `VER-TASK-10631-PRESENTATION-PARITY`：消息窗口store与投影行接入后，运行以下测试并保留其断言：
  - `webview-ui/src/task-interaction/renderers/__tests__/ErrorRenderer.test.tsx`；
  - `webview-ui/src/task-interaction/__tests__/InteractionHost.test.tsx`；
  - `webview-ui/src/components/chat/__tests__/ChatRow.auto-retry.test.tsx`；
  - TASK-10641迁移的combiner oracle fixture（对接后端宿主运行）。

  仅已采纳的BD行允许更新断言。另在Storybook检查`App.stories`中API失败、重试、倒计时与强制截断场景渲染一致。

## Risks

- `npm run protos`会整体重写生成文件；与其他Task（10633/10635）的proto变更须由controller在全部输入完成后统一生成并整文件集成。
- Webview迁移若与现有messages推送并存会出现双数据源；生产切换只在TASK-10638进行，本Task期间旧路径保持不变。
- 错误卡片、重试合并与BrowserSessionRow等组件目前依赖“最后一条消息”与完整messages数组。按PF-5改由后端投影字段提供后，分页不再影响这些判断；风险在于遗漏某个读取`isLast`或全数组的组件，以PF-5合同测试与import/prop检查兜底。
