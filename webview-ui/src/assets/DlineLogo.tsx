import type { SVGProps } from "react"
import type { Environment } from "../../../src/shared/config-types"
import { getEnvironmentColor } from "../utils/environmentColors"
import { DLINE_MARK_PATH, DLINE_MARK_SLEEPY_PATH, DLINE_MARK_VIEW_BOX } from "./dlineMarkPaths"

export type DlineLogoExpression = "default" | "sleepy"

export interface DlineLogoProps extends Omit<SVGProps<SVGSVGElement>, "color"> {
	/** Fill color. Defaults to the environment color, or to the theme's icon color. */
	color?: string
	/** Tints the robot to flag local and staging builds. */
	environment?: Environment
	/** `sleepy` is the Lazy Teammate Mode face. */
	expression?: DlineLogoExpression
	/** Adds the December Santa hat. */
	festive?: boolean
}

/**
 * The Dline robot. The paths are generated from the brand geometry in
 * scripts/brand/dline-mark.mjs, so the Webview, the extension icons and the
 * docs site share one design.
 */
const DlineLogo = ({ color, environment, expression = "default", festive = false, ...svgProps }: DlineLogoProps) => {
	const fill = color ?? (environment ? getEnvironmentColor(environment) : "var(--vscode-icon-foreground)")
	return (
		<svg height="32" viewBox={DLINE_MARK_VIEW_BOX} width="32" xmlns="http://www.w3.org/2000/svg" {...svgProps}>
			<title>Dline</title>
			<path d={expression === "sleepy" ? DLINE_MARK_SLEEPY_PATH : DLINE_MARK_PATH} fill={fill} />
			{festive && <SantaHat />}
		</svg>
	)
}

/** Santa hat on the robot's head; it covers the antenna. */
const SantaHat = () => (
	<g>
		<path d="M6.6 10Q9 2.2 17.6 2.4Q24.6 2.8 27.2 7.4Q23.4 5.4 19.8 6.4Q23.8 8 25.4 10Z" fill="#CC3333" />
		<rect fill="white" height="3.2" rx="1.6" width="22" x="5" y="8.9" />
		<circle cx="27.2" cy="7.6" fill="white" r="2.1" />
	</g>
)

export default DlineLogo
