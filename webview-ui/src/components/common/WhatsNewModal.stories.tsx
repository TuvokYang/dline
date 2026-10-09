import type { Meta, StoryObj } from "@storybook/react-vite"
import WhatsNewModal from "./WhatsNewModal"

const meta: Meta<typeof WhatsNewModal> = {
	title: "Common/WhatsNewModal",
	component: WhatsNewModal,
	args: {
		open: true,
		version: "0.10.0",
		onClose: () => {},
	},
}

export default meta

type Story = StoryObj<typeof WhatsNewModal>

export const Default: Story = {}
