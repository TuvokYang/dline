// Protocol Buffer service and RPC facts private to this Skill.

import fs from "node:fs"
import path from "node:path"

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
            index += 1
            while (index < source.length) {
                if (source[index] === "\\") {
                    index += 2
                    continue
                }
                if (source[index] === quote) {
                    index += 1
                    break
                }
                if (source[index] === "\n") line += 1
                index += 1
            }
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
    const services = []
    for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index].value !== "service") continue
        const serviceToken = tokens[index]
        const name = tokens[index + 1]?.value
        let cursor = index + 2
        while (cursor < tokens.length && tokens[cursor].value !== "{") cursor += 1
        if (!name || tokens[cursor]?.value !== "{") {
            diagnostics.push({ file, line: serviceToken.line, message: "service declaration is missing a name or body" })
            continue
        }
        cursor += 1
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
        index = cursor - 1
    }
    return { services, diagnostics }
}

export function readProtoFacts({ repoRoot = process.cwd(), protoRoot = "proto" } = {}) {
    const absoluteRoot = path.resolve(repoRoot)
    const absoluteProto = path.resolve(absoluteRoot, protoRoot)
    const services = []
    const diagnostics = []
    for (const filePath of protoFiles(absoluteProto)) {
        const result = parseProtoFile(fs.readFileSync(filePath, "utf8"), normalized(path.relative(absoluteRoot, filePath)))
        services.push(...result.services)
        diagnostics.push(...result.diagnostics)
    }
    services.sort((left, right) => left.fullName.localeCompare(right.fullName) || left.file.localeCompare(right.file))
    return { services, diagnostics }
}

export function readProtoServiceFacts(options = {}) {
    const result = readProtoFacts(options)
    if (result.diagnostics.length > 0) {
        throw new Error(result.diagnostics.map((entry) => `${entry.file}:${entry.line} ${entry.message}`).join("; "))
    }
    return result.services
}
