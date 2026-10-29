import { EmptyRequest } from "@shared/proto/dline/common"
import {
    ShellEnvironmentProfile,
    ShellEnvironmentProfileRequest,
    ShellEnvironmentVariable,
    UpdateShellEnvironmentProfileRequest,
} from "@shared/proto/dline/file"
import { Plus, Trash2 } from "lucide-react"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { FileServiceClient } from "@/services/grpc-client"

type EditorTab = "environment" | "startup" | "commands"
type EnvironmentManager = "none" | "conda" | "venv"

interface EditorState {
    configPath: string
    exists: boolean
    environment: ShellEnvironmentVariable[]
    postCommand?: string
    preCommands: string[]
    profile: string
    sourceContent: string
    startupScripts: string[]
    workspacePath: string
}

const EMPTY_EDITOR: EditorState = {
    configPath: "",
    exists: false,
    environment: [],
    preCommands: [],
    profile: "default",
    sourceContent: "",
    startupScripts: [],
    workspacePath: "",
}

function toEditorState(profile: ShellEnvironmentProfile): EditorState {
    return {
        configPath: profile.configPath,
        exists: profile.exists,
        environment: profile.environment.map((variable) => ({ ...variable })),
        postCommand: profile.postCommand,
        preCommands: [...profile.preCommands],
        profile: profile.profile,
        sourceContent: profile.sourceContent,
        startupScripts: [...profile.startupScripts],
        workspacePath: profile.workspacePath,
    }
}

function createUpdateRequest(editor: EditorState): UpdateShellEnvironmentProfileRequest {
    return UpdateShellEnvironmentProfileRequest.create({
        workspacePath: editor.workspacePath,
        profile: editor.profile,
        environment: editor.environment,
        startupScripts: editor.startupScripts.filter((entry) => entry.trim()),
        preCommands: editor.preCommands.filter((entry) => entry.trim()),
        postCommand: editor.postCommand?.trim() ? editor.postCommand : undefined,
        expectedSourceContent: editor.sourceContent,
        confirmed: true,
    })
}

function editorProfileKey(editor: EditorState): string {
    return editor.workspacePath && editor.profile ? JSON.stringify([editor.workspacePath, editor.profile]) : ""
}

function editorDraftKey(editor: EditorState): string {
    const request = createUpdateRequest(editor)
    return JSON.stringify({
        environment: request.environment,
        postCommand: request.postCommand,
        preCommands: request.preCommands,
        startupScripts: request.startupScripts,
    })
}

const fieldClassName =
    "h-7 min-w-0 w-full rounded-xs border border-input-border bg-input-background px-2 text-xs text-input-foreground outline-none focus:border-focus-border"

function findCondaActivation(preCommands: readonly string[]): { index: number; environment: string } | undefined {
    for (const [index, command] of preCommands.entries()) {
        const match = command.trim().match(/^conda\s+activate\s+(.+)$/i)
        if (match?.[1]) return { index, environment: match[1].trim() }
    }
    return undefined
}

