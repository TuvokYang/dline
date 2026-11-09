// Adapts canonical repository code providers into one immutable snapshot for the target Workstream.

import path from "node:path"

import { readGeneratedProvenance } from "./generated-provenance.mjs"
import { readProtoFacts } from "./proto-facts.mjs"

function diagnostic(provider, error) {
    return Object.freeze({ provider, message: error?.message ?? String(error) })
}

export function createCodeFactSnapshot({ repoRoot = process.cwd(), protoRoot = "proto", generatedArtifacts = [] } = {}) {
    const absoluteRoot = path.resolve(repoRoot)
    const diagnostics = []
    let protoServices = []
    let protoTypes = []
    let protoFiles = []
    let generated = []

    try {
        const proto = readProtoFacts({ repoRoot: absoluteRoot, protoRoot })
        if (proto.diagnostics.length > 0)
            throw new Error(proto.diagnostics.map((entry) => `${entry.file}:${entry.line} ${entry.message}`).join("; "))
        protoServices = proto.services
        protoTypes = proto.types
        protoFiles = proto.files.map(({ path, package: packageName, imports }) => ({ path, package: packageName, imports }))
    } catch (error) {
        diagnostics.push(diagnostic("proto", error))
    }

    try {
        generated = readGeneratedProvenance({ repoRoot: absoluteRoot, artifacts: generatedArtifacts })
    } catch (error) {
        diagnostics.push(diagnostic("generated", error))
    }

    return Object.freeze({
        imports: Object.freeze([]),
        protoServices: Object.freeze(protoServices),
        protoTypes: Object.freeze(protoTypes),
        protoFiles: Object.freeze(protoFiles),
        generated: Object.freeze(generated),
        diagnostics: Object.freeze(diagnostics),
    })
}
