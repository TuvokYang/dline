// Minimal YAML reader for the memory-bank documents this verifier reads.
// It supports only what goals.yaml and progress.md frontmatter use: nested maps,
// scalar and map sequences, inline flow maps/arrays, quoted and block scalars.
// Anything else raises a tooling error so the caller can report a parser limitation.

export class YamlLiteError extends Error {}

function stripComment(line) {
    let inSingle = false
    let inDouble = false
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index]
        if (char === "\\" && inDouble) {
            index += 1
            continue
        }
        if (char === '"' && !inSingle) inDouble = !inDouble
        else if (char === "'" && !inDouble) inSingle = !inSingle
        else if (char === "#" && !inSingle && !inDouble && (index === 0 || /\s/.test(line[index - 1]))) {
            return line.slice(0, index)
        }
    }
    return line
}

function splitTopLevel(text, separator) {
    const parts = []
    let depth = 0
    let inSingle = false
    let inDouble = false
    let start = 0
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (char === "\\" && inDouble) {
            index += 1
            continue
        }
        if (char === '"' && !inSingle) {
            inDouble = !inDouble
            continue
        }
        if (char === "'" && !inDouble) {
            inSingle = !inSingle
            continue
        }
        if (inSingle || inDouble) continue
        if (char === "{" || char === "[") depth += 1
        else if (char === "}" || char === "]") depth -= 1
        else if (char === separator && depth === 0) {
            parts.push(text.slice(start, index))
            start = index + 1
        }
    }
    parts.push(text.slice(start))
    return parts
}

function splitKeyValue(content) {
    let inSingle = false
    let inDouble = false
    for (let index = 0; index < content.length; index += 1) {
        const char = content[index]
        if (char === "\\" && inDouble) {
            index += 1
            continue
        }
        if (char === '"' && !inSingle) inDouble = !inDouble
        else if (char === "'" && !inDouble) inSingle = !inDouble
        else if (char === ":" && !inSingle && !inDouble) {
            const next = content[index + 1]
            if (next === undefined || next === " " || next === "\t") {
                return { key: content.slice(0, index).trim(), value: content.slice(index + 1).trim() }
            }
        }
    }
    return null
}

function parseQuoted(text) {
    const quote = text[0]
    let value = ""
    for (let index = 1; index < text.length; index += 1) {
        const char = text[index]
        if (char === "\\" && quote === '"') {
            const next = text[index + 1]
            value += next === "n" ? "\n" : next === "t" ? "\t" : next
            index += 1
            continue
        }
        if (char === quote) {
            if (quote === "'" && text[index + 1] === "'") {
                value += "'"
                index += 1
                continue
            }
            return { value, rest: text.slice(index + 1).trim() }
        }
        value += char
    }
    throw new YamlLiteError(`unterminated quoted scalar: ${text.slice(0, 40)}`)
}

export function parseScalar(raw) {
    const text = raw.trim()
    if (text.length === 0) return null
    if (text === "null" || text === "~") return null
    if (text === "true") return true
    if (text === "false") return false
    if (text.startsWith('"') || text.startsWith("'")) {
        const parsed = parseQuoted(text)
        if (parsed.rest) throw new YamlLiteError(`unexpected content after quoted scalar: ${parsed.rest}`)
        return parsed.value
    }
    if (text.startsWith("[")) {
        if (!text.endsWith("]")) throw new YamlLiteError(`unterminated inline array: ${text}`)
        const body = text.slice(1, -1).trim()
        if (body.length === 0) return []
        return splitTopLevel(body, ",").map((part) => parseScalar(part))
    }
    if (text.startsWith("{")) {
        if (!text.endsWith("}")) throw new YamlLiteError(`unterminated inline map: ${text}`)
        const body = text.slice(1, -1).trim()
        const result = {}
        if (body.length === 0) return result
        for (const entry of splitTopLevel(body, ",")) {
            const pair = splitKeyValue(entry.trim())
            if (!pair) throw new YamlLiteError(`malformed inline map entry: ${entry}`)
            result[pair.key] = parseScalar(pair.value)
        }
        return result
    }
    if (/^-?\d+$/.test(text)) return Number.parseInt(text, 10)
    if (/^-?\d+\.\d+$/.test(text)) return Number.parseFloat(text)
    return text
}

function blockHeader(content, indent, line) {
    const sequence = isSequenceItem(content)
    const rest = sequence ? content.slice(1).trimStart() : content
    const pair = splitKeyValue(rest)
    const value = pair ? pair.value : rest
    if (!/^[|>]/.test(value)) return null
    const match = /^([|>])(?:([1-9])([+-]?)|([+-])([1-9]?))?$/.exec(value)
    if (!match) throw new YamlLiteError(`line ${line}: unsupported block scalar header: ${value}`)
    return {
        folded: match[1] === ">",
        chomp: match[3] || match[4] || "",
        offset: Number(match[2] || match[5]) || null,
        indent: indent + (sequence && pair ? content.indexOf(rest) : 0),
    }
}