function findVenvActivation(preCommands: readonly string[]): { index: number; path: string } | undefined {
    for (const [index, command] of preCommands.entries()) {
        const trimmed = command.trim()
        const windowsMatch = trimmed.match(/^(?:&|call)\s+(["']?)(.+?[\\/]Scripts[\\/](?:Activate\.ps1|activate\.bat))\1$/i)
        if (windowsMatch?.[2]) {
            return {
                index,
                path: windowsMatch[2].replace(/[\\/]Scripts[\\/](?:Activate\.ps1|activate\.bat)$/i, ""),
            }
        }
        const posixMatch = trimmed.match(/^\.\s+(["']?)(.+?[\\/]bin[\\/]activate)\1$/i)
        if (posixMatch?.[2]) {
            return { index, path: posixMatch[2].replace(/[\\/]bin[\\/]activate$/i, "") }
        }
    }
    return undefined
}

function isPosixProfile(profile: string, platform: string): boolean {
    return platform !== "win32" || ["bash", "zsh", "sh", "ksh", "wsl-bash", "git-bash"].includes(profile)
}

function buildVenvActivationCommand(venvPath: string, profile: string, platform: string): string {
    const normalizedPath = venvPath.trim().replace(/[\\/]$/, "")
    if (isPosixProfile(profile, platform)) return `. '${normalizedPath}/bin/activate'`
    if (profile === "cmd") return `call "${normalizedPath}\\Scripts\\activate.bat"`
    return `& "${normalizedPath}\\Scripts\\Activate.ps1"`
}

function detectEnvironmentManager(preCommands: readonly string[]): {
    manager: EnvironmentManager
    value: string
} {
    const conda = findCondaActivation(preCommands)
    if (conda) return { manager: "conda", value: conda.environment }
    const venv = findVenvActivation(preCommands)
    if (venv) return { manager: "venv", value: venv.path }
    return { manager: "none", value: "" }
}

const ShellEnvironmentModal: React.FC<{ isActive: boolean }> = ({ isActive }) => {
    const { availableTerminalProfiles, defaultTerminalProfile, platform, primaryRootIndex, workspaceRoots } = useExtensionState()
    const initialWorkspace = workspaceRoots[primaryRootIndex]?.path ?? workspaceRoots[0]?.path ?? ""
    const initialProfile =
        availableTerminalProfiles.find((profile) => profile.id === defaultTerminalProfile)?.id ??
        availableTerminalProfiles.find((profile) => profile.id === "default")?.id ??
        availableTerminalProfiles[0]?.id ??
        ""
    const [selectedWorkspace, setSelectedWorkspace] = useState("")
    const [selectedProfile, setSelectedProfile] = useState("")
    const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR)
    const [activeTab, setActiveTab] = useState<EditorTab>("environment")
    const [environmentManager, setEnvironmentManager] = useState<EnvironmentManager>("none")
    const [condaEnvironments, setCondaEnvironments] = useState<string[]>([])
    const [condaEnvironment, setCondaEnvironment] = useState("")
    const [venvPath, setVenvPath] = useState("")
    const [isCondaLoading, setIsCondaLoading] = useState(false)
    const [condaNotice, setCondaNotice] = useState<string | null>(null)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [status, setStatus] = useState<string | null>(null)
    const loadSequence = useRef(0)
    const loadedSelection = useRef("")
    const savedDrafts = useRef(new Map<string, string>())
    const savingProfiles = useRef(new Set<string>())
    const editorRef = useRef(editor)
    const syncInFlight = useRef(false)
    const condaEnvironmentRef = useRef("")
    editorRef.current = editor
    const updateCondaEnvironment = (value: string) => {
        condaEnvironmentRef.current = value
        setCondaEnvironment(value)
    }

    const loadProfile = useCallback(async (workspacePath: string, profile: string) => {
        const sequence = ++loadSequence.current
        if (!workspacePath || !profile) {
            setEditor(EMPTY_EDITOR)
            setEnvironmentManager("none")
            updateCondaEnvironment("")
            setVenvPath("")
            return
        }
        setIsLoading(true)
        setError(null)
        setStatus(null)
        try {
            const response = await FileServiceClient.getShellEnvironmentProfile(
                ShellEnvironmentProfileRequest.create({ workspacePath, profile }),
            )
            if (sequence === loadSequence.current) {
                const nextEditor = toEditorState(response)
                savedDrafts.current.set(editorProfileKey(nextEditor), editorDraftKey(nextEditor))
                const detected = detectEnvironmentManager(nextEditor.preCommands)
                setEditor(nextEditor)
                setEnvironmentManager(detected.manager)
                if (detected.manager === "conda") {
                    updateCondaEnvironment(detected.value)
                    setVenvPath("")
                } else if (detected.manager === "venv") {
                    setVenvPath(detected.value)
                    updateCondaEnvironment("")
                } else {
                    updateCondaEnvironment("")
                    setVenvPath("")
                }
            }
        } catch (requestError) {
            if (sequence === loadSequence.current) {
                loadedSelection.current = ""
                setError(requestError instanceof Error ? requestError.message : String(requestError))
            }
        } finally {
            if (sequence === loadSequence.current) setIsLoading(false)
        }
    }, [])

    useEffect(() => {
        setSelectedWorkspace((current) =>
            workspaceRoots.some((workspace) => workspace.path === current) ? current : initialWorkspace,
        )
    }, [initialWorkspace, workspaceRoots])

    useEffect(() => {
        setSelectedProfile((current) =>
            availableTerminalProfiles.some((profile) => profile.id === current) ? current : initialProfile,
        )
    }, [availableTerminalProfiles, initialProfile])

    useEffect(() => {
        if (!isActive) return
        const selection = JSON.stringify([selectedWorkspace, selectedProfile])
        if (loadedSelection.current === selection) return
        loadedSelection.current = selection
        void loadProfile(selectedWorkspace, selectedProfile)
    }, [isActive, loadProfile, selectedProfile, selectedWorkspace])

    const saveEditor = useCallback(async (draft: EditorState) => {
        const profileKey = editorProfileKey(draft)
        const draftKey = editorDraftKey(draft)
        if (!profileKey || savedDrafts.current.get(profileKey) === draftKey || savingProfiles.current.has(profileKey)) return

        savingProfiles.current.add(profileKey)
        setError(null)
        setStatus("Saving...")
        try {
            const response = await FileServiceClient.updateShellEnvironmentProfile(createUpdateRequest(draft))
            savedDrafts.current.set(profileKey, draftKey)
            setEditor((current) => {
                if (editorProfileKey(current) !== profileKey) return current
                return {
                    ...current,
                    configPath: response.configPath,
                    exists: response.exists,
                    profile: response.profile,
                    sourceContent: response.sourceContent,
                    workspacePath: response.workspacePath,
                }
            })
            setStatus("Saved")
        } catch (requestError) {
            setStatus(null)
            setError(requestError instanceof Error ? requestError.message : String(requestError))
        } finally {
            savingProfiles.current.delete(profileKey)
        }
    }, [])

    useEffect(() => {
        if (!isActive || isLoading || !editor.workspacePath) return
        const profileKey = editorProfileKey(editor)
        if (!profileKey || savedDrafts.current.get(profileKey) === editorDraftKey(editor)) return
        const timeout = window.setTimeout(() => void saveEditor(editor), 350)
        return () => window.clearTimeout(timeout)
    }, [editor, isActive, isLoading, saveEditor])

    useEffect(() => {
        if (!isActive || !selectedWorkspace || !selectedProfile) return
        const syncFromConfig = async () => {
            if (syncInFlight.current) return
            syncInFlight.current = true
            try {
                const response = await FileServiceClient.getShellEnvironmentProfile(
                    ShellEnvironmentProfileRequest.create({ workspacePath: selectedWorkspace, profile: selectedProfile }),
                )
                const current = editorRef.current
                const profileKey = editorProfileKey(current)
                const hasDraft = savedDrafts.current.get(profileKey) !== editorDraftKey(current)
                if (
                    !profileKey ||
                    hasDraft ||
                    savingProfiles.current.has(profileKey) ||
                    current.workspacePath !== response.workspacePath ||
                    current.profile !== response.profile ||
                    current.sourceContent === response.sourceContent
                ) {
                    return
                }

                const nextEditor = toEditorState(response)
                savedDrafts.current.set(editorProfileKey(nextEditor), editorDraftKey(nextEditor))
                const detected = detectEnvironmentManager(nextEditor.preCommands)
                setEditor(nextEditor)
                setEnvironmentManager(detected.manager)
                if (detected.manager === "conda") {
                    updateCondaEnvironment(detected.value)
                    setVenvPath("")
                } else if (detected.manager === "venv") {
                    setVenvPath(detected.value)
                    updateCondaEnvironment("")
                } else {
                    updateCondaEnvironment("")
                    setVenvPath("")
                }
                setError(null)
                setStatus("Synced")
            } catch {
                // Background synchronization must not replace the current editor with an error state.
            } finally {
                syncInFlight.current = false
            }
        }
        const interval = window.setInterval(() => void syncFromConfig(), 1000)
        return () => window.clearInterval(interval)
    }, [isActive, selectedProfile, selectedWorkspace])

    const refreshCondaEnvironments = useCallback(async () => {
        setIsCondaLoading(true)
        setCondaNotice(null)
        try {
            const response = await FileServiceClient.listCondaEnvironments(EmptyRequest.create({}))
            setCondaEnvironments(response.values)
            const currentEnvironment = condaEnvironmentRef.current
            const nextEnvironment = currentEnvironment || response.values[0] || ""
            if (!currentEnvironment && nextEnvironment) {
                updateCondaEnvironment(nextEnvironment)
                replaceManagedActivation(`conda activate ${nextEnvironment}`)
            }
            setCondaNotice(response.values.length === 0 ? "No Conda environments found" : null)
        } catch (requestError) {
            setCondaEnvironments([])
            setCondaNotice(requestError instanceof Error ? requestError.message : String(requestError))
        } finally {
            setIsCondaLoading(false)
        }
    }, [])

    useEffect(() => {
        if (!isActive || environmentManager !== "conda") return
        void refreshCondaEnvironments()
    }, [environmentManager, isActive, refreshCondaEnvironments])

    const workspaceOptions = useMemo(
        () => workspaceRoots.map((root) => ({ label: root.name || root.path, value: root.path })),
        [workspaceRoots],
    )

    const updateList = (field: "startupScripts" | "preCommands", index: number, value: string) => {
        setEditor((current) => ({
            ...current,
            [field]: current[field].map((entry, entryIndex) => (entryIndex === index ? value : entry)),
        }))
    }

    const removeListEntry = (field: "startupScripts" | "preCommands", index: number) => {
        setEditor((current) => ({
            ...current,
            [field]: current[field].filter((_entry, entryIndex) => entryIndex !== index),
        }))
    }

    const replaceManagedActivation = (command: string | undefined) => {
        setEditor((current) => {
            const managedIndexes = current.preCommands
                .map((entry, index) => ({ entry, index }))
                .filter(({ entry }) => findCondaActivation([entry]) || findVenvActivation([entry]))
            const firstManagedIndex = managedIndexes[0]?.index
            const remaining = current.preCommands.filter((_entry, index) => !managedIndexes.some((item) => item.index === index))
            if (!command) return { ...current, preCommands: remaining }
            const insertAt = firstManagedIndex === undefined ? 0 : Math.min(firstManagedIndex, remaining.length)
            remaining.splice(insertAt, 0, command)
            return { ...current, preCommands: remaining }
        })
    }

    const selectEnvironmentManager = (manager: EnvironmentManager) => {
        setEnvironmentManager(manager)
        if (manager === "none") {
            replaceManagedActivation(undefined)
            return
        }
        if (manager === "conda") {
            replaceManagedActivation(condaEnvironment ? `conda activate ${condaEnvironment}` : undefined)
            return
        }
        const nextVenvPath =
            venvPath || (isPosixProfile(selectedProfile, platform) ? "${workspaceFolder}/.venv" : "${workspaceFolder}\\.venv")
        setVenvPath(nextVenvPath)
        replaceManagedActivation(buildVenvActivationCommand(nextVenvPath, selectedProfile, platform))
    }

    return (
        <div className="flex h-full min-h-0 flex-1 flex-col" data-testid="shell-environment-panel">
            <div className="grid grid-cols-2 gap-2 px-3 py-2">
                <label className="min-w-0 text-xs">
                    <span className="mb-1 block text-description">Workspace</span>
                    <select
                        aria-label="Workspace"
                        className={fieldClassName}
                        onChange={(event) => {
                            setSelectedWorkspace(event.target.value)
                        }}
                        value={selectedWorkspace}>
                        {workspaceOptions.map((workspace) => (
                            <option key={workspace.value} value={workspace.value}>
                                {workspace.label}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="min-w-0 text-xs">
                    <span className="mb-1 block text-description">Terminal Profile</span>
                    <select
                        aria-label="Terminal Profile"
                        className={fieldClassName}
                        onChange={(event) => {
                            setSelectedProfile(event.target.value)
                        }}
                        value={selectedProfile}>
                        {availableTerminalProfiles.map((profile) => (
                            <option key={profile.id} value={profile.id}>
                                {profile.name}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            {(status || error) && (
                <div
                    aria-live="polite"
                    className={`border-b border-editor-group-border px-3 pb-2 text-xs ${error ? "text-error" : "text-description"}`}
                    role={error ? "alert" : "status"}>
                    {error ?? status}
                </div>
            )}

            <div className="flex border-b border-editor-group-border px-3" role="tablist">
                {(
                    [
                        ["environment", "Environment"],
                        ["startup", "Startup Scripts"],
                        ["commands", "Commands"],
                    ] as const
                ).map(([id, label]) => (
                    <button
                        aria-selected={activeTab === id}
                        className={`border-0 border-b-2 bg-transparent px-3 py-2 text-xs ${activeTab === id ? "border-foreground text-foreground" : "border-transparent text-description"}`}
                        key={id}
                        onClick={() => setActiveTab(id)}
                        role="tab"
                        type="button">
                        {label}
                    </button>
                ))}
            </div>

            <div className="min-h-40 flex-1 overflow-y-auto px-3 py-3">
                {isLoading && editor.workspacePath === "" ? (
                    <div className="text-xs text-description">Loading...</div>
                ) : activeTab === "environment" ? (
                    <div className="flex flex-col gap-2">
                        {editor.environment.map((variable, index) => (
                            <div
                                className="grid grid-cols-[minmax(90px,0.8fr)_minmax(100px,1fr)_auto_auto] items-center gap-2"
                                key={index}>
                                <input
                                    aria-label={`Environment name ${index + 1}`}
                                    className={fieldClassName}
                                    onChange={(event) =>
                                        setEditor((current) => ({
                                            ...current,
                                            environment: current.environment.map((entry, entryIndex) =>
                                                entryIndex === index ? { ...entry, name: event.target.value } : entry,
                                            ),
                                        }))
                                    }
                                    placeholder="NAME"
                                    value={variable.name}
                                />
                                <input
                                    aria-label={`Environment value ${index + 1}`}
                                    className={fieldClassName}
                                    disabled={variable.value === undefined}
                                    onChange={(event) =>
                                        setEditor((current) => ({
                                            ...current,
                                            environment: current.environment.map((entry, entryIndex) =>
                                                entryIndex === index ? { ...entry, value: event.target.value } : entry,
                                            ),
                                        }))
                                    }
                                    placeholder="Value"
                                    value={variable.value ?? ""}
                                />
                                <label className="flex items-center gap-1 whitespace-nowrap text-xs text-description">
                                    <input
                                        aria-label={`Unset environment ${index + 1}`}
                                        checked={variable.value === undefined}
                                        onChange={(event) =>
                                            setEditor((current) => ({
                                                ...current,
                                                environment: current.environment.map((entry, entryIndex) =>
                                                    entryIndex === index
                                                        ? { ...entry, value: event.target.checked ? undefined : "" }
                                                        : entry,
                                                ),
                                            }))
                                        }
                                        type="checkbox"
                                    />
                                    Unset
                                </label>
                                <Button
                                    aria-label={`Remove environment ${index + 1}`}
                                    onClick={() =>
                                        setEditor((current) => ({
                                            ...current,
                                            environment: current.environment.filter((_entry, entryIndex) => entryIndex !== index),
                                        }))
                                    }
                                    size="icon"
                                    variant="icon">
                                    <Trash2 size={12} />
                                </Button>
                            </div>
                        ))}
                        <Button
                            className="self-start"
                            onClick={() =>
                                setEditor((current) => ({
                                    ...current,
                                    environment: [
                                        ...current.environment,
                                        ShellEnvironmentVariable.create({ name: "", value: "" }),
                                    ],
                                }))
                            }
                            size="xs"
                            variant="secondary">
                            <Plus size={12} /> Add variable
                        </Button>
                    </div>
                ) : activeTab === "startup" ? (
                    <ListEditor
                        addLabel="Add startup script"
                        ariaPrefix="Startup script"
                        entries={editor.startupScripts}
                        onAdd={() => setEditor((current) => ({ ...current, startupScripts: [...current.startupScripts, ""] }))}
                        onChange={(index, value) => updateList("startupScripts", index, value)}
                        onRemove={(index) => removeListEntry("startupScripts", index)}
                        placeholder="Path to .bat, .cmd, .ps1, .bashrc, .bash, or .sh"
                    />
                ) : (
                    <div className="flex flex-col gap-3">
                        <div className="flex flex-col gap-2 border-b border-editor-group-border pb-3">
                            <label className="text-xs">
                                <span className="mb-1 block text-description">Python Env Manager</span>
                                <select
                                    aria-label="Python Env Manager"
                                    className={fieldClassName}
                                    onChange={(event) => selectEnvironmentManager(event.target.value as EnvironmentManager)}
                                    value={environmentManager}>
                                    <option value="none">None</option>
                                    <option value="conda">Conda</option>
                                    <option value="venv">venv</option>
                                </select>
                            </label>
                            {environmentManager === "conda" ? (
                                <div className="flex items-end gap-2">
                                    <label className="min-w-0 flex-1 text-xs">
                                        <span className="mb-1 block text-description">Conda environment</span>
                                        <select
                                            aria-label="Conda environment"
                                            className={fieldClassName}
                                            disabled={isCondaLoading}
                                            onChange={(event) => {
                                                updateCondaEnvironment(event.target.value)
                                                replaceManagedActivation(
                                                    event.target.value ? `conda activate ${event.target.value}` : undefined,
                                                )
                                            }}
                                            value={condaEnvironment}>
                                            <option value="">Select environment</option>
                                            {condaEnvironment && !condaEnvironments.includes(condaEnvironment) && (
                                                <option value={condaEnvironment}>{condaEnvironment}</option>
                                            )}
                                            {condaEnvironments.map((environment) => (
                                                <option key={environment} value={environment}>
                                                    {environment}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                </div>
                            ) : environmentManager === "venv" ? (
                                <label className="text-xs">
                                    <span className="mb-1 block text-description">venv path</span>
                                    <input
                                        aria-label="venv path"
                                        className={fieldClassName}
                                        onChange={(event) => {
                                            setVenvPath(event.target.value)
                                            replaceManagedActivation(
                                                event.target.value
                                                    ? buildVenvActivationCommand(event.target.value, selectedProfile, platform)
                                                    : undefined,
                                            )
                                        }}
                                        placeholder={
                                            isPosixProfile(selectedProfile, platform)
                                                ? "${workspaceFolder}/.venv"
                                                : "${workspaceFolder}\\.venv"
                                        }
                                        value={venvPath}
                                    />
                                </label>
                            ) : null}
                            {condaNotice && environmentManager === "conda" && (
                                <span className="text-xs text-description">{condaNotice}</span>
                            )}
                        </div>
                        <div>
                            <div className="mb-2 text-xs font-medium">Pre Commands</div>
                            <ListEditor
                                addLabel="Add pre command"
                                ariaPrefix="Pre command"
                                entries={editor.preCommands}
                                onAdd={() => setEditor((current) => ({ ...current, preCommands: [...current.preCommands, ""] }))}
                                onChange={(index, value) => updateList("preCommands", index, value)}
                                onRemove={(index) => removeListEntry("preCommands", index)}
                                placeholder="Command"
                            />
                        </div>
                        <div>
                            <div className="mb-2 text-xs font-medium">Post Command</div>
                            <ListEditor
                                addLabel="Add post command"
                                ariaPrefix="Post command"
                                entries={editor.postCommand === undefined ? [] : [editor.postCommand]}
                                maxEntries={1}
                                onAdd={() => setEditor((current) => ({ ...current, postCommand: "" }))}
                                onChange={(_index, value) => setEditor((current) => ({ ...current, postCommand: value }))}
                                onRemove={() => setEditor((current) => ({ ...current, postCommand: undefined }))}
                                placeholder="Command"
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

const ListEditor = ({
    addLabel,
    ariaPrefix,
    entries,
    onAdd,
    onChange,
    onRemove,
    placeholder,
    maxEntries,
}: {
    addLabel: string
    ariaPrefix: string
    entries: string[]
    onAdd: () => void
    onChange: (index: number, value: string) => void
    onRemove: (index: number) => void
    placeholder: string
    maxEntries?: number
}) => (
    <div className="flex flex-col gap-2">
        {entries.map((entry, index) => (
            <div className="flex items-center gap-2" key={`${ariaPrefix}-${index}`}>
                <input
                    aria-label={`${ariaPrefix} ${index + 1}`}
                    className={fieldClassName}
                    onChange={(event) => onChange(index, event.target.value)}
                    placeholder={placeholder}
                    value={entry}
                />
                <Button
                    aria-label={`Remove ${ariaPrefix.toLowerCase()} ${index + 1}`}
                    onClick={() => onRemove(index)}
                    size="icon"
                    variant="icon">
                    <Trash2 size={12} />
                </Button>
            </div>
        ))}
        {(maxEntries === undefined || entries.length < maxEntries) && (
            <Button className="self-start" onClick={onAdd} size="xs" variant="secondary">
                <Plus size={12} /> {addLabel}
            </Button>
        )}
    </div>
)

export default ShellEnvironmentModal
