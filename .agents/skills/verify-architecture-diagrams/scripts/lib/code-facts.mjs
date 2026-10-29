// Adapts canonical repository code providers into one immutable snapshot for the target Workstream.

import path from "node:path"

import { readGeneratedProvenance } from "./generated-provenance.mjs"
import { readProtoServiceFacts } from "./proto-facts.mjs"

function diagnostic(provider, error) {
    return Object.freeze({ provider, message: error?.message ?? String(error) })
}

export function createCodeFactSnapshot({ repoRoot = process.cwd(), protoRoot = "proto", generatedArtifacts = [] } = {}) {
    const absoluteRoot = path.resolve(repoRoot)
    const diagnostics = []
    let protoServices = []
    let generated = []

    try {
        protoServices = readProtoServiceFacts({ repoRoot: absoluteRoot, protoRoot })
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
        generated: Object.freeze(generated),
        diagnostics: Object.freeze(diagnostics),
    })
}
