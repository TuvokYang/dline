import { normalizeAgentRuleSelections } from "@core/task/tools/subagent/AgentConfigLoader"
import { sanitizeSubagentToolsForPersistence } from "@core/task/tools/subagent/subagent-tool-policy"
import * as yaml from "js-yaml"

/** Presence is patch intent: undefined preserves a field; an empty capability list removes it. */
export interface SubagentConfigPatch {
    profile?: string
    description?: string
    tools?: readonly string[]
    skills?: readonly string[]
    rules?: readonly { scope: string; path: string }[]
    workflows?: readonly string[]
    mcp?: readonly { server: string; tools?: readonly string[]; resources?: readonly string[] }[]
}

interface YamlNode {
    start: number
    end: number
    kind: string | null
    value: unknown
    children: YamlNode[]
}

interface YamlField {
    name: string
    start: number
    end: number
    indent: string
}

interface YamlDocument {
    data: Record<string, unknown>
    fields: YamlField[]
    protectedRanges: { start: number; end: number }[]
}

/**
 * Patch only owned top-level frontmatter nodes. js-yaml validates the document and
 * identifies mapping keys; it never serializes the whole document. Unchanged nodes,
 * frontmatter delimiters and the system prompt retain their original bytes.
 */
export function patchSubagentConfigDocument(content: string, patch: SubagentConfigPatch): string {
    const opening = /^---[\t ]*\r?\n/.exec(content)
    if (!opening) throw new Error("Missing YAML frontmatter block in subagent config")
    const closingPattern = /^---[\t ]*(?:\r?\n|$)/gm
    closingPattern.lastIndex = opening[0].length
    const closing = closingPattern.exec(content)
    if (!closing) throw new Error("Missing closing YAML frontmatter delimiter in subagent config")

    const newline = opening[0].endsWith("\r\n") ? "\r\n" : "\n"
    let frontmatter = content.slice(opening[0].length, closing.index)
    const document = readYamlDocument(frontmatter)
    const replacements = new Map<string, unknown>()
    if (patch.profile !== undefined) replacements.set("profile", patch.profile || undefined)
    if (patch.description !== undefined) replacements.set("description", patch.description || undefined)

    // Preserve the existing Tools policy, including tools: [] meaning defaults.
    // Even unrelated saves sanitize a hand-edited list, but otherwise leave it byte-for-byte intact.
    if (patch.tools !== undefined) {
        replacements.set("tools", sanitizeSubagentToolsForPersistence(patch.tools))
    } else {
        const existing = readTools(document.data.tools)
        if (existing !== undefined) {
            const sanitized = sanitizeSubagentToolsForPersistence(existing)
            if (sanitized.length !== existing.length || sanitized.some((tool, index) => tool !== existing[index])) {
                replacements.set("tools", sanitized)
            }
        }
    }

    if (patch.skills !== undefined) replacements.set("skills", nonEmpty(normalizeNames(patch.skills, "skills")))
    if (patch.rules !== undefined) {
        // Validate and normalize with the exact rules the loader applies on
        // read, so a saved patch can never publish YAML the next parse rejects.
        replacements.set("rules", nonEmpty(normalizeAgentRuleSelections(patch.rules)))
    }
    if (patch.workflows !== undefined) replacements.set("workflows", nonEmpty(normalizeNames(patch.workflows, "workflows")))
    if (patch.mcp !== undefined) {
        const servers = patch.mcp.flatMap((selection) => {
            const tools = normalizeNames(selection.tools ?? [], "mcp.tools")
            const resources = normalizeNames(selection.resources ?? [], "mcp.resources")
            if (tools.length === 0 && resources.length === 0) return []
            const server = requiredName(selection.server, "mcp.server")
            return [{ server, ...(tools.length ? { tools } : {}), ...(resources.length ? { resources } : {}) }]
        })
        replacements.set("mcp", nonEmpty(servers))
    }

    // Apply bottom-up so parser offsets stay valid. Keeping the entire span's
    // trivia also preserves comments and blank lines immediately before the next key.
    for (const field of [...document.fields].reverse()) {
        if (!replacements.has(field.name)) continue
        const value = replacements.get(field.name)
        const replacement = value === undefined ? "" : dumpField(field.name, value, field.indent, newline)
        const trivia = retainTrivia(frontmatter, field.start, field.end, document.protectedRanges, field.indent)
        frontmatter = frontmatter.slice(0, field.start) + replacement + trivia + frontmatter.slice(field.end)
        replacements.delete(field.name)
    }
    const indent = document.fields[0]?.indent ?? ""
    for (const [name, value] of replacements) {
        if (value === undefined) continue
        if (frontmatter && !frontmatter.endsWith("\n")) frontmatter += newline
        frontmatter += dumpField(name, value, indent, newline)
    }

    // In particular, removing an anchor used by an untouched node must fail,
    // rather than atomically publishing YAML the next refresh cannot read.
    yaml.load(frontmatter, { schema: yaml.JSON_SCHEMA })
    return content.slice(0, opening[0].length) + frontmatter + content.slice(closing.index)
}

function readTools(value: unknown): string[] | undefined {
    if (value === undefined || value === null) return undefined
    if (typeof value === "string") {
        return value
            .split(",")
            .map((tool) => tool.trim())
            .filter(Boolean)
    }
    if (Array.isArray(value) && value.every((tool): tool is string => typeof tool === "string")) return value
    throw new Error("Subagent tools must be a string or a list of strings")
}

