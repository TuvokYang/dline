import { validateSemanticInputDocument } from "@shared/input-semantics/validation"
import { String } from "@shared/proto/dline/common"
import { PlanActMode } from "@shared/proto/dline/state"
import { NewTaskRequest } from "@shared/proto/dline/task"
import { fromProtoSemanticInputDocument } from "@shared/proto-conversions/input-semantics/document"
import { Settings } from "@shared/storage/state-keys"
import { DEFAULT_BROWSER_SETTINGS } from "../../../shared/BrowserSettings"
import { Controller } from ".."
import { inputSemanticCatalogService } from "../slash/input-semantic-catalog"

/**
 * Creates a new task with the given text and optional images
 * @param controller The controller instance
 * @param request The new task request containing text and optional images, and optional task settings
 * @returns Empty response
 */
export async function newTask(controller: Controller, request: NewTaskRequest): Promise<String> {
	const convertPlanActMode = (mode: PlanActMode): string => {
		return mode === PlanActMode.PLAN ? "plan" : "act"
	}

	// Proto-generated taskSettings may not include all runtime fields;
	// use unknown→Record for fields not in the generated type.
	const filteredTaskSettings: Partial<Settings> = Object.fromEntries(
		Object.entries({
			...request.taskSettings,
			...(request.taskSettings?.autoApprovalSettings && {
				autoApprovalSettings: (() => {
					// Merge with global settings to ensure complete settings for new task
					const globalSettings = controller.stateManager.getGlobalSettingsKey("autoApprovalSettings")
					const incomingSettings = request.taskSettings.autoApprovalSettings
					return {
						...globalSettings,
						...(incomingSettings.version !== undefined && { version: incomingSettings.version }),
						...(incomingSettings.enableNotifications !== undefined && {
							enableNotifications: incomingSettings.enableNotifications,
						}),
						actions: {
							...globalSettings.actions,
							...(incomingSettings.actions
								? Object.fromEntries(Object.entries(incomingSettings.actions).filter(([_, v]) => v !== undefined))
								: {}),
						},
					}
				})(),
			}),
			...(request.taskSettings?.browserSettings && {
				browserSettings: {
					viewport: request.taskSettings.browserSettings.viewport || DEFAULT_BROWSER_SETTINGS.viewport,
					remoteBrowserHost: request.taskSettings.browserSettings.remoteBrowserHost,
					remoteBrowserEnabled: request.taskSettings.browserSettings.remoteBrowserEnabled,
					chromeExecutablePath: request.taskSettings.browserSettings.chromeExecutablePath,
					disableToolUse: request.taskSettings.browserSettings.disableToolUse,
					customArgs: request.taskSettings.browserSettings.customArgs,
				},
			}),
			...(request.taskSettings?.mode !== undefined && {
				mode: convertPlanActMode(request.taskSettings.mode),
			}),
			...(request.taskSettings?.customPrompt === "compact" && {
				customPrompt: "compact",
			}),
			...(typeof request.taskSettings?.planModeProfile === "string" && {
				planModeProfile: request.taskSettings.planModeProfile,
			}),
			...(typeof request.taskSettings?.actModeProfile === "string" && {
				actModeProfile: request.taskSettings.actModeProfile,
			}),
		}).filter(([_, value]) => value !== undefined),
	)

	// A structured submission is authoritative (WS-041 spec, structured submission
	// protocol §2). An undecodable one is refused rather than read as legacy text,
	// because the legacy reading is exactly what the document was sent to prevent.
	let semanticInput: import("@shared/input-semantics/document").SemanticInputDocument | undefined
	if (request.semanticInput) {
		const decoded = fromProtoSemanticInputDocument(request.semanticInput)
		if (!decoded.ok) throw new Error(`New task input was rejected: ${decoded.diagnostic.code}`)
		// Admission itself runs in the background task, where a refusal could no
		// longer hand the draft back. Refuse here what it would certainly refuse,
		// so the caller still owns the draft and can restore it.
		const structural = validateSemanticInputDocument(decoded.document)
		if (structural.length > 0) throw new Error(`New task input was rejected: ${structural[0].code}`)
		// `String` here is the proto message type, so the revision is formatted directly.
		const currentRevision = `${inputSemanticCatalogService(controller).current().revision}`
		if (decoded.document.catalogRevision !== currentRevision) {
			throw new Error("New task input was rejected: semantic_input_catalog_stale")
		}
		semanticInput = decoded.document
	}
	const taskId = await controller.initTask(request.text, request.images, request.files, undefined, filteredTaskSettings, {
		startInBackground: true,
		...(semanticInput === undefined ? {} : { semanticInput }),
	})
	return String.create({ value: taskId || "" })
}
