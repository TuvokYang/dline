<div align="center">

<img src="assets/icons/icon.png" width="96" alt="Dline" />

# Dline

**在 VS Code 中自主完成编码任务的 AI 智能体**

读写文件、执行命令、操作浏览器、调用 MCP 工具 —— 每一步都经你审批。

中文 | [English](README_en.md) · [变更日志](CHANGELOG.md) · [参与贡献](CONTRIBUTING.md)

</div>

<p align="center"><img src="assets/docs/marketplace/r1-hero.gif" width="1200" alt="Dline 完成一个编码任务的完整过程" /></p>


## 为什么选择 Dline

- **多任务并行，互不干扰** — 在同一个工作区里同时推进多个任务；每个任务拥有独立的模型、能力开关、检查点与执行状态。
- **按任务选择模型** — 调研任务用轻量模型，实现任务用强模型。Profile 绑定到任务，而不是全局唯一。
- **长任务不中断** — 上下文接近上限时自动分轮压缩，中途失败可以恢复继续，不必从头开始。
- **过程可见，操作可控** — 活动面板实时展示正在执行的工具、子代理时间线、API 速率与上下文占用；文件修改与命令执行都需要你的确认。
- **权限可细分** — `.agentignore` 按读取、写入、执行、可见四个维度限定智能体能触达的范围。

