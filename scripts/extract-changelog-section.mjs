import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

/** Extract one version section without including its heading or the next version. */
export function extractChangelogSection(source, version) {
	const normalizedVersion = version.trim()
	if (!normalizedVersion) throw new Error("Changelog version must not be empty.")

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
	if (!body) throw new Error(`CHANGELOG section '${normalizedVersion}' is empty.`)
	return `${body}\n`
}

async function main() {
	const [sourcePath, version, outputPath] = process.argv.slice(2)
	if (!sourcePath || !version || !outputPath) {
		throw new Error("Usage: node scripts/extract-changelog-section.mjs <changelog> <version> <output>")
	}
	const source = await fs.readFile(sourcePath, "utf8")
	await fs.writeFile(outputPath, extractChangelogSection(source, version), "utf8")
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ""
if (invokedPath === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
