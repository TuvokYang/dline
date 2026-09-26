import { describe, expect, it } from "vitest"
import { hostedWebApprovalApiIndex, hostedWebApprovalId } from "../HostedWebApproval"

describe("legacy Hosted Web approval identity", () => {
	it("parses only this task's canonical non-negative request identity", () => {
		expect(hostedWebApprovalApiIndex("task-1", "hosted-web:task-1:0")).toBe(0)
		expect(hostedWebApprovalApiIndex("task-1", "hosted-web:task-1:42")).toBe(42)
		expect(hostedWebApprovalApiIndex("task-1", "hosted-web:task-2:0")).toBeUndefined()
		expect(hostedWebApprovalApiIndex("task-1", "hosted-web:task-1:-1")).toBeUndefined()
		expect(hostedWebApprovalApiIndex("task-1", "hosted-web:task-1:01")).toBeUndefined()
	})

	it("builds the exact legacy identity used by migration", () => {
		expect(hostedWebApprovalId("task-1", 42)).toBe("hosted-web:task-1:42")
	})
})