Dline 是 [Cline](https://github.com/cline/cline) 的社区分支。在保留原有交互模型的基础上，Dline 重构了任务运行时、状态存储、提示词架构、上下文管理与终端执行，并长期运行在真实生产项目中。

## 安装

### 从 VSIX 安装

获取 `.vsix` 文件后，通过 VS Code 的「从 VSIX 安装扩展」命令加载，或执行：

```bash
code --install-extension <vsix-文件>
```

### 从源码构建

```bash
npm run install:all
npm run vsix
```

生成的 `.vsix` 位于仓库根目录。开发环境搭建与调试方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

**环境要求**：VS Code 1.134.0 或更高版本。

**从 Cline 迁移**：首次启动时，已有的 Cline 数据（设置、MCP 配置、规则与工作流）会被复制到 Dline 目录；原数据不会被修改或删除，两个扩展可以共存。任务历史不再迁移：Dline 的任务索引与单任务运行时状态已与 Cline 不兼容，导入的记录无法打开或继续，因此原样保留在 Cline 目录中。

## 快速开始

1. 安装后，点击活动栏中的 Dline 图标打开侧边栏。
2. 打开设置中的 **API Configuration**，新建一个 Profile：选择服务商、填写 API Key、选择模型。
3. 在输入框描述你的任务，选择 **Plan**（先规划再执行）或 **Act**（直接执行）模式并发送。

Dline 在读写文件、执行命令或调用外部工具前会请求确认；你也可以在设置中为低风险操作开启自动审批。

<p align="center"><img src="assets/docs/marketplace/r2-quick-start.gif" width="1200" alt="配置 Profile 并发起第一个任务" /></p>


## 核心能力

### 并行任务与任务隔离

单个工作区内可同时运行多个任务，彼此完全隔离：

- **独立 Profile** — 每个任务绑定自己的模型与端点，切换任一任务的 Profile 不影响其他任务。
- **独立能力开关** — 技能、工作流、MCP 服务器、浏览器等能力按任务单独启用，并随任务保存。
- **独立检查点** — 文件归属按任务仲裁，一个任务的回退不会波及另一个任务修改的文件。
- **独立执行状态** — 取消、恢复、审批各自成链，不会相互串扰。

并行任务共享同一台机器，代码搜索与状态写入都有明确的配额与调度策略，一次全库搜索不会拖慢其他任务或界面响应。

<p align="center"><img src="assets/docs/marketplace/r3-parallel-tasks.gif" width="1200" alt="两个任务并行运行，各自使用不同的模型" /></p>


### 多 Profile 与模型服务商

同时管理多组 API Key 与端点，按任务、子代理、图像生成等用途分别绑定。API Key 存放在独立的密钥库中，与 Profile 配置解耦。

主任务与子代理不必使用同一个模型：可以为代码检索、深度审查、联网调研分别准备 Profile，再让不同的具名子代理绑定对应配置。在 **API Configuration** 中启用 Profile 并勾选 **Subagents** 用途后，即可在子代理设置中选择。需要生成图片时，还可以在该 API Profile 内配置图像源与图像模型，沿用该 Profile 的图像服务或绑定独立 Image Profile。

支持 OpenAI、Anthropic、Gemini、DeepSeek、OpenRouter、AWS Bedrock、Vertex AI、Qwen、GLM、Ollama、LM Studio 等 30 余家服务商与本地运行时。模型支持多种协议时，可以自行选择 OpenAI Chat、OpenAI Responses 或 Anthropic Chat 格式。

### 规则、技能、工作流与 MCP 的三层作用域

规则、技能、工作流、MCP 服务器与浏览器等能力按 **全局 / 工作区 / 任务** 三层作用域解析，逐层覆盖：

| 作用域 | 适用场景 |
|---|---|
| 全局 | 所有项目通用的个人偏好 |
| 工作区 | 当前项目的团队约定，随代码库一起版本化 |
| 任务 | 仅对本次任务临时启用或关闭 |

任务级设置随任务一起保存，恢复任务时自动还原，不会污染工作区配置。技能、工作流与 MCP 工具按需加载，不会预先占用上下文。

<p align="center"><img src="assets/docs/marketplace/r6-capability-scopes.gif" width="1200" alt="按任务调整工作流、技能、Rules 与 MCP，并提示 Prompt Cache 过期" /></p>


### 长任务与自动压缩

上下文接近或超出窗口上限时，Dline 会分多轮压缩对话：每轮只压缩一段可以安全归纳的范围，生成累积摘要并带入下一轮，直到剩余上下文足以继续执行为止。压缩带有预算约束与失败重放，中途出错可以恢复并继续，而不是从头开始。

<p align="center"><img src="assets/docs/marketplace/r8-compaction.gif" width="1200" alt="上下文自动压缩后任务继续执行" /></p>


### 实时活动面板

**Work** 标签页展示对话与工具输出；**Activities** 标签页展示正在执行的工具、子代理调用时间线与指标、API 速率与上下文占用曲线，以及失败重试的完整过程。智能体在做什么、花了多少上下文，一目了然。

<p align="center"><img src="assets/docs/marketplace/r4-activity-panel.gif" width="1200" alt="活动面板展示工具执行与上下文占用" /></p>


### 子代理与任务编排

把代码调查交给子代理，主任务只接收结论，不必携带全部阅读过程。内置 `default` 提供只读调研配置，支持后台运行、超时控制与可恢复失败自动重试；`use_subagents` 一次可运行 1–5 个 default 子代理。

具名子代理通过 `.agents/subagents/` 下的 YAML 定义职责、`profile`、工具白名单与可见技能。例如，让 `code-researcher` 使用快速检索 Profile，让 `architecture-reviewer` 使用深度推理 Profile，主任务继续使用实现代码的 Profile。有效的显式绑定使用子代理自己的模型与 Thinking 配置；省略 `profile` 时继承父任务的 **Act Profile**，即使父任务当前处于 Plan 模式。

工具也可以按职责组合：给联网调研代理开放 `web_search` / `web_fetch`，给专业分析代理开放 Skill 加载与 MCP 工具，给图像代理开放 `generate_image`。搜索路由和图像源由所绑定的 API Profile 配置；图像代理必须显式绑定有效 Profile，独立 Image Profile 也通过该 API Profile 关联，而不是在调用时任意切换凭据。工具白名单不替代各工具的权限与审批策略。

不同具名代理分别通过 `use_subagent` 调用；批量 `use_subagents` 只运行 default 配置，不为每项指定不同 Profile。需要独立推进实现时，可用 `spawn_task` 创建以 Plan 或 Act 模式启动的对等任务。配置示例和权限边界见[子代理使用说明](docs/features/subagents.mdx)。

<p align="center"><img src="assets/docs/marketplace/r5-subagents.gif" width="1200" alt="多个子代理并行调研" /></p>


### 代码理解、编辑与终端控制

- **语义级代码工具** — 除常规的读写、搜索与命令执行外，提供基于 LSP 的引用查找、语义重命名与跨文件批量替换。
- **终端控制** — 命令可指定工作目录、执行超时与后台交接时长；长时间运行的命令自动转入后台并保留输出，可随时终止。Windows 下自动处理 PowerShell 与 UTF-8 编码。
- **终端预热** — 终端实例按配置预先启动待命，命令下发时直接取用，省去 shell 启动等待。
- **终端环境配置** — 在 `.agents/bashrc.yml` 中为不同平台与 shell 声明环境变量、启动脚本与前置命令（例如激活 conda 环境），随项目一起版本化。

### 访问权限控制

`.agentignore` 使用 `.gitignore` 语法，并支持按维度移除权限，而不只是简单地隐藏路径：

```gitignore
secrets/          # 移除全部权限
vendor/ -w        # 只读，禁止写入
generated/ -s     # 不出现在列表和搜索中，但可按路径读取
scripts/ext/ -x   # 禁止作为命令工作目录
logs/ -r          # 禁止读取，其他权限保留
```

<p align="center"><img src="assets/docs/marketplace/r7-agentignore.png" width="1200" alt=".agentignore 拒绝写入只读目录" /></p>


### 检查点与任务历史

每次工具执行后自动创建基于 Git 的检查点，可随时对比或回退文件改动。任务历史支持搜索与恢复；任务运行期间可以继续输入，消息会排队并在安全边界送达。

<p align="center"><img src="assets/docs/marketplace/r9-checkpoints.png" width="1200" alt="检查点对比与回退" /></p>


### Web 搜索、图像生成与富文本渲染

- **Web 搜索与抓取** — 依据当前模型的能力自动路由：服务商提供托管搜索时在服务商侧执行，否则回退到本地实现。也可以按 Profile 固定为仅本地、仅托管或关闭。
- **图像生成** — 沿用当前 OpenAI Profile、使用服务商托管的图像能力，或绑定独立的 OpenAI / Gemini 图像 Profile；支持数量、尺寸、质量、格式与背景控制，以及基于已有图像继续编辑。
- **富文本渲染** — 对话中的 ` ```latex ` 代码块排版为公式，` ```mermaid ` 代码块渲染为图表，点击即可在编辑器中以 SVG 打开。

<p align="center"><img src="assets/docs/marketplace/r10-rich-rendering.png" width="1200" alt="LaTeX 公式与 Mermaid 图表渲染" /></p>


## 配置目录

| 路径 | 用途 |
|---|---|
| `.agents/rules/` | 项目规则，注入到系统提示词 |
| `.agents/workflows/` | 可复用的多步骤流程 |
| `.agents/skills/` | 任务专用方法与最佳实践 |
| `.agents/subagents/` | 子代理定义（YAML） |
| `.agents/mcp/` | 工作区级 MCP 服务器描述文件（YAML / JSON） |
| `.agents/bashrc.yml` | 终端环境配置 |
| `.agentignore` | 智能体访问权限规则 |

同时兼容 `AGENTS.md`、`.clinerules/`、`.cursor/rules/`、`.cursorrules`、`.windsurfrules` 与 `.claude/skills/`，已有项目无需迁移即可使用。

## 隐私与数据

- API Key 与凭据仅保存在本机的密钥库中，不会写入 Profile 配置文件或任务历史。
- 代码、提示词与对话内容只发送给你在 Profile 中配置的服务商。
- 使用情况报告与错误报告需要你分别同意，默认不开启；运行时遥测只在你开启后才会启动。
- 需要排查问题时，可以一键导出诊断包到本机；导出的 ZIP 不包含任何代码、提示词或凭据。

## 与 Cline 的关系

Dline 基于 Apache-2.0 许可的 [Cline](https://github.com/cline/cline) 项目构建，保留了原有的版权、许可与署名声明。Dline 不是 Cline 的官方版本，也不由 Cline Bot Inc. 发布；使用 Cline 名称仅用于说明项目来源与兼容性。

相对上游，Dline 累计改动超过 2300 个源码文件、新增约 30 万行代码，重构主线是**任务隔离**：让单个工作区内的多个任务拥有各自独立的 Profile、能力配置、检查点边界与执行状态。Dline 的改动由 Dline 维护者负责。

## 参与贡献

欢迎提交 Issue 与 Pull Request。开发环境、构建与调试说明见 [CONTRIBUTING.md](CONTRIBUTING.md)；端到端测试说明见 [src/test/e2e/README.md](src/test/e2e/README.md)。

## License

[Apache 2.0](LICENSE)
