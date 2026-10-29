import type { Meta, StoryObj } from "@storybook/react-vite"
import { KillCommandRowView } from "./KillCommandRow"

const COMMAND = "npm --prefix docs run preview -- --port 4321"

const meta = {
    title: "Chat/Kill Command",
    component: KillCommandRowView,
    parameters: { layout: "padded" },
    args: {
        command: COMMAND,
        result: "Termination was requested for the running command.",
        activityId: "command-activity-1",
    },
    decorators: [
        (Story) => (
            <div style={{ maxWidth: 560 }}>
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof KillCommandRowView>

export default meta
type Story = StoryObj<typeof meta>

/** The activity snapshot has not arrived yet: the tool's own result is all that is known. */
export const Requested: Story = { args: { status: undefined } }

/** The command is still stopping. */
export const Terminating: Story = { args: { status: "cancelling" } }

/** The command stopped because of the request. */
export const Terminated: Story = { args: { status: "cancelled" } }

/** The command had exited before the request reached it. */
export const AlreadyFinished: Story = { args: { status: "completed" } }

/** The task was interrupted while the command ran. */
export const Interrupted: Story = { args: { status: "interrupted" } }

/** The function id matched no command. */
export const NotRunning: Story = {
    args: { activityId: undefined, command: "fn_unknown", result: "No running command matched that function id." },
}
