#!/usr/bin/env node

import chalk from "chalk"
import { execFileSync } from "child_process"
import fsSync from "fs"
import * as fs from "fs/promises"
import { globby } from "globby"
import { createRequire } from "module"
import * as path from "path"
import { rmrf, writeFileWithMkdirs } from "./file-utils.mjs"
import { main as generateHostBridgeClient } from "./generate-host-bridge-client.mjs"
import { main as generateProtoBusSetup } from "./generate-protobus-setup.mjs"

const require = createRequire(import.meta.url)
const isWindows = process.platform === "win32"
const PROTOC_PACKAGE_DIR = path.dirname(require.resolve("protoc/package.json"))
const PROTOC_ASSETS = JSON.parse(fsSync.readFileSync(path.join(PROTOC_PACKAGE_DIR, "assets.json"), "utf8"))
const protocAsset = PROTOC_ASSETS.find((asset) => asset.platform === process.platform && asset.arch === process.arch)
const PACKAGE_PROTOC = protocAsset ? path.join(PROTOC_PACKAGE_DIR, "bin", protocAsset.executable) : undefined
// Legacy compatibility: some older/local Windows setups provision protoc into tmp-protoc.
const LEGACY_WINDOWS_PROTOC = path.resolve("tmp-protoc/bin/protoc.exe")
const PROTOC = isWindows && fsSync.existsSync(LEGACY_WINDOWS_PROTOC) ? LEGACY_WINDOWS_PROTOC : PACKAGE_PROTOC

if (!PROTOC || !fsSync.existsSync(PROTOC)) {
	const supportedPlatforms = PROTOC_ASSETS.map((asset) => `${asset.platform}/${asset.arch}`).join(", ")
	console.error(
		chalk.red(
			`protoc is unavailable for ${process.platform}/${process.arch}. Supported package targets: ${supportedPlatforms}.`,
		),
	)
	process.exit(1)
}

const PROTO_DIR = path.resolve("proto")
const TS_OUT_DIR = path.resolve("src/shared/proto")
const GRPC_JS_OUT_DIR = path.resolve("src/generated/grpc-js")
const NICE_JS_OUT_DIR = path.resolve("src/generated/nice-grpc")
const DESCRIPTOR_OUT_DIR = path.resolve("dist-standalone/proto")

const TS_PROTO_PLUGIN = isWindows
	? path.resolve("node_modules/.bin/protoc-gen-ts_proto.cmd") // Use the .bin directory path for Windows
	: require.resolve("ts-proto/protoc-gen-ts_proto")

const TS_PROTO_OPTIONS = [
	"env=both",
	"esModuleInterop=true",
	"outputServices=generic-definitions", // output generic ServiceDefinitions
	"outputIndex=true", // output an index file for each package which exports all protos in the package.
	"useOptionals=none", // scalar and message fields are required unless they are marked as optional.
	"useDate=false", // Timestamp fields will not be automatically converted to Date.
]

async function main() {
	await cleanup()
	await compileProtos()
	await postProcessModels()
	await generateBarrelFiles()
	await generateProtoBusSetup()
	await generateHostBridgeClient()
}

/** Generate barrel index.ts files so that @/shared/proto/dline resolves correctly. */
async function generateBarrelFiles() {
	// src/shared/proto/dline/index.ts → re-exports index.dline.ts
	const dlineBarrel = `// GENERATED CODE -- DO NOT EDIT!
// Barrel file for @/shared/proto/dline → re-exports index.dline.ts
export * from "../index.dline"
`
	const dlineBarrelPath = path.join(TS_OUT_DIR, "dline", "index.ts")
	await writeFileWithMkdirs(dlineBarrelPath, dlineBarrel)
	console.log(chalk.green(`Generated ${dlineBarrelPath}`))

	// src/shared/proto/dline/host/index.ts → re-exports index.dline.host.ts
	const hostBarrel = `// GENERATED CODE -- DO NOT EDIT!
// Barrel file for @/shared/proto/dline/host → re-exports index.dline.host.ts
export * from "../../index.dline.host"
`
	const hostBarrelPath = path.join(TS_OUT_DIR, "dline", "host", "index.ts")
	await writeFileWithMkdirs(hostBarrelPath, hostBarrel)
	console.log(chalk.green(`Generated ${hostBarrelPath}`))
}

