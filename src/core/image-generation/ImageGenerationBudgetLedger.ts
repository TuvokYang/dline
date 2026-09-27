import { writeJsonAtomic } from "@shared/storage/atomic-file"
import fs from "fs/promises"
import path from "path"
import { ImageGenerationError } from "./contracts"

const BUDGET_LEDGER_SCHEMA_VERSION = 1 as const

interface ImageGenerationBudgetReservation {
	requestId: string
	providerId: string
	modelId: string
	estimatedCostUsd: number
	createdAtMs: number
	status: "reserved" | "settled"
	settledAtMs?: number
}

interface ImageGenerationBudgetLedgerV1 {
	schemaVersion: typeof BUDGET_LEDGER_SCHEMA_VERSION
	taskId: string
	reservations: ImageGenerationBudgetReservation[]
}

export interface ImageGenerationBudgetReservationInput {
	requestId: string
	providerId: string
	modelId: string
	estimatedCostUsd: number
	limitUsd: number
}

export interface ImageGenerationBudgetLedgerOptions {
	taskId: string
	taskDirectory: string
	now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function invalidLedger(message: string, cause?: unknown): ImageGenerationError {
	return new ImageGenerationError({
		code: "invalid_request",
		message,
		retryable: false,
		providerCode: cause instanceof Error ? cause.name : undefined,
	})
}

export class ImageGenerationBudgetLedger {
	private readonly taskId: string
	private readonly taskDirectory: string
	private readonly artifactDirectory: string
	private readonly ledgerPath: string
	private readonly now: () => number
	private operationTail: Promise<void> = Promise.resolve()

	constructor(options: ImageGenerationBudgetLedgerOptions) {
		if (!options.taskId.trim()) throw invalidLedger("Image generation budget task ID must not be empty.")
		if (!path.isAbsolute(options.taskDirectory)) {
			throw invalidLedger("Image generation budget task directory must be absolute.")
		}
		this.taskId = options.taskId
		this.taskDirectory = path.resolve(options.taskDirectory)
		this.artifactDirectory = path.join(this.taskDirectory, "artifacts")
		this.ledgerPath = path.join(this.artifactDirectory, "image-generation-budget.json")
		this.now = options.now ?? Date.now
	}

	async reserve(input: ImageGenerationBudgetReservationInput): Promise<void> {
		await this.runExclusive(async () => {
			this.validateReservationInput(input)
			await this.ensureManagedDirectory()
			const ledger = await this.loadLedger()
			const existing = ledger.reservations.find((reservation) => reservation.requestId === input.requestId)
			if (existing) {
				if (
					existing.providerId !== input.providerId ||
					existing.modelId !== input.modelId ||
					existing.estimatedCostUsd !== input.estimatedCostUsd
				) {
					throw invalidLedger("Image generation request ID is already reserved with different cost metadata.")
				}
				throw invalidLedger("Image generation request ID has already been used.")
			}

			const spentUsd = ledger.reservations.reduce((total, reservation) => total + reservation.estimatedCostUsd, 0)
			if (spentUsd + input.estimatedCostUsd > input.limitUsd) {
				throw new ImageGenerationError({
					code: "budget_exceeded",
					message: "The image generation request would exceed the task budget.",
					retryable: false,
				})
			}

			ledger.reservations.push({
				requestId: input.requestId,
				providerId: input.providerId,
				modelId: input.modelId,
				estimatedCostUsd: input.estimatedCostUsd,
				createdAtMs: this.now(),
				status: "reserved",
			})
			await writeJsonAtomic(this.ledgerPath, ledger)
		})
	}

	async settle(requestId: string): Promise<void> {
		await this.runExclusive(async () => {
			await this.ensureManagedDirectory()
			const ledger = await this.loadLedger()
			const reservation = ledger.reservations.find((entry) => entry.requestId === requestId)
			if (!reservation) throw invalidLedger("Image generation budget reservation was not found for settlement.")
			if (reservation.status === "settled") return
			reservation.status = "settled"
			reservation.settledAtMs = this.now()
			await writeJsonAtomic(this.ledgerPath, ledger)
		})
	}

