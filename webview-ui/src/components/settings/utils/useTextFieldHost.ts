import { useEffect, useId } from "react"

/**
 * Marks the custom element so it can be found without a ref. The toolkit's
 * React wrapper does not forward refs to the underlying host element, so the
 * host is located through the DOM instead.
 */
const HOST_MARKER_ATTRIBUTE = "data-text-field-token"

export interface TextFieldHostProps {
	readonly [HOST_MARKER_ATTRIBUTE]: string
}

function findHost(token: string): HTMLElement | null {
	return document.querySelector<HTMLElement>(`[${HOST_MARKER_ATTRIBUTE}="${CSS.escape(token)}"]`)
}

/**
 * Keeps a `vscode-text-field` consistent with the React state that drives it.
 *
 * Two toolkit behaviours need correcting. Its `connectedCallback` overwrites the
 * host's `aria-label` with the generic string `"Text field"`, and FAST reflects
 * that attribute onto the inner `<input>`, so a label passed through JSX never
 * reaches assistive technology. Separately, the inner `<input>` keeps whatever
 * value was typed or programmatically written into it, and re-rendering with an
 * unchanged `value` prop does not reset it, which lets the DOM drift from React
 * state and makes a later write append to the stale text.
 *
 * Pass `syncValue=false` while the user is actively editing so the browser owns
 * the live value and selection. Re-enable synchronization at commit boundaries.
 * Spread the returned props onto the text field to opt in.
 */
export function useTextFieldHost(ariaLabel: string | undefined, value: string, syncValue = true): TextFieldHostProps {
	const token = useId()

	useEffect(() => {
		if (!ariaLabel) {
			return
		}

		const host = findHost(token)
		if (!host) {
			return
		}

		const restoreLabel = (): void => {
			if (host.getAttribute("aria-label") !== ariaLabel) {
				host.setAttribute("aria-label", ariaLabel)
			}
		}

		restoreLabel()

		// The element may connect or reconnect later, which repeats the overwrite.
		const observer = new MutationObserver(restoreLabel)
		observer.observe(host, { attributeFilter: ["aria-label"] })

		return () => observer.disconnect()
	}, [ariaLabel, token])

	useEffect(() => {
		if (!syncValue) {
			return
		}

		const host = findHost(token)
		if (!host) {
			return
		}

		const valueHost = host as HTMLElement & { value?: string }
		if (valueHost.value !== value) {
			valueHost.value = value
		}

		const input = host instanceof HTMLInputElement ? host : host.shadowRoot?.querySelector("input")
		if (input && input.value !== value) {
			input.value = value
		}
	}, [syncValue, token, value])

	return { [HOST_MARKER_ATTRIBUTE]: token }
}