async function compileProtos() {
	console.log(chalk.bold.blue("Compiling Protocol Buffers..."))

	// Create output directories if they don't exist
	for (const dir of [TS_OUT_DIR, GRPC_JS_OUT_DIR, NICE_JS_OUT_DIR, DESCRIPTOR_OUT_DIR]) {
		await fs.mkdir(dir, { recursive: true })
	}

	// Process all proto files
	const protoFiles = await globby("**/*.proto", { cwd: PROTO_DIR, realpath: true })
	console.log(chalk.cyan(`Processing ${protoFiles.length} proto files from`), PROTO_DIR)

	tsProtoc(TS_OUT_DIR, protoFiles, TS_PROTO_OPTIONS)
	// grpc-js is used to generate service impls for the ProtoBus service.
	tsProtoc(GRPC_JS_OUT_DIR, protoFiles, ["outputServices=grpc-js", ...TS_PROTO_OPTIONS])
	// nice-js is used for the Host Bridge client impls because it uses promises.
	tsProtoc(NICE_JS_OUT_DIR, protoFiles, ["outputServices=nice-grpc,useExactTypes=false", ...TS_PROTO_OPTIONS])

	const descriptorFile = path.join(DESCRIPTOR_OUT_DIR, "descriptor_set.pb")
	const descriptorProtocArgs = [
		`--proto_path=${PROTO_DIR}`,
		`--descriptor_set_out=${descriptorFile}`,
		"--include_imports",
		...protoFiles,
	]
	try {
		log_verbose(chalk.cyan("Generating descriptor set..."))
		log_verbose(`${PROTOC} ${descriptorProtocArgs.join(" ")}`)
		execFileSync(PROTOC, descriptorProtocArgs, { stdio: "inherit" })
	} catch (error) {
		console.error(chalk.red("Error generating descriptor set for proto file:"), error)
		process.exit(1)
	}

	log_verbose(chalk.green("Protocol Buffer code generation completed successfully."))
	log_verbose(chalk.green(`TypeScript files generated in: ${TS_OUT_DIR}`))
}

function tsProtoc(outDir, protoFiles, protoOptions) {
	const args = [
		`--proto_path=${PROTO_DIR}`,
		`--plugin=protoc-gen-ts_proto=${TS_PROTO_PLUGIN}`,
		`--ts_proto_out=${outDir}`,
		`--ts_proto_opt=${protoOptions.join(",")}`,
		...protoFiles,
	]
	try {
		log_verbose(chalk.cyan(`Generating TypeScript code in ${outDir} for:\n${protoFiles.join("\n")}...`))
		log_verbose(`${PROTOC} ${args.join(" ")}`)
		execFileSync(PROTOC, args, { stdio: "inherit" })
	} catch (error) {
		console.error(chalk.red("Error generating TypeScript for proto files:"), error)
		process.exit(1)
	}
}

const OPTIONAL_REPEATED_MODEL_FIELDS = [
	{ interfaceName: "ThinkingConfig", fieldName: "effortLevels" },
	{ interfaceName: "ModelCapabilities", fieldName: "contextWindowTiers" },
	{ interfaceName: "ModelCapabilities", fieldName: "tools" },
	{ interfaceName: "ModelPricing", fieldName: "tiers" },
	{ interfaceName: "ModelPricing", fieldName: "thinkingOutputPriceTiers" },
	{ interfaceName: "ModelInfo", fieldName: "apiFormats" },
]

function makeOptionalRepeatedField(content, { interfaceName, fieldName }) {
	let changed = false
	const interfacePattern = new RegExp(`(export interface ${interfaceName} \\{[^}]*?)${fieldName}: ([A-Za-z0-9_.]+)\\[\\];`, "s")
	if (interfacePattern.test(content)) {
		content = content.replace(interfacePattern, `$1${fieldName}?: $2[];`)
		changed = true
	}

	const blockStart = content.indexOf(`function createBase${interfaceName}()`)
	if (blockStart < 0) return { content, changed }
	const nextBlockStart = content.indexOf("\nfunction createBase", blockStart + 1)
	const blockEnd = nextBlockStart < 0 ? content.length : nextBlockStart
	let block = content.slice(blockStart, blockEnd)
	const originalBlock = block

	block = block.replaceAll(`${fieldName}: [],`, `${fieldName}: undefined,`)
	block = block.replaceAll(`for (const v of message.${fieldName}) {`, `for (const v of message.${fieldName} ?? []) {`)
	block = block.replace(new RegExp(`message\\.${fieldName}!?\\.push\\(`, "g"), `(message.${fieldName} ??= []).push(`)
	block = block.replace(
		new RegExp(`(${fieldName}:\\s*globalThis\\.Array\\.isArray\\([\\s\\S]*?)\\s*:\\s*\\[\\](,)`, "g"),
		"$1 : undefined$2",
	)
	block = block.replace(
		new RegExp(`(message\\.${fieldName}\\s*=\\s*object\\.${fieldName}\\?\\.map\\([\\s\\S]*?\\))\\s*\\|\\|\\s*\\[\\];`, "g"),
		"$1 || undefined;",
	)
	// Preserve the distinction between an omitted optional array and an explicit empty override.
	block = block.replace(
		new RegExp(`if \\(message\\.${fieldName}\\?\\.length\\) \\{`, "g"),
		`if (message.${fieldName} !== undefined) {`,
	)

	if (block !== originalBlock) {
		content = `${content.slice(0, blockStart)}${block}${content.slice(blockEnd)}`
		changed = true
	}
	return { content, changed }
}

