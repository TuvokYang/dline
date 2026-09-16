import { describe, expect, it, vi } from "vitest"
import type {
	EventTelemetryCapability,
	TelemetryProviderRegistration,
	TelemetrySpanHandle,
	TraceTelemetryCapability,
} from "../providers/capabilities"
import { TelemetryChannelPolicy } from "../service/channel-policy"
import { TelemetryProviderRegistry } from "../service/provider-registry"

function registration(
	capabilities: TelemetryProviderRegistration["capabilities"],
	channels: TelemetryProviderRegistration["sink"]["channels"] = ["usage", "runtime"],
): TelemetryProviderRegistration {
	return {
		kind: "registration",
		base: {
			name: "test-provider",
			isEnabled: () => true,
			getSettings: () => ({ hostEnabled: true, level: "all" }),
			forceFlush: async () => {},
			dispose: async () => {},
		},
		sink: { kind: "loopback", origin: "default", channels },
		capabilities,
	}
}

function spanHandle(end: TelemetrySpanHandle["end"] = vi.fn()): TelemetrySpanHandle {
	return { active: true, setAttribute: vi.fn(), recordException: vi.fn(), end }
}

describe("TelemetryChannelPolicy", () => {
	it("blocks required usage signals before evaluating properties when consent is disabled", () => {
		const logRequired = vi.fn()
		const eventCapability: EventTelemetryCapability = {
			kind: "event",
			log: vi.fn(),
			logRequired,
			identifyUser: vi.fn(),
		}
		const properties = vi.fn(() => ({ sensitive: "must-not-materialize" }))
		const registry = new TelemetryProviderRegistry([registration([eventCapability])], {
			policy: new TelemetryChannelPolicy({
				readConsents: () => ({ usage: "disabled", error: "enabled" }),
			}),
		})

		registry.logEvent("user.opt_out", properties, true)

		expect(properties).not.toHaveBeenCalled()
		expect(logRequired).not.toHaveBeenCalled()
	})

	it("routes runtime traces through error consent without requiring an event capability", () => {
		const end = vi.fn()
		const startSpan = vi.fn(() => spanHandle(end))
		const traceCapability: TraceTelemetryCapability = { kind: "trace", startSpan }
		const registry = new TelemetryProviderRegistry([registration([traceCapability])], {
			policy: new TelemetryChannelPolicy({
				readConsents: () => ({ usage: "disabled", error: "enabled" }),
			}),
		})

		const span = registry.startSpan({ name: "tool.execution" }, "runtime")
		span.end("success")

		expect(startSpan).toHaveBeenCalledWith({ name: "tool.execution" })
		expect(end).toHaveBeenCalledWith("success", undefined)
	})

	it("journals events and ended spans first while allocating the remote trace identity first", () => {
		const order: string[] = []
		const makeRegistration = (name: string, sink: TelemetryProviderRegistration["sink"]): TelemetryProviderRegistration => ({
			kind: "registration",
			base: {
				name,
				isEnabled: () => true,
				getSettings: () => ({ hostEnabled: true, level: "all" }),
				forceFlush: async () => {},
				dispose: async () => {},
			},
			sink,
			capabilities: [
				{ kind: "event", log: () => order.push(`${name}:event`), logRequired: vi.fn(), identifyUser: vi.fn() },
				{
					kind: "trace",
					startSpan: () => {
						order.push(`${name}:trace:start`)
						return spanHandle(() => order.push(`${name}:trace:end`))
					},
				},
			],
		})
		const remote = makeRegistration("remote", { kind: "remote", origin: "user", channels: ["usage", "runtime"] })
		const journal = makeRegistration("journal", { kind: "journal", origin: "default", channels: ["usage", "runtime"] })
		const registry = new TelemetryProviderRegistry([remote, journal])

		registry.logEvent("task.started", () => ({}), false)
		registry.startSpan({ name: "tool.execution" }, "runtime").end("success")

		expect(order).toEqual([
			"journal:event",
			"remote:event",
			"remote:trace:start",
			"journal:trace:start",
			"journal:trace:end",
			"remote:trace:end",
		])
	})

	it("unwraps a composite parent into the matching provider-specific parent handle", () => {
		const firstParent = spanHandle()
		const secondParent = spanHandle()
		const firstStart = vi.fn().mockReturnValueOnce(firstParent).mockReturnValueOnce(spanHandle())
		const secondStart = vi.fn().mockReturnValueOnce(secondParent).mockReturnValueOnce(spanHandle())
		const makeTraceRegistration = (
			name: string,
			startSpan: TraceTelemetryCapability["startSpan"],
		): TelemetryProviderRegistration => ({
			kind: "registration",
			base: {
				name,
				isEnabled: () => true,
				getSettings: () => ({ hostEnabled: true, level: "all" }),
				forceFlush: async () => {},
				dispose: async () => {},
			},
			sink: { kind: "test", origin: "test", channels: ["runtime"] },
			capabilities: [{ kind: "trace", startSpan }],
		})
		const registry = new TelemetryProviderRegistry([
			makeTraceRegistration("first", firstStart),
			makeTraceRegistration("second", secondStart),
		])

		const parent = registry.startSpan({ name: "parent" }, "runtime")
		registry.startSpan({ name: "child", parent }, "runtime")

		expect(firstStart.mock.calls[1][0].parent).toBe(firstParent)
		expect(secondStart.mock.calls[1][0].parent).toBe(secondParent)
	})

	it("returns an inert span when the selected channel lacks consent", () => {
		const startSpan = vi.fn(() => spanHandle())
		const traceCapability: TraceTelemetryCapability = { kind: "trace", startSpan }
		const registry = new TelemetryProviderRegistry([registration([traceCapability])], {
			policy: new TelemetryChannelPolicy({
				readConsents: () => ({ usage: "enabled", error: "unset" }),
			}),
		})

		const span = registry.startSpan({ name: "tool.execution" }, "runtime")

		expect(span.active).toBe(false)
		expect(startSpan).not.toHaveBeenCalled()
	})
})
