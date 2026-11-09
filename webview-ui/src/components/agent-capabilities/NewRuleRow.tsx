import { CreateHookRequest, CreateSkillRequest, CreateSubagentRequest, RuleFileRequest } from "@shared/proto/index.dline"
import { PlusIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useClickAway } from "react-use"
import { Button } from "@/components/ui/button"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/services/grpc-client"

interface NewRuleRowProps {
    isGlobal: boolean
    ruleType?: string
    existingHooks?: string[]
    workspaceName?: string
}

const HOOK_TYPES = [
    { name: "TaskStart", descriptionKey: "capabilities.new.TaskStart" },
    { name: "TaskResume", descriptionKey: "capabilities.new.TaskResume" },
    { name: "TaskCancel", descriptionKey: "capabilities.new.TaskCancel" },
    { name: "TaskComplete", descriptionKey: "capabilities.new.TaskComplete" },
    { name: "PreToolUse", descriptionKey: "capabilities.new.PreToolUse" },
    { name: "PostToolUse", descriptionKey: "capabilities.new.PostToolUse" },
    { name: "UserPromptSubmit", descriptionKey: "capabilities.new.UserPromptSubmit" },
    { name: "PreCompact", descriptionKey: "capabilities.new.PreCompact" },
] as const

type CreationErrorKey =
    | "capabilities.new.skillNameError"
    | "capabilities.new.subagentNameError"
    | "capabilities.new.extensionError"
    | "capabilities.new.skillError"
    | "capabilities.new.subagentError"

