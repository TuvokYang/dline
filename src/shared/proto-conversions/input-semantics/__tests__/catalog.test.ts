import { BUILTIN_INPUT_SEMANTICS, type InputSemanticDescriptor } from "@shared/input-semantics/catalog"
import {
	InputSemanticCatalog as WireCatalog,
	InputSemanticDescriptor as WireDescriptor,
	InputSemanticPayload as WirePayload,
} from "@shared/proto/dline/slash"
import { describe, expect, it } from "vitest"
import { fromProtoInputSemanticCatalog, toProtoInputSemanticCatalog, toProtoInputSemanticDescriptor } from "../catalog"

describe("input semantic catalog proto conversion", () => {
	it("round-trips every built-in descriptor and the revision", () => {
		const wire = toProtoInputSemanticCatalog({ revision: 7, descriptors: BUILTIN_INPUT_SEMANTICS })

		expect(fromProtoInputSemanticCatalog(wire)).toEqual({ revision: 7, descriptors: BUILTIN_INPUT_SEMANTICS })
	})

	it("round-trips a discovered capability descriptor", () => {
		const descriptor: InputSemanticDescriptor = {
			id: "command.skill.release",
			kind: "command",
			trigger: "/skills:release",
			payload: "text",
			composition: "combinable",
			lifecycle: "turn",
			dynamic: true,
		}

		const wire = toProtoInputSemanticCatalog({ revision: 1, descriptors: [descriptor] })

		expect(fromProtoInputSemanticCatalog(wire).descriptors).toEqual([descriptor])
	})

	it("projects the absent authorization as an empty wire field", () => {
		const mention = BUILTIN_INPUT_SEMANTICS.find((descriptor) => descriptor.id === "mention.file")
		if (!mention) throw new Error("mention.file must exist in the built-in catalog")

		expect(toProtoInputSemanticDescriptor(mention).authorizes).toBe("")
	})

	it("drops a descriptor whose wire enum this build cannot interpret", () => {
		// A newer backend can introduce a payload kind this build has no policy
		// for; the wire decoder reports it as UNRECOGNIZED.
		const unknown = WireDescriptor.create({
			id: "command.future",
			trigger: "/future",
			payload: WirePayload.UNRECOGNIZED,
		})

		const catalog = fromProtoInputSemanticCatalog(
			WireCatalog.create({
				revision: 4,
				descriptors: [toProtoInputSemanticDescriptor(BUILTIN_INPUT_SEMANTICS[0]), unknown],
			}),
		)

		expect(catalog.revision).toBe(4)
		expect(catalog.descriptors).toEqual([BUILTIN_INPUT_SEMANTICS[0]])
	})
})