	async release(requestId: string): Promise<void> {
		await this.runExclusive(async () => {
			await this.ensureManagedDirectory()
			const ledger = await this.loadLedger()
			const index = ledger.reservations.findIndex((entry) => entry.requestId === requestId)
			if (index < 0 || ledger.reservations[index].status === "settled") return
			ledger.reservations.splice(index, 1)
			await writeJsonAtomic(this.ledgerPath, ledger)
		})
	}

	async getSpentUsd(): Promise<number> {
		return this.runExclusive(async () => {
			await this.ensureManagedDirectory()
			const ledger = await this.loadLedger()
			return ledger.reservations.reduce(
				(total, reservation) => total + (reservation.status === "settled" ? reservation.estimatedCostUsd : 0),
				0,
			)
		})
	}

	private validateReservationInput(input: ImageGenerationBudgetReservationInput): void {
		if (!input.requestId.trim() || !input.providerId.trim() || !input.modelId.trim()) {
			throw invalidLedger("Image generation budget reservation identity must not be empty.")
		}
		if (!isFiniteNonNegative(input.estimatedCostUsd) || !isFiniteNonNegative(input.limitUsd)) {
			throw invalidLedger("Image generation budget values must be finite non-negative numbers.")
		}
	}

	private async ensureManagedDirectory(): Promise<void> {
		await fs.mkdir(this.taskDirectory, { recursive: true })
		await this.assertDirectory(this.taskDirectory)
		await fs.mkdir(this.artifactDirectory, { recursive: true })
		await this.assertDirectory(this.artifactDirectory)
	}

	private async assertDirectory(directoryPath: string): Promise<void> {
		const stats = await fs.lstat(directoryPath)
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw invalidLedger("Image generation budget directory is not a regular directory.")
		}
	}

	private async loadLedger(): Promise<ImageGenerationBudgetLedgerV1> {
		let parsed: unknown
		try {
			parsed = JSON.parse(await fs.readFile(this.ledgerPath, "utf8"))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { schemaVersion: BUDGET_LEDGER_SCHEMA_VERSION, taskId: this.taskId, reservations: [] }
			}
			throw invalidLedger("Image generation budget ledger could not be read.", error)
		}
		if (
			!isRecord(parsed) ||
			parsed.schemaVersion !== BUDGET_LEDGER_SCHEMA_VERSION ||
			parsed.taskId !== this.taskId ||
			!Array.isArray(parsed.reservations)
		) {
			throw invalidLedger("Image generation budget ledger is invalid or unsupported.")
		}
		const requestIds = new Set<string>()
		const reservations = parsed.reservations.map((value): ImageGenerationBudgetReservation => {
			const settledAtMs = isRecord(value) ? value.settledAtMs : undefined
			if (
				!isRecord(value) ||
				typeof value.requestId !== "string" ||
				typeof value.providerId !== "string" ||
				typeof value.modelId !== "string" ||
				!isFiniteNonNegative(value.estimatedCostUsd) ||
				typeof value.createdAtMs !== "number" ||
				!Number.isSafeInteger(value.createdAtMs) ||
				value.createdAtMs < 0 ||
				requestIds.has(value.requestId) ||
				(value.status !== undefined && value.status !== "reserved" && value.status !== "settled") ||
				(settledAtMs !== undefined &&
					(typeof settledAtMs !== "number" || !Number.isSafeInteger(settledAtMs) || settledAtMs < 0))
			) {
				throw invalidLedger("Image generation budget ledger contains an invalid reservation.")
			}
			requestIds.add(value.requestId)
			return {
				requestId: value.requestId,
				providerId: value.providerId,
				modelId: value.modelId,
				estimatedCostUsd: value.estimatedCostUsd,
				createdAtMs: value.createdAtMs,
				status: value.status === "reserved" ? "reserved" : "settled",
				settledAtMs: typeof settledAtMs === "number" ? settledAtMs : undefined,
			}
		})
		return { schemaVersion: BUDGET_LEDGER_SCHEMA_VERSION, taskId: this.taskId, reservations }
	}

	private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		let release: (() => void) | undefined
		const previous = this.operationTail
		this.operationTail = new Promise<void>((resolve) => {
			release = resolve
		})
		await previous
		try {
			return await operation()
		} finally {
			release?.()
		}
	}
}
