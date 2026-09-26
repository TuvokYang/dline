中文 | [English](docs/changelog/CHANGELOG_en.md)

# Changelog

## [0.9.4]

### Features
- 并行工具调用：启用后，同一轮中无需人工审批的工具可并发执行；需要审批的调用逐项确认，设置中可调整最大并行工具数，关闭后仍串行执行
- `use_subagents` 单次最多接受 32 个子代理，可分别指定 Agent、API Profile 与超时；超出并行上限的任务排队，而非被截断
- Claude Code Profile 支持 OAuth 登录并通过 Anthropic Messages API 直连；Anthropic API Key Profile 可选发送 Claude Code 计费归因标识，是否由上游归入订阅额度取决于提供方
- Anthropic 与 Claude Code 在支持时可分别声明托管 Web Search 和 Web Fetch；是否实际调用由 Provider 响应决定，强制远程模式不可用时不会暗中回退本地
- 内置模型目录加入 Claude Opus 5.5，并将其设为 Anthropic 与 Claude Code 的默认模型；实际可用性仍取决于提供方账户

### Changed
- 订阅用量按 Provider 标明额度窗口及快照时间，并在本地统计 Dline 自身请求的每日输入/输出 token；不支持定时查询的来源保留首次快照与手动刷新
- 历史任务采用轻量只读窗口加载，同时保留任务绑定的 Profile、跨窗口锁提示和已记录的子代理指标
- 命令日志与 Shell 诊断归入所属任务的临时目录，日志按每任务容量预算清理；无任务归属的命令仍使用进程临时目录
- 从 Cline 迁移时不再导入无法在 Dline 打开或恢复的旧任务历史；设置、规则、工作流与 MCP 配置仍按既有路径迁移
- 切换模型时，先前模型的可读推理会降级为带 `<prior_model_reasoning>` 标记的普通上下文；不可重放的加密推理和响应 ID 不再传给新模型，并在后续用户轮次补充模型切换提示

### Fixed
- 修复只声明托管 Web 能力就弹出请求级审批的问题；`Use Web` 仍控制 Dline 本地 Web 工具的审批，旧托管审批快照只有在请求确属持久化历史尾部时才能经显式 Resume 恢复
- 修复 `generate_image` 审批、拒绝与重新打开时标题、提示词或图像卡片丢失的问题；拒绝不会触发 Provider 请求
- 修复跨 Provider 切换后将其他协议的 reasoning 当作 Anthropic thinking 重放、导致请求被拒的问题
- 修复关闭任务失败时缺少提示，以及重开已关闭任务后出现过期回复草稿的问题
- 修复审批与输入重复提交、自动重试堆叠失败卡片，以及命令流式输出期间卡片提前折叠的问题
- 修复命令结束、启动失败或取消后监听与日志流未及时收尾，以及后台命令跨任务误取消或尾部输出丢失的问题

## [0.9.3]

### Features
- OpenAI Codex Provider 能力扩展：支持动态模型发现、OpenAI Responses HTTP / WebSocket、托管 Web Search、推理与 Service Tier 控制，并统一 Profile 与任务输入区的账户配额、刷新和速率限制重置卡操作
- OpenAI / OpenAI Codex 图像来源配置：OpenAI 可选择 GPT Subscription、GPT API、Independent 或 Hosted，Codex 可选择 GPT Subscription、Independent 或 Hosted；统一默认使用 `gpt-image-2.5` 并自动迁移旧配置

### Changed
- 使用统计与错误/运行时诊断改为两个独立授权通道；旧单一遥测授权不自动迁移，未授权时不会创建对应 Journal 或远程客户端
- 诊断信号统一为有界本地 Journal 与 OpenTelemetry Events / Metrics / Traces；Dline 默认仅连接本机 `127.0.0.1:4318`，并在导出或发送前过滤提示词、文件内容、命令输入输出和凭据
- Provider 选择器改由 ModelRegistry 统一生成并分组展示；Cline 模型目录使用配置的 Dline catalog，移除上游推荐与推广卡片
- 实验功能开关改为本地配置解析，不再依赖登录或远程 PostHog

