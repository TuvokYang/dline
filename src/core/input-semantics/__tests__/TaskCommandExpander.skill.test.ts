import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { beforeAll, describe, expect, it } from "vitest"
import { TaskCommandExpander } from "../TaskEntityResolvers"

/**
 * A skill command must carry its instructions into the provider projection.
 *
 * Admission replaces the command node with whatever the expander returns, so an
 * expansion that loses the skill body silently sends a request without the
 * capability the user explicitly named.
 */
const SKILL_NAME = "expander-health"
const SKILL_MARKER = "EXPANDER_SKILL_ACTIVE"

let workspace: string
let skillFile: string

beforeAll(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), "dline-skill-expander-"))
	const skillDir = path.join(workspace, ".agents", "skills", SKILL_NAME)
	await mkdir(skillDir, { recursive: true })
	skillFile = path.join(skillDir, "SKILL.md")
	await writeFile(
		skillFile,
		["---", `name: ${SKILL_NAME}`, "description: Verify the expander injects skill instructions.", "---", SKILL_MARKER].join(
			"\n",
		),
		"utf8",
	)
})

function expander() {
	return new TaskCommandExpander(() => ({
		localWorkflowToggles: {},
		globalWorkflowToggles: {},
		taskIncarnationId: "task-1",
		capabilityContext: {
			cwd: workspace,
			capabilityToggles: createTaskCapabilityToggles({ localSkillsToggles: { [skillFile]: true } }),
			remoteSkills: [],
			remoteWorkflows: [],
		},
	}))
}

describe("TaskCommandExpander", () => {
	it("injects the skill instructions for a command the document already named", async () => {
		const expansion = await expander().expand({
			entityId: "doc-1#0",
			commandId: `command.skill.${SKILL_NAME}`,
			canonicalName: SKILL_NAME,
			namespace: "skill",
			sourceText: `/skills:${SKILL_NAME}`,
		})

		expect(expansion.text).toContain(SKILL_MARKER)
		expect(expansion.text).not.toContain(`/skills:${SKILL_NAME}`)
		expect(expansion.explicitInstructions).toEqual([
			{ type: "skill", source: "skill_injection", metadata: { name: SKILL_NAME } },
		])
	})
})