function requiredName(value: string, field: string): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`Subagent ${field} must not be empty`)
    return value.trim()
}

function normalizeNames(values: readonly string[], field: string): string[] {
    return [...new Set(values.map((value) => requiredName(value, field)))]
}

function nonEmpty<T>(values: T[]): T[] | undefined {
    return values.length ? values : undefined
}

function dumpField(name: string, value: unknown, indent: string, newline: string): string {
    return yaml
        .dump({ [name]: value }, { schema: yaml.JSON_SCHEMA, indent: 2, flowLevel: -1, noRefs: true, lineWidth: -1 })
        .split("\n")
        .slice(0, -1)
        .map((line) => indent + line + newline)
        .join("")
}

/** Parse events form a tiny syntax index, not a second YAML parser or persistence model. */
function readYamlDocument(source: string): YamlDocument {
    const stack: YamlNode[] = []
    const roots: YamlNode[] = []
    const data = yaml.load(source, {
        schema: yaml.JSON_SCHEMA,
        listener(event, state) {
            if (event === "open") {
                const node: YamlNode = { start: state.position, end: state.position, kind: null, value: undefined, children: [] }
                if (stack.length) stack[stack.length - 1].children.push(node)
                else roots.push(node)
                stack.push(node)
            } else {
                const node = stack.pop()!
                node.end = Math.min(state.position, source.length)
                node.kind = state.kind
                node.value = state.result
            }
        },
    })
    if (data === undefined || data === null) return { data: {}, fields: [], protectedRanges: [] }
    const root = roots[0]
    if (!root || root.kind !== "mapping" || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Subagent YAML frontmatter must be a mapping")
    }

    const fields: YamlField[] = []
    for (let index = 0; index < root.children.length; index += 2) {
        const key = root.children[index]
        const start = source.lastIndexOf("\n", key.start - 1) + 1
        const indent = source.slice(start, key.start)
        // A block mapping gives each top-level key its own line. Reject complex
        // keys/root flow mappings instead of guessing a span and damaging neighbors.
        if (typeof key.value !== "string" || !/^[ ]*$/.test(indent) || !root.children[index + 1]) {
            throw new Error("Subagent YAML frontmatter requires single-line block mapping keys")
        }
        fields.push({ name: key.value, start, end: source.length, indent })
    }
    for (let index = 0; index < fields.length - 1; index++) fields[index].end = fields[index + 1].start

    const protectedRanges: YamlDocument["protectedRanges"] = []
    const collectRanges = (node: YamlNode): void => {
        let start = scalarContentStart(source, node.start, node.end, protectedRanges)
        if (node.kind === "scalar" && node.children.length === 0) {
            if (source[start] === "|" || source[start] === ">") {
                // A block scalar's header can have a real comment. Its body,
                // including '# text' and empty lines, is data, not YAML trivia.
                const lineEnd = source.indexOf("\n", start)
                start = lineEnd === -1 ? node.end : lineEnd + 1
            }
            protectedRanges.push({ start, end: node.end })
        }
        for (const child of node.children) collectRanges(child)
    }
    collectRanges(root)
    return { data: data as Record<string, unknown>, fields, protectedRanges }
}

function skipSeparation(source: string, start: number, end: number): number {
    let position = start
    while (position < end) {
        if (/\s/.test(source[position])) position++
        else if (source[position] === "#") {
            while (position < end && source[position] !== "\n") position++
        } else break
    }
    return position
}

/** Index properties/aliases separately: their names can contain '#', but the intervening comments cannot. */
function scalarContentStart(
    source: string,
    start: number,
    end: number,
    protectedRanges: YamlDocument["protectedRanges"],
): number {
    let position = skipSeparation(source, start, end)
    while (position < end && "&!*".includes(source[position])) {
        const propertyStart = position
        if (source[position] === "!" && source[position + 1] === "<") {
            position = source.indexOf(">", position) + 1
        } else {
            while (position < end && !/[\s,[\]{}]/.test(source[position])) position++
        }
        protectedRanges.push({ start: propertyStart, end: position })
        position = skipSeparation(source, position, end)
    }
    return position
}

/** Preserve YAML comments, not '#' characters or blank lines inside a scalar value. */
function retainTrivia(
    source: string,
    start: number,
    end: number,
    protectedRanges: YamlDocument["protectedRanges"],
    indent: string,
): string {
    const isContent = (offset: number) => protectedRanges.some((range) => range.start <= offset && offset < range.end)
    let result = ""
    let position = start
    while (position < end) {
        const nextLine = source.indexOf("\n", position)
        const lineEnd = nextLine === -1 || nextLine >= end ? end : nextLine + 1
        const line = source.slice(position, lineEnd)
        if (!line.trim()) {
            if (!isContent(position)) result += line
        } else {
            for (let index = 0; index < line.length; index++) {
                if (line[index] !== "#" || isContent(position + index)) continue
                // Retain comments at the key's indentation, so a replaced block
                // scalar cannot consume a former item's indented comment as data.
                // Inline comments become standalone even when the field is removed.
                result += indent + line.slice(index)
                break
            }
        }
        position = lineEnd
    }
    return result
}