### Fixed
- 修复 Profile 切换后 Usage 短暂显示旧数据、手动刷新不更新或无反馈，以及 5 小时/7 天配额摘要选择错误
- 修复 Usage hover/click 浮层重叠、reset card 布局溢出与 Context Window 双层面板；点击详情改为自适应宽度的独立菜单
- 修复子代理达到超时或上下文压力上限时无法可靠收敛、最终结果被截断或丢失的问题
- 修复扩展重载后的上下文压缩重试恢复，并改进单 Pass 可发送历史、图片 token 估算与完整 logical turn 边界
- 修复长对话首次定位、流式跟随、向上浏览锚点、窗口扩展与尺寸变化时的虚拟滚动抖动和错位
- 修复关闭任务后的 Recent 路由与完成态操作，并将 View Changes / Explain Changes 限定到当前任务拥有的净变化
- 修复 MCP Marketplace 重复刷新、搜索焦点丢失、错误态输入卸载与滚动容器作用域问题
- 修复任务速率图表的 Total Tokens 计算，并将 TPM 与 RPM 显示在语义正确的独立坐标轴
- 修复图像生成失败或取消后重复读取已删除临时预览的问题，并避免在错误中暴露宿主机绝对路径
- 前台命令输出超过展示上限时，聊天与 Activities 现在会显示可点击的完整日志文件链接
- 修复窄窗口中工具路径、文件名、行号和匹配数的重叠或裁剪，并限制超长工具响应卡片高度
- 命令执行提示现在严格匹配环境报告的实际 shell，减少 PowerShell、cmd 与 POSIX 语法混用导致的失败
- 修正文件访问被忽略规则阻止时，错误卡仍显示旧 `.clineignore` 名称的问题

## [0.9.2]

### Features
- Activities 实时活动面板：新增 Work / Activities 双标签，实时展示任务执行、子代理指标、工具时间线与重试过程
- 运行时诊断：可选的本地运行时遥测采样与一键诊断包导出（ZIP 不含代码、提示词与凭据）
- 图像生成 `generate_image`：支持 OpenAI 独立/托管图像源与 Gemini 独立图像 Profile
- OpenAI Codex Profile OAuth：按 Profile 隔离的 ChatGPT 浏览器登录（PKCE），并在使用量栏展示剩余配额
- 能力加载工具：`use_skill` 拆分为 `load_skill` / `load_workflow` / `load_mcp`，按需加载技能、工作流与 MCP 工具元数据
- `kill_command` 工具：可终止指定的运行中命令
- 输入队列：任务运行期间可继续输入，消息排队并在安全边界送达
- 终端预热池：预热待命终端，命令执行不再等待冷启动
- 命令执行控制：新增 `workdirectory` 参数、命令超时与后台交接时长设置、项目 shell 环境加载
- `.agentignore` 权限属性：按 `-r` 读 / `-w` 写 / `-x` 执行 / `-s` 列出四个维度精确授权
- Capability 作用域链：能力开关支持全局 / 工作区 / 任务三层覆盖，任务级开关随任务持久化
- Web 工具模式控制：可按 Profile 选择自动、强制本地、强制远程或关闭
- API Format 选择器：模型支持多协议时可选择 OpenAI Chat / OpenAI Responses / Anthropic Chat
- OpenAI Service Tier 选择与任务级运行时控制
- 任务速率指标与图表：展示 API 速率、上下文占用与历史趋势
- Prompt 缓存健康提示与手动刷新入口
- 模式切换、Profile 切换与上下文转移对话框
- LaTeX 公式渲染（MathJax v4）与 Mermaid 图 SVG 导出
- 结构化 API 错误展示与复制、Webview 水合进度与失败提示
- 聊天发送快捷键可配置

### Changed
- 子代理增强：新增后台运行、超时控制、失败自动重试、输出预算与批量请求解析
- `plan_mode_respond` 更名为 `make_plan`，`focus_chain_change` 更名为 `change_todo_list`
- 任务历史迁移到 SQLite 存储，取代 JSONL 全量扫描并自动导入旧数据
- 提示词架构重构：i18n 模块化注册，变体收敛为 standard / lite 两个 Profile
- 上下文压缩重构：引入 Pass 预算约束与重试重放策略
- 模型发现统一到 ModelRegistry 单一入口，模型选择器合并为可搜索字段
- Settings 不再投影到 VS Code global state，只保留规范来源
- 忽略规则处理统一，并限制 ripgrep 工作区遍历的 CPU 占用
- Anthropic 支持 1M 长上下文 beta 与推理档位自动降级