function readBlockScalar(lines, start, header) {
    let end = start
    let indent = header.offset === null ? null : header.indent + header.offset
    while (end < lines.length) {
        const raw = lines[end]
        if (raw.trim()) {
            const width = raw.match(/^ */)[0].length
            if (width <= header.indent) break
            indent ??= width
            if (width < indent) throw new YamlLiteError(`line ${end + 1}: invalid block scalar indentation`)
        }
        end += 1
    }

    let value = ""
    let breaks = 0
    let previous = null
    for (let index = start; index < end; index += 1) {
        const raw = lines[index]
        const hasBreak = index < lines.length - 1
        if (!raw.trim()) {
            if (previous === null && indent !== null && raw.length > indent) {
                throw new YamlLiteError(`line ${index + 1}: leading blank line exceeds block indentation`)
            }
            breaks += Number(hasBreak)
            continue
        }
        const body = raw.slice(indent)
        const fold = header.folded && previous !== null && !/^\s/.test(previous) && !/^\s/.test(body)
        value += fold ? (breaks === 1 ? " " : "\n".repeat(Math.max(0, breaks - 1))) : "\n".repeat(breaks)
        value += body
        previous = body
        breaks = Number(hasBreak)
    }
    value += "\n".repeat(breaks)
    if (header.chomp !== "+") {
        value = value.replace(/\n+$/, "")
        if (header.chomp !== "-" && previous !== null && breaks > 0) value += "\n"
    }
    return { value, end }
}

function tokenize(text) {
    const entries = []
    const lines = text.replace(/\r\n?/g, "\n").split("\n")
    let started = false
    let ended = false
    for (let index = 0; index < lines.length; index += 1) {
        const stripped = stripComment(lines[index])
        if (stripped.trim().length === 0) continue
        if (/^ *\t/.test(stripped)) throw new YamlLiteError(`line ${index + 1}: tab indentation is unsupported`)
        const indent = stripped.length - stripped.trimStart().length
        const content = stripped.trim()
        if (ended) throw new YamlLiteError(`line ${index + 1}: content after document end`)
        if (indent === 0 && content === "---") {
            if (started || entries.length) throw new YamlLiteError(`line ${index + 1}: multiple YAML documents are unsupported`)
            started = true
            continue
        }
        if (indent === 0 && content === "...") {
            ended = true
            continue
        }
        const entry = { indent, content, line: index + 1 }
        const header = blockHeader(content, indent, entry.line)
        if (header) {
            const block = readBlockScalar(lines, index + 1, header)
            entry.blockValue = block.value
            index = block.end - 1
        }
        entries.push(entry)
    }
    return entries
}

function isSequenceItem(content) {
    return content === "-" || content.startsWith("- ")
}

function parseMap(state, indent) {
    const map = {}
    while (state.index < state.entries.length) {
        const entry = state.entries[state.index]
        if (entry.indent !== indent || isSequenceItem(entry.content)) break
        const pair = splitKeyValue(entry.content)
        if (!pair) {
            throw new YamlLiteError(`line ${entry.line}: expected "key: value" in mapping`)
        }
        state.index += 1
        if (pair.value.length > 0) {
            map[pair.key] = entry.blockValue ?? parseScalar(pair.value)
            continue
        }
        const next = state.entries[state.index]
        if (next && next.indent > indent) {
            map[pair.key] = parseBlock(state, next.indent)
        } else if (next && next.indent === indent && isSequenceItem(next.content)) {
            map[pair.key] = parseSequence(state, indent)
        } else {
            map[pair.key] = null
        }
    }
    return map
}

function parseSequence(state, indent) {
    const items = []
    while (state.index < state.entries.length) {
        const entry = state.entries[state.index]
        if (entry.indent !== indent || !isSequenceItem(entry.content)) break
        const rest = entry.content.slice(1).trim()
        state.index += 1
        if (rest.length === 0) {
            const next = state.entries[state.index]
            items.push(next && next.indent > indent ? parseBlock(state, next.indent) : null)
            continue
        }
        // Inline collections are complete scalar values. Looking for a colon
        // first would misread `- {role: declaration, ...}` as a block mapping
        // whose key is `{role`.
        if (rest.startsWith("{") || rest.startsWith("[")) {
            items.push(parseScalar(rest))
            continue
        }
        const pair = splitKeyValue(rest)
        if (!pair) {
            items.push(entry.blockValue ?? parseScalar(rest))
            continue
        }
        const item = {}
        if (pair.value.length > 0) item[pair.key] = entry.blockValue ?? parseScalar(pair.value)
        else {
            const next = state.entries[state.index]
            item[pair.key] = next && next.indent > indent ? parseBlock(state, next.indent) : null
        }
        const next = state.entries[state.index]
        if (next && next.indent > indent) {
            const continuation = parseMap(state, next.indent)
            Object.assign(item, continuation)
        }
        items.push(item)
    }
    return items
}

function parseBlock(state, indent) {
    if (state.index >= state.entries.length) return null
    const entry = state.entries[state.index]
    if (entry.indent < indent) return null
    return isSequenceItem(entry.content) ? parseSequence(state, entry.indent) : parseMap(state, entry.indent)
}

export function parseYamlLite(text) {
    const state = { entries: tokenize(text), index: 0 }
    if (state.entries.length === 0) return {}
    const value = parseBlock(state, state.entries[0].indent)
    if (state.index !== state.entries.length) {
        throw new YamlLiteError(`line ${state.entries[state.index].line}: unconsumed YAML content`)
    }
    return value
}

export function parseFrontmatter(markdown) {
    const lines = markdown.split(/\r?\n/)
    if (lines[0]?.trim() !== "---") return { data: {}, body: markdown, lineOffset: 0 }
    const closing = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line))
    if (closing === -1) throw new YamlLiteError("unterminated frontmatter block")
    return {
        data: parseYamlLite(lines.slice(1, closing).join("\n")),
        body: lines.slice(closing + 1).join("\n"),
        lineOffset: closing + 1,
    }
}

export function readFrontmatterFile(fs, filePath) {
    const text = fs.readFileSync(filePath, "utf8")
    return { text, ...parseFrontmatter(text) }
}