/**
 * Post-process generated model metadata to make selected repeated array fields optional (?).
 * Proto3 repeated fields cannot be marked optional, so we fix the TS output.
 * Also fixes serialization code to handle possibly-undefined arrays.
 */
async function postProcessModels() {
	const modelsFiles = [
		path.join(TS_OUT_DIR, "dline", "models.ts"),
		path.join(GRPC_JS_OUT_DIR, "dline", "models.ts"),
		path.join(NICE_JS_OUT_DIR, "dline", "models.ts"),
		path.join(TS_OUT_DIR, "dline", "models", "metadata.ts"),
		path.join(GRPC_JS_OUT_DIR, "dline", "models", "metadata.ts"),
		path.join(NICE_JS_OUT_DIR, "dline", "models", "metadata.ts"),
	]

	for (const filePath of modelsFiles) {
		if (!fsSync.existsSync(filePath)) {
			console.log(chalk.yellow(`Skipping post-process: ${filePath} not found`))
			continue
		}
		let content = await fs.readFile(filePath, "utf-8")
		let changed = false
		for (const field of OPTIONAL_REPEATED_MODEL_FIELDS) {
			const result = makeOptionalRepeatedField(content, field)
			content = result.content
			changed ||= result.changed
		}

		// 1. Make effortLevels optional in ThinkingConfig interface
		if (content.includes("  effortLevels: string[];")) {
			content = content.replace(
				/(export interface ThinkingConfig \{[^}]*?)effortLevels: string\[\];/s,
				"$1effortLevels?: string[];",
			)
			changed = true
		}

		// 2. Make contextWindowTiers optional in the ModelCapabilities interface
		if (/(export interface ModelCapabilities \{[^}]*?)contextWindowTiers: ContextWindowTier\[\];/s.test(content)) {
			content = content.replace(
				/(export interface ModelCapabilities \{[^}]*?)contextWindowTiers: ContextWindowTier\[\];/s,
				"$1contextWindowTiers?: ContextWindowTier[];",
			)
			changed = true
		}

		// 3. Make tiers and thinkingOutputPriceTiers optional in the ModelPricing interface
		if (/(export interface ModelPricing \{[^}]*?)tiers: PricingTier\[\];/s.test(content)) {
			content = content.replace(
				/(export interface ModelPricing \{[^}]*?)tiers: PricingTier\[\];/s,
				"$1tiers?: PricingTier[];",
			)
			changed = true
		}
		if (/(export interface ModelPricing \{[^}]*?)thinkingOutputPriceTiers: ThinkingOutputPriceTier\[\];/s.test(content)) {
			content = content.replace(
				/(export interface ModelPricing \{[^}]*?)thinkingOutputPriceTiers: ThinkingOutputPriceTier\[\];/s,
				"$1thinkingOutputPriceTiers?: ThinkingOutputPriceTier[];",
			)
			changed = true
		}

		// 4. Fix encode/decode serialization code that accesses effortLevels directly
		if (content.includes("for (const v of message.effortLevels) {")) {
			content = content.replaceAll(
				"for (const v of message.effortLevels) {",
				"for (const v of message.effortLevels ?? []) {",
			)
			changed = true
		}
		if (content.includes("message.effortLevels.push(")) {
			content = content.replaceAll("message.effortLevels.push(", "message.effortLevels!.push(")
			changed = true
		}

		// 5. Fix encode/decode serialization code that accesses contextWindowTiers directly
		if (content.includes("for (const v of message.contextWindowTiers) {")) {
			content = content.replaceAll(
				"for (const v of message.contextWindowTiers) {",
				"for (const v of message.contextWindowTiers ?? []) {",
			)
			changed = true
		}
		if (content.includes("message.contextWindowTiers.push(")) {
			content = content.replaceAll("message.contextWindowTiers.push(", "message.contextWindowTiers!.push(")
			changed = true
		}

		// 6. Fix encode/decode serialization code that accesses pricing tiers directly
		// for (const v of message.tiers) { → for (const v of message.tiers ?? []) {
		if (content.includes("for (const v of message.tiers) {")) {
			content = content.replaceAll("for (const v of message.tiers) {", "for (const v of message.tiers ?? []) {")
			changed = true
		}
		if (content.includes("for (const v of message.thinkingOutputPriceTiers) {")) {
			content = content.replaceAll(
				"for (const v of message.thinkingOutputPriceTiers) {",
				"for (const v of message.thinkingOutputPriceTiers ?? []) {",
			)
			changed = true
		}
		// message.tiers.push( → message.tiers!.push(
		if (content.includes("message.tiers.push(")) {
			content = content.replaceAll("message.tiers.push(", "message.tiers!.push(")
			changed = true
		}
		if (content.includes("message.thinkingOutputPriceTiers.push(")) {
			content = content.replaceAll("message.thinkingOutputPriceTiers.push(", "message.thinkingOutputPriceTiers!.push(")
			changed = true
		}

		if (changed) {
			await fs.writeFile(filePath, content, "utf-8")
			console.log(chalk.green(`Post-processed optional model metadata arrays in: ${filePath}`))
		}
	}
}

