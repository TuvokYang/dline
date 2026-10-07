import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { correctVirtuosoUpwardCompensation } from "../../vite-virtuoso-upward-compensation"

interface Row {
	originalIndex: number
	offset: number
	size: number
}

type Compensate = (
	previousItems: Row[],
	nextItems: Row[],
	scrollTop: number,
	nextHeight: number,
	previousHeight: number,
	lastJump: number,
) => number

/**
 * A stand-in for the library's scan with the same variable names, so the
 * corrected expression and its helper run exactly as they do in the bundle.
 */
const SCAN_HARNESS = `
const ot = (stream) => stream();
return function compensate(x, p, scrollTop, O, k, F) {
	const r = () => scrollTop;
	let V = 0;
	(V = O - k, V !== 0 && (V += F));
	return V;
};
`

function correctedCompensation(): Compensate {
	return new Function(correctVirtuosoUpwardCompensation(SCAN_HARNESS))() as Compensate
}

function rows(...sizes: number[]): Row[] {
	let offset = 0
	return sizes.map((size, originalIndex) => {
		const row = { originalIndex, offset, size }
		offset += size
		return row
	})
}

function heightOf(items: Row[]): number {
	const last = items[items.length - 1]
	return last.offset + last.size
}

describe("correctVirtuosoUpwardCompensation", () => {
	it("matches the installed react-virtuoso build exactly once", () => {
		const require = createRequire(import.meta.url)
		const distDir = path.dirname(require.resolve("react-virtuoso"))
		const source = readFileSync(path.join(distDir, "index.mjs"), "utf8")

		const corrected = correctVirtuosoUpwardCompensation(source)

		expect(corrected).toContain("__dlineViewportTopShift(x, p, ot(r), O - k)")
		expect(corrected).not.toContain("(V = O - k, V !== 0 && (V += F))")
	})

	it("fails when the expected expression is missing or ambiguous", () => {
		expect(() => correctVirtuosoUpwardCompensation("const unrelated = 1")).toThrow(/no longer matches/)
		const twice = "(V = O - k, V !== 0 && (V += F)); (V = O - k, V !== 0 && (V += F))"
		expect(() => correctVirtuosoUpwardCompensation(twice)).toThrow(/no longer matches/)
	})

	describe("corrected compensation", () => {
		const compensate = correctedCompensation()
		const previous = rows(100, 100, 100, 100)

		it("does not scroll the reader when a row below the viewport top grows", () => {
			const next = rows(100, 100, 100, 300)

			expect(compensate(previous, next, 150, heightOf(next), heightOf(previous), 0)).toBe(0)
		})

		it("compensates a row above the viewport growing", () => {
			const next = rows(160, 100, 100, 100)

			expect(compensate(previous, next, 150, heightOf(next), heightOf(previous), 0)).toBe(60)
		})

		it("compensates the row straddling the viewport top like the library does", () => {
			const next = rows(100, 140, 100, 100)

			expect(compensate(previous, next, 150, heightOf(next), heightOf(previous), 0)).toBe(40)
		})

		it("keeps a tall last row in place while it grows across the viewport top", () => {
			const next = rows(100, 100, 100, 400)

			expect(compensate(previous, next, 350, heightOf(next), heightOf(previous), 0)).toBe(0)
		})

		it("adds the pending resize jump to a non-zero compensation only", () => {
			const grownAbove = rows(160, 100, 100, 100)
			const grownBelow = rows(100, 100, 100, 300)

			expect(compensate(previous, grownAbove, 150, heightOf(grownAbove), heightOf(previous), 7)).toBe(67)
			expect(compensate(previous, grownBelow, 150, heightOf(grownBelow), heightOf(previous), 7)).toBe(0)
		})

		it("falls back to the whole list change when the row cannot be followed", () => {
			const next = rows(160, 100, 100, 100).filter((row) => row.originalIndex !== 2)

			expect(compensate(previous, next, 150, 520, heightOf(previous), 0)).toBe(120)
		})
	})
})
