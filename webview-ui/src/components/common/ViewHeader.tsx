import { Button } from "@/components/ui/button"
import { getEnvironmentColor } from "@/utils/environmentColors"
import type { Environment } from "../../../../src/shared/config-types"

const ENV_DISPLAY_NAMES: Record<Environment, string> = {
    production: "Production",
    staging: "Staging",
    local: "Local",
    selfHosted: "Self-hosted",
}

type ViewHeaderProps = {
    title: string
    onDone: () => void | Promise<void>
    doneDisabled?: boolean
    doneLabel?: string
    showEnvironmentSuffix?: boolean
    environment?: Environment
}

const ViewHeader = ({
    title,
    onDone,
    doneDisabled = false,
    doneLabel = "Done",
    showEnvironmentSuffix,
    environment,
}: ViewHeaderProps) => {
    const showSubtext = showEnvironmentSuffix && environment && environment !== "production"
    const capitalizedEnv = environment ? ENV_DISPLAY_NAMES[environment] : ""
    const titleColor = getEnvironmentColor(environment)

    return (
        <div className="flex justify-between items-center py-2.5 px-5 mb-[17px]">
            <div className="relative">
                <h3 className="m-0 text-lg font-normal" style={{ color: titleColor }}>
                    {title}
                </h3>
                {showSubtext && (
                    <span className="absolute left-0 top-8 -translate-y-1 text-xs text-description whitespace-nowrap">
                        {capitalizedEnv} environment
                    </span>
                )}
            </div>
            <Button disabled={doneDisabled} onClick={() => void onDone()} size="header">
                {doneLabel}
            </Button>
        </div>
    )
}

export default ViewHeader
