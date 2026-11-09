// Protocol Buffer service and RPC facts private to this Skill.

import fs from "node:fs"
import path from "node:path"
import { attachProtoTypeIdentities } from "./proto-identities.mjs"

function normalized(filePath) {
    return filePath.replaceAll("\\", "/")
}

function protoFiles(root) {
    const files = []
    const walk = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const absolute = path.join(directory, entry.name)
            if (entry.isDirectory()) walk(absolute)
            else if (entry.isFile() && entry.name.endsWith(".proto")) files.push(absolute)
        }
    }
    if (fs.existsSync(root)) walk(root)
    return files
}

function tokenize(source) {
    const tokens = []
    let index = 0
    let line = 1
    const push = (value, tokenLine = line) => tokens.push({ value, line: tokenLine })
    while (index < source.length) {
        const char = source[index]
        if (char === "\n") {
            line += 1
            index += 1
            continue
        }
        if (/\s/.test(char)) {
            index += 1
            continue
        }
        if (char === "/" && source[index + 1] === "/") {
            index += 2
            while (index < source.length && source[index] !== "\n") index += 1
            continue
        }
        if (char === "/" && source[index + 1] === "*") {
            index += 2
            while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
                if (source[index] === "\n") line += 1
                index += 1
            }
            index += 2
            continue
        }
        if (char === '"' || char === "'") {
            const quote = char
            const start = index++
            const tokenLine = line
            let escaped = false
            while (index < source.length) {
                if (source[index] === "\\") {
                    escaped = true
                    index += 2
                    continue
                }
                if (source[index] === quote) break
                if (source[index] === "\n") line += 1
                index += 1
            }
            // A string is never a keyword. Escaped import paths are unsupported,
            // not guessed from an undecoded token or treated as local declarations.
            tokens.push({
                value: null,
                string: escaped || source[index] !== quote ? null : source.slice(start + 1, index),
                line: tokenLine,
            })
            index += 1
            continue
        }
        if (/[A-Za-z_]/.test(char)) {
            const tokenLine = line
            let value = char
            index += 1
            while (index < source.length && /[A-Za-z0-9_.]/.test(source[index])) value += source[index++]
            push(value, tokenLine)
            continue
        }
        push(char)
        index += 1
    }
    return tokens
}

function parenthesized(tokens, start) {
    if (tokens[start]?.value !== "(") return null
    let index = start + 1
    let stream = false
    if (tokens[index]?.value === "stream") {
        stream = true
        index += 1
    }
    const parts = []
    while (index < tokens.length && tokens[index].value !== ")") parts.push(tokens[index++].value)
    if (tokens[index]?.value !== ")") return null
    return { value: parts.join(""), stream, next: index + 1 }
}

function parseRpc(tokens, start) {
    const rpc = tokens[start]
    const name = tokens[start + 1]?.value
    const request = parenthesized(tokens, start + 2)
    if (!name || !request || tokens[request.next]?.value !== "returns") return null
    const response = parenthesized(tokens, request.next + 1)
    if (!response) return null
    return {
        method: {
            line: rpc.line,
            name,
            requestType: request.value,
            responseType: response.value,
            requestStream: request.stream,
            responseStream: response.stream,
        },
        next: response.next,
    }
}

function blockEnd(tokens, start) {
    let depth = 1
    for (let cursor = start + 1; cursor < tokens.length; cursor++) {
        if (tokens[cursor].value === "{") depth++
        if (tokens[cursor].value === "}" && --depth === 0) return cursor
    }
    return -1
}

