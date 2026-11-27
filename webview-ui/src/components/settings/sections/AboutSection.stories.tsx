import type { Meta, StoryObj } from "@storybook/react-vite"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import AboutSection from "./AboutSection"

const meta: Meta<typeof AboutSection> = {
    title: "Settings/AboutSection",
    component: AboutSection,
    args: { version: "0.14.3", renderSectionHeader: () => null },
    decorators: [createStorybookDecorator({ errorReportingSetting: "enabled" })],
}

export default meta

type Story = StoryObj<typeof AboutSection>
export const Default: Story = {}
export const Chinese: Story = {
    render: (args) => (
        <UiLanguageProvider language="zh-CN">
            <AboutSection {...args} />
        </UiLanguageProvider>
    ),
}
