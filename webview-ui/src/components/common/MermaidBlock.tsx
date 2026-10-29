import { StringRequest } from "@shared/proto/dline/common"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import mermaid from "mermaid"
import { useEffect, useRef, useState } from "react"
import styled from "styled-components"
import { svgToDataUrl } from "@/components/common/mermaid-export"
import { FileServiceClient } from "@/services/grpc-client"
import { useDebounceEffect } from "@/utils/useDebounceEffect"

const MERMAID_THEME = {
    background: "#1e1e1e", // VS Code dark theme background
    textColor: "#ffffff", // Main text color
    mainBkg: "#2d2d2d", // Background for nodes
    nodeBorder: "#888888", // Border color for nodes
    lineColor: "#cccccc", // Lines connecting nodes
    primaryColor: "#3c3c3c", // Primary color for highlights
    primaryTextColor: "#ffffff", // Text in primary colored elements
    primaryBorderColor: "#888888",
    secondaryColor: "#2d2d2d", // Secondary color for alternate elements
    tertiaryColor: "#454545", // Third color for special elements

    // Class diagram specific
    classText: "#ffffff",

    // State diagram specific
    labelColor: "#ffffff",

    // Sequence diagram specific
    actorLineColor: "#cccccc",
    actorBkg: "#2d2d2d",
    actorBorder: "#888888",
    actorTextColor: "#ffffff",

    // Flow diagram specific
    fillType0: "#2d2d2d",
    fillType1: "#3c3c3c",
    fillType2: "#454545",
}

mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: "dark",
    themeVariables: {
        ...MERMAID_THEME,
        fontSize: "16px",
        fontFamily: "var(--vscode-font-family, 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif)",

        // Additional styling
        noteTextColor: "#ffffff",
        noteBkgColor: "#454545",
        noteBorderColor: "#888888",

        // Improve contrast for special elements
        critBorderColor: "#ff9580",
        critBkgColor: "#803d36",

        // Task diagram specific
        taskTextColor: "#ffffff",
        taskTextOutsideColor: "#ffffff",
        taskTextLightColor: "#ffffff",

        // Numbers/sections
        sectionBkgColor: "#2d2d2d",
        sectionBkgColor2: "#3c3c3c",

        // Alt sections in sequence diagrams
        altBackground: "#2d2d2d",

        // Links
        linkColor: "#6cb6ff",

        // Borders and lines
        compositeBackground: "#2d2d2d",
        compositeBorder: "#888888",
        titleColor: "#ffffff",
    },
})

interface MermaidBlockProps {
    code: string
}

export default function MermaidBlock({ code }: MermaidBlockProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const [isLoading, setIsLoading] = useState(false)

    // 1) Whenever `code` changes, mark that we need to re-render a new chart
    useEffect(() => {
        setIsLoading(true)
    }, [])

    // 2) Debounce the actual parse/render
    useDebounceEffect(
        () => {
            if (containerRef.current) {
                containerRef.current.innerHTML = ""
            }
            mermaid
                .parse(code, { suppressErrors: true })
                .then((isValid) => {
                    if (!isValid) {
                        throw new Error("Invalid or incomplete Mermaid code")
                    }
                    const id = `mermaid-${Math.random().toString(36).substring(2)}`
                    return mermaid.render(id, code)
                })
                .then(({ svg }) => {
                    if (containerRef.current) {
                        containerRef.current.innerHTML = svg
                    }
                })
                .catch((err) => {
                    console.warn("Mermaid parse/render failed:", err)
                    containerRef.current!.innerHTML = code.replace(/</g, "&lt;").replace(/>/g, "&gt;")
                })
                .finally(() => {
                    setIsLoading(false)
                })
        },
        500, // Delay 500ms
        [code], // Dependencies for scheduling
    )

    /**
     * Called when user clicks the rendered diagram.
     * Exports a static SVG and sends it to the extension.
     */
    const handleClick = async () => {
        if (!containerRef.current) {
            return
        }
        const svgEl = containerRef.current.querySelector("svg")
        if (!svgEl) {
            return
        }

        try {
            const svgDataUrl = await svgToDataUrl(svgEl, { backgroundColor: MERMAID_THEME.background })
            FileServiceClient.openImage(StringRequest.create({ value: svgDataUrl })).catch((err) =>
                console.error("Failed to open image:", err),
            )
        } catch (err) {
            console.error("Error preparing Mermaid SVG preview:", err)
        }
    }

    const handleCopyCode = async () => {
        try {
            await navigator.clipboard.writeText(code)
        } catch (err) {
            console.error("Copy failed", err)
        }
    }

    return (
        <MermaidBlockContainer>
            {isLoading && <LoadingMessage>Generating mermaid diagram...</LoadingMessage>}
            <ButtonContainer>
                <StyledVSCodeButton aria-label="Copy Code" onClick={handleCopyCode} title="Copy Code">
                    <span className="codicon codicon-copy" />
                </StyledVSCodeButton>
            </ButtonContainer>
            <SvgContainer $isLoading={isLoading} onClick={handleClick} ref={containerRef} />
        </MermaidBlockContainer>
    )
}

const MermaidBlockContainer = styled.div`
	position: relative;
	margin: 8px 0;
`

const ButtonContainer = styled.div`
	position: absolute;
	top: 8px;
	right: 8px;
	z-index: 1;
	opacity: 0.6;
	transition: opacity 0.2s ease;

	&:hover {
		opacity: 1;
	}
`

const LoadingMessage = styled.div`
	padding: 8px 0;
	color: var(--vscode-descriptionForeground);
	font-style: italic;
	font-size: 0.9em;
`

interface SvgContainerProps {
    $isLoading: boolean
}

const SvgContainer = styled.div<SvgContainerProps>`
	opacity: ${(props) => (props.$isLoading ? 0.3 : 1)};
	min-height: 20px;
	transition: opacity 0.2s ease;
	cursor: pointer;
	display: flex;
	justify-content: center;
`

const StyledVSCodeButton = styled(VSCodeButton)`
	padding: 4px;
	height: 24px;
	width: 24px;
	min-width: unset;
	background-color: var(--vscode-button-secondaryBackground);
	color: var(--vscode-button-secondaryForeground);
	border: 1px solid var(--vscode-button-border);
	border-radius: 3px;
	display: flex;
	align-items: center;
	justify-content: center;
	transition: all 0.2s ease;

	.codicon {
		font-size: 14px;
	}

	&:hover {
		background-color: var(--vscode-button-secondaryHoverBackground);
		border-color: var(--vscode-button-border);
		transform: translateY(-1px);
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
	}

	&:active {
		transform: translateY(0);
		box-shadow: none;
	}
`
