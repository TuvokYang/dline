import type { Meta, StoryObj } from "@storybook/react-vite"
import type { ReactNode } from "react"
import AgentUpdateRow from "./AgentUpdateRow"

/*
 * The two non-turn-ending update rows, shown between the rows around them so
 * their visual weight is judged in context: working_respond renders as a
 * Reply, phase_report as a Phase report with a divider under its header.
 */

const REPLY_TEXT = "收到，修完之后我会编译一个 vsix:dev 给你。现在继续看组合层、历史会话恢复和 executor 释放这几处代码。"

const REPORT_TEXT = `BUGFIX-169 已完成本地修复与验证，未提交。

- **修复**：持锁窗口打开任务时把遗留的运行中命令标为已中断，关闭时收尾仍在进行的活动
- **验证**：聚焦 84 个、回归 671 个测试通过；\`check-types\` 与 biome 通过
- **下一步**：检查 working_respond 与 phase_report 的展示链路`

/** A stand-in for the rows around an update. */
function ToolRowStub({ label }: { label: string }) {
    return <div className="px-1 text-[12px] text-description">{label}</div>
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="flex flex-col gap-3">
            <h3 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-description">{title}</h3>
            {children}
        </section>
    )
}

function Gallery() {
    return (
        <div className="flex flex-col gap-8">
            <Section title="Reply (working_respond)">
                <ToolRowStub label="Dline read 2 files" />
                <AgentUpdateRow kind="reply" text={REPLY_TEXT} />
                <ToolRowStub label="Dline performed 1 search" />
            </Section>
            <Section title="Phase report (phase_report)">
                <ToolRowStub label="Dline ran a command" />
                <AgentUpdateRow kind="phase_report" text={REPORT_TEXT} />
                <ToolRowStub label="Dline edited 1 file" />
            </Section>
            <Section title="Long phase report (scrolls past 40vh)">
                <AgentUpdateRow kind="phase_report" text={Array.from({ length: 12 }, () => REPORT_TEXT).join("\n\n")} />
            </Section>
        </div>
    )
}

const meta: Meta<typeof Gallery> = {
    title: "Chat/Agent Update Rows",
    component: Gallery,
    parameters: { layout: "padded" },
    decorators: [
        (Story) => (
            <div className="w-full max-w-[560px] bg-(--vscode-sideBar-background) p-4 text-(--vscode-foreground)">
                <Story />
            </div>
        ),
    ],
}

export default meta
type Story = StoryObj<typeof Gallery>

export const ReplyAndPhaseReport: Story = {}
