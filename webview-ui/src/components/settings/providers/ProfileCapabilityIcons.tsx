import { type ModelCapabilities, ServerTool } from "@shared/proto/dline/models/metadata"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

function ThinkingIcon() {
	return (
		<svg aria-hidden="true" className="size-4 shrink-0" fill="none" viewBox="0 0 16 16">
			<path
				d="M6.45 3.05A2.15 2.15 0 0 0 3.2 4.8a2.25 2.25 0 0 0-.35 3.65 2.3 2.3 0 0 0 .9 3.8A2.05 2.05 0 0 0 7 10.65v-6.4c0-.55-.2-.95-.55-1.2Z"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.25"
			/>
			<path
				d="M9.55 3.05A2.15 2.15 0 0 1 12.8 4.8a2.25 2.25 0 0 1 .35 3.65 2.3 2.3 0 0 1-.9 3.8A2.05 2.05 0 0 1 9 10.65v-6.4c0-.55.2-.95.55-1.2Z"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.25"
			/>
			<path
				d="M4.25 6.15c.85-.05 1.35.25 1.7.9M11.75 6.15c-.85-.05-1.35.25-1.7.9M4.6 10.15c.8.1 1.3-.15 1.65-.75M11.4 10.15c-.8.1-1.3-.15-1.65-.75"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="1.1"
			/>
		</svg>
	)
}

function ImageIcon() {
	return (
		<svg aria-hidden="true" className="size-4 shrink-0" fill="none" viewBox="0 0 16 16">
			<rect height="11.5" rx="2" stroke="currentColor" strokeWidth="1.25" width="12.5" x="1.75" y="2.25" />
			<circle cx="5.25" cy="5.65" r="1.05" stroke="currentColor" strokeWidth="1.25" />
			<path
				d="M3.25 11.75 6.45 8.55l2.05 2.05 1.45-1.45 2.8 2.6"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.25"
			/>
		</svg>
	)
}

function PromptCacheIcon() {
	return (
		<svg aria-hidden="true" className="size-4 shrink-0" fill="none" viewBox="0 0 16 16">
			<path
				d="M2.25 8.75v-4.5a2 2 0 0 1 2-2h6.25a2 2 0 0 1 2 2v2"
				stroke="currentColor"
				strokeLinecap="round"
				strokeWidth="1.25"
			/>
			<path
				d="m4.15 5.1 1.55 1.3-1.55 1.3M7.25 7.7h1.7"
				stroke="currentColor"
				strokeLinecap="round"
				strokeLinejoin="round"
				strokeWidth="1.25"
			/>
			<path d="M13.15 10.15a2.75 2.75 0 1 0-.05 2.6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.25" />
			<path d="M11.85 8.75h1.5v1.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.25" />
		</svg>
	)
}

function BrowserIcon() {
	return (
		<svg aria-hidden="true" className="size-4 shrink-0" fill="none" viewBox="0 0 16 16">
			<rect height="11.5" rx="2" stroke="currentColor" strokeWidth="1.25" width="12.5" x="1.75" y="2.25" />
			<path d="M1.75 5.25h12.5" stroke="currentColor" strokeWidth="1.25" />
			<circle cx="3.45" cy="3.78" fill="currentColor" r=".46" />
			<circle cx="5.05" cy="3.78" fill="currentColor" r=".46" />
			<path d="M4 8h8M4 10.5h5.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.25" />
		</svg>
	)
}

function WebIcon() {
	return (
		<svg aria-hidden="true" className="size-4 shrink-0" fill="none" viewBox="0 0 16 16">
			<circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.25" />
			<path d="M2.55 8h10.9M3.6 4.75h8.8M3.6 11.25h8.8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.1" />
			<path
				d="M8 2.25c1.55 1.5 2.35 3.4 2.35 5.75S9.55 12.25 8 13.75C6.45 12.25 5.65 10.35 5.65 8S6.45 3.75 8 2.25Z"
				stroke="currentColor"
				strokeLinejoin="round"
				strokeWidth="1.1"
			/>
		</svg>
	)
}

const capabilityDefinitions = [
	{
		key: "thinking",
		label: "Reasoning",
		icon: ThinkingIcon,
		supported: (value: ModelCapabilities) => value.supportsReasoning === true,
	},
	{
		key: "image",
		label: "Image input",
		icon: ImageIcon,
		supported: (value: ModelCapabilities) => value.supportsImages === true,
	},
	{
		key: "prompt-cache",
		label: "Prompt cache",
		icon: PromptCacheIcon,
		supported: (value: ModelCapabilities) => value.supportsPromptCache === true,
	},
	{
		key: "browser",
		label: "Browser actions",
		icon: BrowserIcon,
		supported: (value: ModelCapabilities) => value.supportsBrowserAction === true,
	},
	{
		key: "web",
		label: "Web search",
		icon: WebIcon,
		supported: (value: ModelCapabilities) => value.tools?.includes(ServerTool.WEB_SEARCH) === true,
	},
	{
		key: "web-fetch",
		label: "Web fetch",
		icon: WebIcon,
		supported: (value: ModelCapabilities) => value.tools?.includes(ServerTool.WEB_FETCH) === true,
	},
] as const

interface ProfileCapabilityIconsProps {
	capabilities?: ModelCapabilities
	className?: string
	showLabels?: boolean
}

export function ProfileCapabilityIcons({ capabilities, className, showLabels = false }: ProfileCapabilityIconsProps) {
	if (!capabilities) return null
	const supported = capabilityDefinitions.filter((definition) => definition.supported(capabilities))
	if (supported.length === 0) return null

	if (showLabels) {
		return (
			<ul aria-label="Model capabilities" className={cn("m-0 flex list-none flex-col gap-0.5 p-0", className)}>
				{supported.map((definition) => {
					const Icon = definition.icon
					return (
						<li className="flex items-center gap-1 text-xs" key={definition.key}>
							<span className="inline-flex size-3 items-center justify-center [&_svg]:size-3">
								<Icon />
							</span>
							<span>{definition.label}: supported</span>
						</li>
					)
				})}
			</ul>
		)
	}

	return (
		<ul
			aria-label="Model capabilities"
			className={cn("m-0 flex shrink-0 list-none items-center justify-end gap-0.5 p-0", className)}>
			{supported.map((definition) => {
				const Icon = definition.icon
				return (
					<li aria-label={definition.label} key={definition.key}>
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="inline-flex size-5 items-center justify-center rounded-xs text-description hover:bg-toolbar-hover hover:text-foreground">
									<Icon />
								</span>
							</TooltipTrigger>
							<TooltipContent side="top">{definition.label}</TooltipContent>
						</Tooltip>
					</li>
				)
			})}
		</ul>
	)
}
