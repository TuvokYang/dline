import { EmptyRequest, StringRequest } from "@shared/proto/dline/common"
import {
	AvailableToolsResponse,
	DeleteSubagentRequest,
	SubagentInfo,
	ToolGroup,
	UpdateSubagentConfigRequest,
} from "@shared/proto/dline/file"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { ChevronDownIcon, ChevronRightIcon, PenIcon, Trash2Icon } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { nativeSelectOptionStyle, nativeSelectStyle } from "@/components/ui/native-select-theme"
import { Switch } from "@/components/ui/switch"
import { FileServiceClient } from "@/services/grpc-client"

interface SubagentRowProps {
	agent: SubagentInfo
	isGlobal: boolean
	onToggle: (path: string, enabled: boolean) => Promise<void> | void
	onDelete: () => void
}

/**
 * Subagent row with expandable tool/skill selection.
 * Tools are loaded from getAvailableTools RPC and grouped by Read-only/Write.
 */
const SubagentRow: React.FC<SubagentRowProps> = ({ agent, isGlobal, onToggle, onDelete }) => {
	const [expanded, setExpanded] = useState(false)
	const [toolGroups, setToolGroups] = useState<ToolGroup[]>([])
	const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set(agent.tools))
	const [profiles, setProfiles] = useState<ApiProfile[]>([])
	const [selectedProfile, setSelectedProfile] = useState<string>(agent.profile || "")
	const [profilesLoading, setProfilesLoading] = useState(false)
	const [toolsLoading, setToolsLoading] = useState(false)
	const [pendingEnabled, setPendingEnabled] = useState<boolean | undefined>(undefined)
	const toggleIntentRef = useRef(0)
	const displayedEnabled = pendingEnabled ?? agent.enabled

	useEffect(() => {
		if (pendingEnabled === agent.enabled) setPendingEnabled(undefined)
	}, [agent.enabled, pendingEnabled])

	// Load available tools and profiles when expanded
	useEffect(() => {
		if (!expanded) return

		let cancelled = false

		setToolsLoading(true)
		FileServiceClient.getAvailableTools({} as EmptyRequest)
			.then((response: AvailableToolsResponse) => {
				if (!cancelled) setToolGroups(response.groups || [])
			})
			.catch((err) => console.error("Failed to load available tools:", err))
			.finally(() => {
				if (!cancelled) setToolsLoading(false)
			})

		setProfilesLoading(true)
		FileServiceClient.getApiProfiles({} as EmptyRequest)
			.then((response) => {
				if (!cancelled) {
					setProfiles(
						(response.profiles || []).filter((profile) => profile.enabled && profile.usedFor.includes("subagents")),
					)
				}
			})
			.catch((err) => console.error("Failed to load available profiles:", err))
			.finally(() => {
				if (!cancelled) setProfilesLoading(false)
			})

		return () => {
			cancelled = true
		}
	}, [expanded])

	// Names the backend marks as always granted, read from the catalogue so the
	// Webview never has to name a specific tool itself.
	const requiredToolNames = new Set(
		toolGroups.flatMap((group) => group.tools.filter((tool) => tool.required).map((tool) => tool.name)),
	)

	const toggleTool = (toolName: string, required?: boolean) => {
		// A required tool is granted by policy regardless of selection. Letting it
		// be unchecked would show a state the backend never honours.
		if (required) return

		const next = new Set(selectedTools)
		if (next.has(toolName)) {
			next.delete(toolName)
		} else {
			next.add(toolName)
		}
		setSelectedTools(next)
		FileServiceClient.updateSubagentConfig(
			UpdateSubagentConfigRequest.create({
				subagentPath: agent.path,
				// Required tools stay checked in the UI but are not part of the
				// saved selection: the runtime grants them regardless, and storing
				// one would present a guarantee as an editable preference.
				tools: Array.from(next).filter((tool) => !requiredToolNames.has(tool)),
				replaceTools: true,
			}),
		).catch((err) => console.error("Failed to save tools:", err))
	}

	const handleProfileChange = (profile: string) => {
		setSelectedProfile(profile)
		FileServiceClient.updateSubagentConfig(
			UpdateSubagentConfigRequest.create({
				subagentPath: agent.path,
				profile: profile || "",
			}),
		).catch((err) => console.error("Failed to save profile:", err))
	}

	const handleToggle = () => {
		const nextEnabled = !displayedEnabled
		const intent = ++toggleIntentRef.current
		setPendingEnabled(nextEnabled)
		Promise.resolve(onToggle(agent.path, nextEnabled)).catch(() => {
			if (toggleIntentRef.current === intent) setPendingEnabled(undefined)
		})
	}

	const handleDelete = () => {
		FileServiceClient.deleteSubagentFile(
			DeleteSubagentRequest.create({
				subagentPath: agent.path,
				isGlobal,
			}),
		)
			.then(() => onDelete())
			.catch((err) => console.error("Failed to delete subagent:", err))
	}

	const handleEdit = () => {
		FileServiceClient.openFile(StringRequest.create({ value: agent.path })).catch((err) =>
			console.error("Failed to open subagent file:", err),
		)
	}

	const toolCount = selectedTools.size
	const description = agent.description || ""

	return (
		<div className="mb-2.5">
			{/* Header row */}
			<div className="flex items-center px-2 py-4 rounded bg-text-block-background max-h-4">
				{/* Expand toggle */}
				<button
					className="mr-1 p-0.5 hover:bg-input-background rounded"
					onClick={() => setExpanded(!expanded)}
					type="button">
					{expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
				</button>

				<span className="flex-1 overflow-hidden break-all whitespace-normal flex items-center mr-1" title={agent.path}>
					<span className="ph-no-capture font-medium">{agent.name}</span>
					{description && <span className="ml-2 text-xs text-description truncate max-w-[200px]">{description}</span>}
					<span className="ml-2 text-xs text-description">tools: {toolCount}</span>
				</span>

				{/* Toggle Switch */}
				<div className="flex items-center space-x-2 gap-2">
					<Switch checked={displayedEnabled} className="mx-1" key={agent.path} onClick={handleToggle} />
					<Button
						aria-label="Edit subagent file"
						onClick={handleEdit}
						size="xs"
						title="Edit subagent file"
						variant="icon">
						<PenIcon />
					</Button>
					<Button
						aria-label="Delete subagent file"
						onClick={handleDelete}
						size="xs"
						title="Delete subagent file"
						variant="icon">
						<Trash2Icon />
					</Button>
				</div>
			</div>

			{/* Expanded tool and profile selection */}
			{expanded && (
				<div className="mt-1 ml-6 p-2 rounded bg-input-background max-h-[300px] overflow-y-auto">
					{/* Profile selection */}
					<div className="mb-2">
						<div className="text-xs font-medium text-description mb-1">Profile</div>
						{profilesLoading ? (
							<div className="text-xs text-description">Loading available profiles...</div>
						) : (
							<select
								className="w-full text-xs p-1 rounded border"
								onChange={(e) => handleProfileChange(e.target.value)}
								style={nativeSelectStyle}
								value={selectedProfile}>
								<option style={nativeSelectOptionStyle} value="">
									Default (act profile)
								</option>
								{profiles.map((profile) => (
									<option key={profile.id || profile.name} style={nativeSelectOptionStyle} value={profile.name}>
										{profile.name}
									</option>
								))}
							</select>
						)}
					</div>

					{toolsLoading ? (
						<div className="text-xs text-description">Loading available tools...</div>
					) : toolGroups.length === 0 ? (
						<div className="text-xs text-description">No tools available</div>
					) : (
						toolGroups.map((group) => (
							<div className="mb-2" key={group.name}>
								<div className="text-xs font-medium text-description mb-1 flex items-center gap-1">
									{!group.tools[0]?.isReadOnly && <span className="text-warning">⚠️</span>}
									{group.name}
								</div>
								<div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
									{group.tools.map((tool) => (
										<label
											className="flex items-center gap-1.5 text-xs cursor-pointer hover:bg-text-block-background rounded px-1 py-0.5"
											key={tool.name}>
											<input
												checked={tool.required || selectedTools.has(tool.name)}
												className="w-3 h-3"
												disabled={tool.required}
												onChange={() => toggleTool(tool.name, tool.required)}
												title={tool.required ? "Always enabled for subagents" : undefined}
												type="checkbox"
											/>
											<span className="truncate" title={tool.description}>
												{tool.name}
											</span>
										</label>
									))}
								</div>
							</div>
						))
					)}
				</div>
			)}
		</div>
	)
}

export default SubagentRow
