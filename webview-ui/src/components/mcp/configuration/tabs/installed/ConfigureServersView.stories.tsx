import type { Meta, StoryObj } from "@storybook/react-vite"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import ConfigureServersView from "./ConfigureServersView"

const meta: Meta<typeof ConfigureServersView> = {
    title: "MCP/ConfigureServersView",
    component: ConfigureServersView,
    decorators: [createStorybookDecorator({ mcpServers: [] })],
}

export default meta

type Story = StoryObj<typeof ConfigureServersView>
export const Default: Story = {}
export const Chinese: Story = {
    render: () => (
        <UiLanguageProvider language="zh-CN">
            <ConfigureServersView />
        </UiLanguageProvider>
    ),
}
