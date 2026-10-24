import cQuery from "./c.mjs"
import csharpQuery from "./c-sharp.mjs"
import cppQuery from "./cpp.mjs"
import goQuery from "./go.mjs"
import javaQuery from "./java.mjs"
import javascriptQuery from "./javascript.mjs"
import kotlinQuery from "./kotlin.mjs"
import phpQuery from "./php.mjs"
import pythonQuery from "./python.mjs"
import rubyQuery from "./ruby.mjs"
import rustQuery from "./rust.mjs"
import swiftQuery from "./swift.mjs"
import typescriptQuery from "./typescript.mjs"
import { factQueries } from "./fact-queries.mjs"

export const QUERY_CATEGORIES = Object.freeze(["declarations", "imports", "calls", "writes", "boundaries"])

export const definitionQueries = Object.freeze({
    c: cQuery,
    cpp: cppQuery,
    c_sharp: csharpQuery,
    go: goQuery,
    java: javaQuery,
    javascript: javascriptQuery,
    kotlin: kotlinQuery,
    php: phpQuery,
    python: pythonQuery,
    ruby: rubyQuery,
    rust: rustQuery,
    swift: swiftQuery,
    tsx: typescriptQuery,
    typescript: typescriptQuery,
})

export const languageQuerySources = Object.freeze(
    Object.fromEntries(
        Object.entries(definitionQueries).map(([languageName, declarations]) => [
            languageName,
            Object.freeze({ declarations, ...(factQueries[languageName] ?? {}) }),
        ]),
    ),
)

export function querySourcesForLanguage(languageName) {
    return languageQuerySources[languageName] ?? null
}
