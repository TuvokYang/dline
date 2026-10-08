import type { TaskViewState } from "@shared/ExtensionMessage"

/**
 * The view of a task this window shows while another window owns it.
 *
 * Input and every footer action are disabled because the owning window is the
 * task's only writer; the lock banner offers the explicit takeover. Only the
 * controls change, so the conversation stays readable.
 */
export function readOnlyTaskView(view: TaskViewState): TaskViewState {
	return {
		...view,
		input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
		footer: { actions: view.footer.actions.map((action) => ({ ...action, enabled: false })) },
	}
}