const NewRuleRow: React.FC<NewRuleRowProps> = ({ isGlobal, ruleType, existingHooks = [], workspaceName }) => {
    const { t } = useUiTranslation()
    const [isExpanded, setIsExpanded] = useState(false)
    const [filename, setFilename] = useState("")
    const inputRef = useRef<HTMLInputElement>(null)
    const [error, setError] = useState<{ key: CreationErrorKey; diagnostics?: string } | null>(null)

    const componentRef = useRef<HTMLDivElement>(null)
    const newLabel = t(
        ruleType === "workflow"
            ? "capabilities.new.workflow"
            : ruleType === "skill"
              ? "capabilities.new.skill"
              : ruleType === "subagent"
                ? "capabilities.new.subagent"
                : "capabilities.new.rule",
    )
    const namePlaceholder = t(
        ruleType === "workflow"
            ? "capabilities.new.workflowPlaceholder"
            : ruleType === "skill"
              ? "capabilities.new.skillPlaceholder"
              : ruleType === "subagent"
                ? "capabilities.new.subagentPlaceholder"
                : "capabilities.new.rulePlaceholder",
    )
    const createLabel = t(ruleType === "skill" ? "capabilities.new.createSkill" : "capabilities.new.createFile")

    // Calculate available hook types by filtering out existing hooks
    const availableHookTypes = useMemo(() => HOOK_TYPES.filter((type) => !existingHooks.includes(type.name)), [existingHooks])

    // Focus the input when expanded
    useEffect(() => {
        if (isExpanded && inputRef.current) {
            inputRef.current.focus()
        }
    }, [isExpanded])

    useClickAway(componentRef, () => {
        if (isExpanded) {
            setIsExpanded(false)
            setFilename("")
            setError(null)
        }
    })

    const getExtension = (filename: string): string => {
        if (filename.startsWith(".") && !filename.includes(".", 1)) {
            return ""
        }
        const match = filename.match(/\.[^.]+$/)
        return match ? match[0].toLowerCase() : ""
    }

    const isValidExtension = (ext: string): boolean => {
        return ext === "" || ext === ".md" || ext === ".txt"
    }

    const handleCreateHook = async (hookName: string) => {
        if (!hookName) return

        try {
            await FileServiceClient.createHook(
                CreateHookRequest.create({
                    hookName,
                    isGlobal,
                    workspaceName,
                }),
            )
        } catch (err) {
            console.error("Error creating hook:", err)
        }
    }

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault()

        if (filename.trim()) {
            const trimmedFilename = filename.trim()

            // Skills use directory names, not file extensions
            if (ruleType === "skill") {
                // Validate skill name - only allow alphanumeric, dashes, underscores
                if (!/^[a-zA-Z0-9_-]+$/.test(trimmedFilename)) {
                    setError({ key: "capabilities.new.skillNameError" })
                    return
                }

                try {
                    await FileServiceClient.createSkillFile(
                        CreateSkillRequest.create({
                            skillName: trimmedFilename,
                            isGlobal,
                        }),
                    )
                    setFilename("")
                    setError(null)
                    setIsExpanded(false)
                } catch (err) {
                    setError({
                        key: "capabilities.new.skillError",
                        diagnostics: err instanceof Error ? err.message : String(err),
                    })
                }
                return
            }

            if (ruleType === "subagent") {
                // Validate subagent name - only allow alphanumeric, dashes, underscores
                if (!/^[a-zA-Z0-9_-]+$/.test(trimmedFilename)) {
                    setError({ key: "capabilities.new.subagentNameError" })
                    return
                }

                try {
                    await FileServiceClient.createSubagentFile(
                        CreateSubagentRequest.create({
                            subagentName: trimmedFilename,
                            isGlobal,
                        }),
                    )
                    setFilename("")
                    setError(null)
                    setIsExpanded(false)
                } catch (err) {
                    setError({
                        key: "capabilities.new.subagentError",
                        diagnostics: err instanceof Error ? err.message : String(err),
                    })
                }
                return
            }

            const extension = getExtension(trimmedFilename)

            if (!isValidExtension(extension)) {
                setError({ key: "capabilities.new.extensionError" })
                return
            }

            let finalFilename = trimmedFilename
            if (extension === "") {
                finalFilename = `${trimmedFilename}.md`
            }

            try {
                await FileServiceClient.createRuleFile(
                    RuleFileRequest.create({
                        isGlobal,
                        filename: finalFilename,
                        type: ruleType || "cline",
                    }),
                )
            } catch (err) {
                console.error("Error creating rule file:", err)
            }

            setFilename("")
            setError(null)
            setIsExpanded(false)
        }
    }

    const _handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            setIsExpanded(false)
            setFilename("")
        }
    }

    return (
        <div
            className={cn("mb-2.5 transition-all duration-300 ease-in-out", {
                "opacity-100": isExpanded,
                "opacity-70 hover:opacity-100": !isExpanded,
            })}
            onClick={() => !isExpanded && ruleType !== "hook" && setIsExpanded(true)}
            ref={componentRef}>
            <div
                className={cn(
                    "flex items-center px-2 py-4 rounded bg-input-background transition-all duration-300 ease-in-out h-5",
                    {
                        "shadow-sm": isExpanded,
                    },
                )}>
                {ruleType === "hook" ? (
                    <>
                        <label className="sr-only" htmlFor="hook-type-select">
                            {t("capabilities.new.selectHook")}
                        </label>
                        <span className="sr-only" id="hook-select-description">
                            {t("capabilities.new.hookDescription", {
                                available: availableHookTypes.map((h) => h.name).join(", "),
                            })}
                        </span>
                        <select
                            aria-describedby="hook-select-description"
                            aria-label={t("capabilities.new.selectHook")}
                            className="flex-1 bg-input-background text-input-foreground border-0 outline-0 rounded focus:outline-none focus:ring-0 focus:border-transparent px-2 cursor-pointer"
                            disabled={availableHookTypes.length === 0}
                            id="hook-type-select"
                            onChange={(e) => {
                                if (e.target.value) {
                                    handleCreateHook(e.target.value)
                                    // Reset selection after creating
                                    e.target.value = ""
                                }
                            }}
                            style={{
                                fontStyle: "italic",
                                appearance: "none",
                                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23cccccc' d='M6 9L1 4h10z'/%3E%3C/svg%3E")`,
                                backgroundRepeat: "no-repeat",
                                backgroundPosition: "right 8px center",
                                paddingRight: "24px",
                            }}
                            value="">
                            <option disabled value="">
                                {t(availableHookTypes.length === 0 ? "capabilities.new.allHooks" : "capabilities.new.hook")}
                            </option>
                            {availableHookTypes.map((hook) => (
                                <option key={hook.name} title={t(hook.descriptionKey)} value={hook.name}>
                                    {hook.name}
                                </option>
                            ))}
                        </select>
                    </>
                ) : (
                    <form className="flex flex-1 items-center" onSubmit={handleSubmit}>
                        <input
                            aria-label={newLabel}
                            className={cn(
                                "flex-1 bg-input-background text-input-foreground border-0 outline-0 rounded focus:outline-none focus:ring-0 focus:border-transparent",
                                {
                                    italic: !isExpanded,
                                },
                            )}
                            onChange={(e) => setFilename(e.target.value)}
                            placeholder={isExpanded ? namePlaceholder : newLabel}
                            ref={inputRef}
                            type="text"
                            value={isExpanded ? filename : ""}
                        />

                        <Button
                            aria-label={isExpanded ? createLabel : newLabel}
                            className="mx-0.5"
                            onClick={(e) => {
                                e.stopPropagation()
                                if (!isExpanded) {
                                    setIsExpanded(true)
                                }
                            }}
                            size="icon"
                            title={isExpanded ? createLabel : t("capabilities.new.file")}
                            type={isExpanded ? "submit" : "button"}
                            variant="icon">
                            <PlusIcon />
                        </Button>
                    </form>
                )}
            </div>
            {isExpanded && error && (
                <div className="text-error text-xs mt-1 ml-2" role="alert">
                    {t(error.key)}
                    {error.diagnostics && (
                        <details>
                            <summary>{t("capabilities.diagnostics")}</summary>
                            {error.diagnostics}
                        </details>
                    )}
                </div>
            )}
        </div>
    )
}

export default NewRuleRow