### Fixed
- 修复任务取消、恢复、checkpoint 与多面板并发场景下的状态与生命周期问题
- 修复上下文压缩的记账、背压、重试重放与中断恢复问题
- 修复 Profile 切换、准入与凭据隔离在多任务下的一致性问题
- 修复工具结果顺序、审批拒绝后的结果跳过与原生工具轮次恢复问题
- 修复终端输出顺序、后台交接、停滞命令恢复与 Windows PowerShell/UTF-8 编码问题
- 修复 Webview 虚拟滚动、流式 diff 滚动、按钮路由与交互状态失配问题
- 修复 MCP 重连循环、描述符监听与工作区描述符加载问题

## [0.9.1]

### Features
- 任务级 Profile 模型切换：ModelSwitcher 可按任务隔离 API 配置，避免多窗口会话串用模型配置
- OpenAI Native / OpenAI Codex 模型数据更新：同步官方模型信息，并补充 thinking / reasoning 相关配置支持

### Changed
- Agent 工作流目录迁移：将 `.clinerules/workflows` 移动到 `.agents/workflows`，统一 agent 配置与工作流入口
- 任务 UI 状态恢复机制增强：引入 snapshot-first TaskUiState、ActionButtons 判决与消息窗口滚动/合并优化
- Prompt 变体配置简化：合并 Native GPT-5 系列变体，减少重复 prompt 文件
- Provider 配置与 token 语义进一步统一：修正 profile 展示、模型元数据、cache token 与 prompt cache 处理

### Fixed
- 修复多窗口任务 Profile 隔离、上下文压缩边界与 task-level overflow 状态恢复问题
- 修复工具审批与 Resume 流程：覆盖 read/list 审批、拒绝审批、恢复后原 ask 复用和 Process Anyway 输入传递
- 修复 `attempt_completion` 偶发不停止、带 feedback 恢复时错误显示 Start New Task 的状态流转问题
- 修复 auto-retry 取消无效、重试耗尽后不显示 Retry，以及空 API conversation 造成空响应循环的问题
- 修复 Apply Patch partial message 时间戳、短 diff 标记搜索和 MCP base URL 等稳定性问题

## [0.9.0]

### Added
- Profile 多配置系统：支持多组 API 密钥和端点配置，可独立管理不同环境的连接参数
- 多窗口/多实例支持：多个独立 Controller 实例，支持同时打开多个不相关的会话
- `find_references` 工具：通过 IDE LSP 查找所有符号引用
- `rename` 工具：语义级符号重命名（LSP 驱动，区分引用/注释/字符串）
- `replace_text` 工具：跨文件批量文本替换（literal 或 regex 模式）
- `qna_respond` 工具：问答交互模式，不执行任何变更
- UsageBar 使用量实时显示：token 消耗和费用实时展示
- I18n 多语言提示词框架：所有系统提示词迁移至国际化系统
- GLM 原生工具调用支持 (Native Tool Call)
- Cline → Dline 自动迁移：首次启动自动迁移所有数据

### Changed
- Focus Chain 升级顺序约束能力：强制 AI 按步骤顺序执行任务，禁止跳过或回填
- Skills 增强：slash 命令解析时自动加载关联 skill 到上下文
- Provider 模型配置独立为 JSON 文件（从 api.ts 分离），用户可直接编辑修改模型信息
- Task 状态机重构：解耦为 MessageChannel + BlockPhaseMachine + TaskPhaseMachine
- apiKey 安全存储与 Profile 配置分离：apiKey 独立存储到专用 key store
- Checkpoint 轻量化：git diff --name-only 替代全量 git add .，大幅缩短持锁时间
- ClineMessage 增量推送：fetchMessage RPC + virtual-scroll 滑动窗口
- 启动性能大幅优化

### Fixed
- 根治 webview 灰屏：长对话上下文下 webview 偶发空白崩溃
- Command 终端中文乱码：自动检测 Windows 终端编码 (GBK/CP936 → UTF-8)
- Diff 工具多项修复：分隔符误判、孤儿标记误报、流式 UNCLOSED 误报等
- 任务恢复流程稳定化：JSONL 增量存储、消息精确匹配