async function cleanup() {
	// Clean up existing generated files
	log_verbose(chalk.cyan("Cleaning up existing generated TypeScript files..."))
	await rmrf(TS_OUT_DIR)
	await rmrf("src/generated")

	// Clean up generated files that were moved.
	await rmrf("src/standalone/services/host-grpc-client.ts")
	await rmrf("src/standalone/server-setup.ts")
	await rmrf("src/hosts/vscode/host-grpc-service-config.ts")
	await rmrf("src/core/controller/grpc-service-config.ts")
	const oldhostbridgefiles = [
		"src/hosts/vscode/workspace/methods.ts",
		"src/hosts/vscode/workspace/index.ts",
		"src/hosts/vscode/diff/methods.ts",
		"src/hosts/vscode/diff/index.ts",
		"src/hosts/vscode/env/methods.ts",
		"src/hosts/vscode/env/index.ts",
		"src/hosts/vscode/window/methods.ts",
		"src/hosts/vscode/window/index.ts",
		"src/hosts/vscode/watch/methods.ts",
		"src/hosts/vscode/watch/index.ts",
		"src/hosts/vscode/uri/methods.ts",
		"src/hosts/vscode/uri/index.ts",
	]
	const oldprotobusfiles = [
		"src/core/controller/account/index.ts",
		"src/core/controller/account/methods.ts",
		"src/core/controller/browser/index.ts",
		"src/core/controller/browser/methods.ts",
		"src/core/controller/checkpoints/index.ts",
		"src/core/controller/checkpoints/methods.ts",
		"src/core/controller/file/index.ts",
		"src/core/controller/file/methods.ts",
		"src/core/controller/mcp/index.ts",
		"src/core/controller/mcp/methods.ts",
		"src/core/controller/models/index.ts",
		"src/core/controller/models/methods.ts",
		"src/core/controller/slash/index.ts",
		"src/core/controller/slash/methods.ts",
		"src/core/controller/state/index.ts",
		"src/core/controller/state/methods.ts",
		"src/core/controller/task/index.ts",
		"src/core/controller/task/methods.ts",
		"src/core/controller/ui/index.ts",
		"src/core/controller/ui/methods.ts",
		"src/core/controller/web/index.ts",
		"src/core/controller/web/methods.ts",
	]
	for (const file of [...oldhostbridgefiles, ...oldprotobusfiles]) {
		await rmrf(file)
	}
}

function log_verbose(s) {
	if (process.argv.includes("-v") || process.argv.includes("--verbose")) {
		console.log(s)
	}
}

// Run the main function
main().catch((error) => {
	console.error(chalk.red("Error:"), error)
	process.exit(1)
})
