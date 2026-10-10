import type { OpenAiServiceTier } from "@shared/storage/types"
import type { ComponentType, PropsWithChildren, SVGProps } from "react"

export type ServiceTierIconProps = SVGProps<SVGSVGElement>
export type ServiceTierIconComponent = ComponentType<ServiceTierIconProps>

type StandardServiceTierIconProps = PropsWithChildren<ServiceTierIconProps>

function StandardServiceTierIcon({ children, className, style, ...props }: StandardServiceTierIconProps) {
    return (
        <svg
            {...props}
            aria-hidden="true"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            style={{
                display: "block",
                flex: "0 0 auto",
                fontSize: "inherit",
                height: "1em",
                width: "1em",
                ...style,
            }}
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg">
            {children}
        </svg>
    )
}

export function AutoServiceTierIcon(props: ServiceTierIconProps) {
    return (
        <StandardServiceTierIcon {...props}>
            <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
            <path d="M20 3v4" />
            <path d="M22 5h-4" />
            <path d="M4 17v2" />
            <path d="M5 18H3" />
        </StandardServiceTierIcon>
    )
}

export function DefaultServiceTierIcon(props: ServiceTierIconProps) {
    return (
        <StandardServiceTierIcon {...props}>
            <path d="M12 2a10 10 0 1 1-10 10A10 10 0 0 1 12 2z" data-default-tier-part="ring" />
            <path d="m12 12 4-4" data-default-tier-part="needle" />
        </StandardServiceTierIcon>
    )
}

export function FlexServiceTierIcon(props: ServiceTierIconProps) {
    return (
        <StandardServiceTierIcon {...props}>
            <path d="m18 14 4 4-4 4" />
            <path d="m18 2 4 4-4 4" />
            <path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22" />
            <path d="M2 6h1.972a4 4 0 0 1 3.6 2.2" />
            <path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45" />
        </StandardServiceTierIcon>
    )
}

export function ScaleServiceTierIcon(props: ServiceTierIconProps) {
    return (
        <StandardServiceTierIcon {...props}>
            <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
            <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
            <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
        </StandardServiceTierIcon>
    )
}

export function PriorityServiceTierIcon(props: ServiceTierIconProps) {
    return (
        <StandardServiceTierIcon {...props}>
            <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
        </StandardServiceTierIcon>
    )
}

export function UltrafastServiceTierIcon({ className, style, ...props }: ServiceTierIconProps) {
    return (
        <svg
            {...props}
            aria-hidden="true"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            style={{
                display: "block",
                flex: "0 0 auto",
                fontSize: "inherit",
                height: "1em",
                width: "1em",
                ...style,
            }}
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg">
            <path d="M3 7h4" data-ultrafast-part="speed-top" />
            <path d="M2 12h5" data-ultrafast-part="speed-middle" />
            <path d="M3 17h4" data-ultrafast-part="speed-bottom" />
            <path d="m14 2-7 11h6l-2 9 8-12h-6z" data-ultrafast-part="primary" />
        </svg>
    )
}

export const SERVICE_TIER_ICONS = {
    auto: AutoServiceTierIcon,
    default: DefaultServiceTierIcon,
    flex: FlexServiceTierIcon,
    scale: ScaleServiceTierIcon,
    priority: PriorityServiceTierIcon,
    ultrafast: UltrafastServiceTierIcon,
} satisfies Record<OpenAiServiceTier, ServiceTierIconComponent>