function declarationRanges(tokens, file, packageName, diagnostics) {
    const types = []
    const imports = []
    const services = []
    const walk = (start, end, scope, topLevel) => {
        let cursor = start
        while (cursor < end) {
            const token = tokens[cursor]
            const name = tokens[cursor + 1]?.value
            if (["message", "enum", "service"].includes(token.value)) {
                const validHeader = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name ?? "") && tokens[cursor + 2]?.value === "{"
                const close = validHeader ? blockEnd(tokens, cursor + 2) : -1
                if (close < 0 || close >= end) {
                    diagnostics.push({ file, line: token.line, message: `unable to parse ${token.value} declaration` })
                    break
                }
                const fullName = scope ? `${scope}.${name}` : name
                if (token.value === "service" && topLevel) services.push({ start: cursor, body: cursor + 2, end: close })
                if (["message", "enum"].includes(token.value)) {
                    types.push({ file, line: token.line, name, fullName, kind: token.value })
                    if (token.value === "message") walk(cursor + 3, close, fullName, false)
                }
                cursor = close + 1
                continue
            }
            if (topLevel && token.value === "import") {
                const visibility = ["public", "weak"].includes(name) ? name : "private"
                const literal = tokens[cursor + (visibility === "private" ? 1 : 2)]
                if (literal?.string !== undefined) imports.push({ path: literal.string, visibility, target: null })
            }
            // Fields, options and oneofs are not type declarations, even when
            // their names are keywords or their option bodies contain braces.
            while (cursor < end && tokens[cursor].value !== ";") {
                if (tokens[cursor].value === "{") {
                    const close = blockEnd(tokens, cursor)
                    if (close < 0) return
                    cursor = close + 1
                    break
                }
                cursor++
            }
            if (tokens[cursor]?.value === ";") cursor++
        }
    }
    walk(0, tokens.length, packageName, true)
    return { types, imports, services }
}

function parseProtoFile(source, file) {
    const tokens = tokenize(source)
    const diagnostics = []
    let packageName = ""
    for (let index = 0; index < tokens.length - 1; index += 1) {
        if (tokens[index].value !== "package") continue
        const parts = []
        for (let cursor = index + 1; cursor < tokens.length && tokens[cursor].value !== ";"; cursor += 1) {
            parts.push(tokens[cursor].value)
        }
        packageName = parts.join("")
        break
    }
    const declarations = declarationRanges(tokens, file, packageName, diagnostics)
    const services = []
    for (const range of declarations.services) {
        const serviceToken = tokens[range.start]
        const name = tokens[range.start + 1].value
        let cursor = range.body + 1
        let depth = 1
        const methods = []
        while (cursor < tokens.length && depth > 0) {
            const token = tokens[cursor]
            if (token.value === "{") {
                depth += 1
                cursor += 1
                continue
            }
            if (token.value === "}") {
                depth -= 1
                cursor += 1
                continue
            }
            if (depth === 1 && token.value === "rpc") {
                const parsed = parseRpc(tokens, cursor)
                if (parsed) {
                    methods.push(parsed.method)
                    cursor = parsed.next
                    continue
                }
                diagnostics.push({ file, line: token.line, message: `unable to parse rpc declaration in ${name}` })
            }
            cursor += 1
        }
        if (depth !== 0) diagnostics.push({ file, line: serviceToken.line, message: `service ${name} has no closing brace` })
        services.push({
            file,
            line: serviceToken.line,
            package: packageName,
            name,
            fullName: packageName ? `${packageName}.${name}` : name,
            methods,
        })
    }
    return { path: file, package: packageName, imports: declarations.imports, types: declarations.types, services, diagnostics }
}

export function readProtoFacts({ repoRoot = process.cwd(), protoRoot = "proto" } = {}) {
    const absoluteRoot = path.resolve(repoRoot)
    const absoluteProto = path.resolve(absoluteRoot, protoRoot)
    const files = protoFiles(absoluteProto).map((filePath) =>
        parseProtoFile(fs.readFileSync(filePath, "utf8"), normalized(path.relative(absoluteRoot, filePath))),
    )
    attachProtoTypeIdentities(files, normalized(path.relative(absoluteRoot, absoluteProto)))
    const services = files.flatMap((file) => file.services)
    services.sort((left, right) => left.fullName.localeCompare(right.fullName) || left.file.localeCompare(right.file))
    return { services, types: files.flatMap((file) => file.types), files, diagnostics: files.flatMap((file) => file.diagnostics) }
}

export function readProtoServiceFacts(options = {}) {
    const result = readProtoFacts(options)
    if (result.diagnostics.length > 0) {
        throw new Error(result.diagnostics.map((entry) => `${entry.file}:${entry.line} ${entry.message}`).join("; "))
    }
    return result.services
}
