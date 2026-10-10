import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Extract one version section without including its heading or the next version. */
export function extractChangelogSection(source, version, options = {}) {
	const normalizedVersion = version.trim()
	if (!normalizedVersion) throw new Error("Changelog version must not be empty.")
	if (options.allowEmpty && normalizedVersion !== "Unreleased") {
		throw new Error("allowEmpty is supported only for the Unreleased changelog section.")
	}

	const lines = source.replace(/\r\n/g, "\n").split("\n")
	const versionHeading = /^##\s+\[?([^\]\s]+)\]?\s*$/
	const start = lines.findIndex((line) => versionHeading.exec(line)?.[1] === normalizedVersion)
	if (start === -1) throw new Error(`CHANGELOG section '${normalizedVersion}' was not found.`)

	let end = lines.length
	for (let index = start + 1; index < lines.length; index++) {
		if (/^##\s+/.test(lines[index])) {
			end = index
			break
		}
	}

	const body = lines
		.slice(start + 1, end)
		.join("\n")
		.trim()
	if (!body) {
		if (options.allowEmpty) return ""
		throw new Error(`CHANGELOG section '${normalizedVersion}' is empty.`)
	}
	return `${body}\n`
}

async function main() {
	const [sourcePath, version, outputPath, ...flags] = process.argv.slice(2)
	if (!sourcePath || !version || !outputPath) {
		throw new Error("Usage: node scripts/extract-changelog-section.mjs <changelog> <version> <output> [--allow-empty]")
	}
	const unsupportedFlags = flags.filter((flag) => flag !== "--allow-empty")
	if (unsupportedFlags.length > 0) throw new Error(`Unsupported option: ${unsupportedFlags.join(", ")}`)
	const source = await fs.readFile(sourcePath, "utf8")
	await fs.writeFile(
		outputPath,
		extractChangelogSection(source, version, { allowEmpty: flags.includes("--allow-empty") }),
		"utf8",
	)
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
