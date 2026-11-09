import { StringRequest } from "@shared/proto/dline/common"
import DOMPurify from "dompurify"
import React from "react"
import ChatErrorBoundary from "@/components/chat/ChatErrorBoundary"
import type { UiTranslator } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { WebServiceClient } from "@/services/grpc-client"
import { getSafeHostname, normalizeRelativeUrl } from "./utils/mcpRichUtil"

interface OpenGraphData {
    title?: string
    description?: string
    image?: string
    url?: string
    siteName?: string
    type?: string
}

interface LinkPreviewProps {
    url: string
}

interface LocalizedLinkPreviewProps extends LinkPreviewProps {
    t: UiTranslator
}

interface LinkPreviewState {
    loading: boolean
    error: ErrorType
    errorMessage: string | null
    ogData: OpenGraphData | null
    /**
     * Track if fetch has completed (success or error)
     */
    hasCompletedFetch: boolean
    /**
     * Track when the fetch started
     */
    fetchStartTime: number
}

// Error types for better UI feedback
type ErrorType = "timeout" | "network" | "general" | null

// Use a class component to ensure complete isolation between instances
class LinkPreview extends React.Component<LocalizedLinkPreviewProps, LinkPreviewState> {
    private messageListener: ((event: MessageEvent) => void) | null = null
    private timeoutId: NodeJS.Timeout | null = null
    private heartbeatId: NodeJS.Timeout | null = null

    constructor(props: LocalizedLinkPreviewProps) {
        super(props)
        this.state = {
            loading: true,
            error: null,
            errorMessage: null,
            ogData: null,
            hasCompletedFetch: false,
            fetchStartTime: 0,
        }
    }

    componentDidMount() {
        // Only fetch if we haven't completed a fetch yet
        if (!this.state.hasCompletedFetch) {
            this.fetchOpenGraphData()
        }
    }

    componentWillUnmount() {
        this.cleanup()
    }

    // Prevent updates if fetch has completed
    shouldComponentUpdate(nextProps: LocalizedLinkPreviewProps, nextState: LinkPreviewState) {
        // Translation changes update the existing instance, without fetching again.
        if (nextProps.url !== this.props.url || nextProps.t !== this.props.t) {
            return true
        }

        // If we've completed a fetch and state hasn't changed, prevent update
        if (
            this.state.hasCompletedFetch &&
            this.state.loading === nextState.loading &&
            this.state.error === nextState.error &&
            this.state.ogData === nextState.ogData
        ) {
            return false
        }

        return true
    }

    private cleanup() {
        // Clean up event listeners and timeouts
        if (this.messageListener) {
            window.removeEventListener("message", this.messageListener)
            this.messageListener = null
        }

        if (this.timeoutId) {
            clearTimeout(this.timeoutId)
            this.timeoutId = null
        }

        if (this.heartbeatId) {
            clearInterval(this.heartbeatId)
            this.heartbeatId = null
        }
    }

    private async fetchOpenGraphData() {
        try {
            // Record fetch start time
            const startTime = Date.now()
            this.setState({ fetchStartTime: startTime })

            // Use the gRPC client to fetch Open Graph data
            const response = await WebServiceClient.fetchOpenGraphData(
                StringRequest.create({
                    value: this.props.url,
                }),
            )

            // Process the response
            if (response) {
                const ogData: OpenGraphData = {
                    title: response.title || undefined,
                    description: response.description || undefined,
                    image: response.image || undefined,
                    url: response.url || undefined,
                    siteName: response.siteName || undefined,
                    type: response.type || undefined,
                }

                this.setState({
                    ogData,
                    loading: false,
                    hasCompletedFetch: true,
                })
            } else {
                this.setState({
                    error: "network",
                    errorMessage: null,
                    loading: false,
                    hasCompletedFetch: true,
                })
            }

            // Clean up the heartbeat interval
            // (No message listener is needed with gRPC, unlike the previous message-based approach)
            this.cleanup()

            // Set up heartbeat for loading indicator
            this.heartbeatId = setInterval(() => {
                const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000)
                if (elapsedSeconds > 0) {
                    this.forceUpdate() // Just update the component to show new elapsed time
                }
            }, 1000)
        } catch (err) {
            this.setState({
                error: "general",
                errorMessage: err instanceof Error ? err.message : String(err),
                loading: false,
                hasCompletedFetch: true, // Mark as completed on error
            })
            this.cleanup()
        }
    }

    render() {
        const { url, t } = this.props
        const { loading, error, errorMessage, ogData, fetchStartTime } = this.state

        // Calculate elapsed time for loading state
        const elapsedSeconds = loading ? Math.floor((Date.now() - fetchStartTime) / 1000) : 0

        // Fallback display while loading
        if (loading) {
            return (
                <div
                    className="link-preview-loading"
                    style={{
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        border: "1px solid var(--vscode-editorWidget-border, rgba(127, 127, 127, 0.3))",
                        borderRadius: "4px",
                        height: "128px",
                        maxWidth: "512px",
                    }}>
                    <div style={{ display: "flex", alignItems: "center", marginBottom: "8px" }}>
                        <div
                            className="loading-spinner"
                            style={{
                                marginRight: "8px",
                                width: "16px",
                                height: "16px",
                                border: "2px solid rgba(127, 127, 127, 0.3)",
                                borderTopColor: "var(--vscode-textLink-foreground, #3794ff)",
                                borderRadius: "50%",
                                animation: "spin 1s linear infinite",
                            }}
                        />
                        <style>
                            {`
								@keyframes spin {
									to { transform: rotate(360deg); }
								}
							`}
                        </style>
                        {t("capabilities.mcp.loadingPreview", { host: getSafeHostname(url) })}
                    </div>
                    {elapsedSeconds > 5 && (
                        <div style={{ fontSize: "11px", color: "var(--vscode-descriptionForeground)" }}>
                            {elapsedSeconds > 60
                                ? t("capabilities.mcp.waitingMinutes", {
                                      minutes: Math.floor(elapsedSeconds / 60),
                                      seconds: elapsedSeconds % 60,
                                  })
                                : t("capabilities.mcp.waitingSeconds", { seconds: elapsedSeconds })}
                        </div>
                    )}
                </div>
            )
        }

        // Handle different error states with specific messages
        if (error) {
            let errorDisplay = t("capabilities.mcp.previewError")

            if (error === "timeout") {
                errorDisplay = t("capabilities.mcp.previewTimeout")
            } else if (error === "network") {
                errorDisplay = t("capabilities.mcp.previewNetwork")
            }

            return (
                <div
                    className="link-preview-error"
                    onClick={async () => {
                        try {
                            await WebServiceClient.openInBrowser(
                                StringRequest.create({
                                    value: DOMPurify.sanitize(url),
                                }),
                            )
                        } catch (err) {
                            console.error("Error opening URL in browser:", err)
                        }
                    }}
                    style={{
                        padding: "12px",
                        border: "1px solid var(--vscode-editorWidget-border, rgba(127, 127, 127, 0.3))",
                        borderRadius: "4px",
                        color: "var(--vscode-errorForeground)",
                        height: "128px",
                        maxWidth: "512px",
                        overflow: "auto",
                    }}>
                    <div style={{ fontWeight: "bold" }}>{errorDisplay}</div>
                    <div style={{ fontSize: "12px", marginTop: "4px" }}>{getSafeHostname(url)}</div>
                    {errorMessage && (
                        <details style={{ fontSize: "11px", marginTop: "4px", opacity: 0.8 }}>
                            <summary>{t("capabilities.diagnostics")}</summary>
                            {errorMessage}
                        </details>
                    )}
                    <div style={{ fontSize: "11px", marginTop: "8px", color: "var(--vscode-textLink-foreground)" }}>
                        {t("capabilities.mcp.openInBrowser")}
                    </div>
                </div>
            )
        }

        // Create a fallback object if ogData is null
        const data = ogData || {
            title: getSafeHostname(url),
            description: t("capabilities.mcp.noPreviewDescription"),
            siteName: getSafeHostname(url),
            url: url,
        }

        // Render the Open Graph preview
        return (
            <div
                className="link-preview"
                onClick={async () => {
                    try {
                        await WebServiceClient.openInBrowser(
                            StringRequest.create({
                                value: DOMPurify.sanitize(url),
                            }),
                        )
                    } catch (err) {
                        console.error("Error opening URL in browser:", err)
                    }
                }}
                style={{
                    display: "flex",
                    border: "1px solid var(--vscode-editorWidget-border, rgba(127, 127, 127, 0.3))",
                    borderRadius: "4px",
                    overflow: "hidden",
                    cursor: "pointer",
                    height: "128px",
                    maxWidth: "512px",
                }}>
                {data.image && (
                    <div className="link-preview-image" style={{ width: "128px", height: "128px", flexShrink: 0 }}>
                        <img
                            alt=""
                            onError={(e) => {
                                console.log(`Image could not be loaded: ${data.image}`)
                                // Hide the broken image
                                ;(e.target as HTMLImageElement).style.display = "none"
                            }}
                            onLoad={(e) => {
                                // Check aspect ratio to determine if we should use contain or cover
                                const img = e.currentTarget
                                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                                    const aspectRatio = img.naturalWidth / img.naturalHeight

                                    // Use contain for extreme aspect ratios (logos), cover for photos
                                    if (aspectRatio > 2.5 || aspectRatio < 0.4) {
                                        img.style.objectFit = "contain"
                                    } else {
                                        img.style.objectFit = "cover"
                                    }
                                }
                            }}
                            src={DOMPurify.sanitize(normalizeRelativeUrl(data.image, url))}
                            style={{
                                width: "100%",
                                height: "100%",
                                objectFit: "contain", // Use contain for link preview thumbnails to handle logos
                                objectPosition: "center", // Center the image
                            }}
                        />
                    </div>
                )}

                <div
                    className="link-preview-content"
                    style={{
                        flex: 1,
                        padding: "12px",
                        display: "flex",
                        flexDirection: "column",
                        overflow: "hidden",
                        height: "100%", // Ensure full height
                    }}>
                    {/* Top section with title and URL - top aligned */}
                    <div className="link-preview-top">
                        <div
                            className="link-preview-title"
                            style={{
                                fontWeight: "bold",
                                marginBottom: "4px",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                            }}>
                            {data.title || t("capabilities.mcp.noTitle")}
                        </div>

                        <div
                            className="link-preview-url"
                            style={{
                                fontSize: "12px",
                                color: "var(--vscode-textLink-foreground, #3794ff)",
                                marginBottom: "8px", // Increased for better separation
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                            }}>
                            {data.siteName || getSafeHostname(url)}
                        </div>
                    </div>

                    {/* Description with space-around in the remaining space */}
                    <div
                        className="link-preview-description-container"
                        style={{
                            flex: 1, // Take up remaining space
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "space-around", // Space around in the remaining area
                        }}>
                        <div
                            className="link-preview-description"
                            style={{
                                fontSize: "12px",
                                color: "var(--vscode-descriptionForeground, rgba(204, 204, 204, 0.7))",
                                overflow: "hidden",
                                display: "-webkit-box",
                                WebkitLineClamp: 3,
                                WebkitBoxOrient: "vertical",
                                textOverflow: "ellipsis",
                            }}>
                            {data.description || t("capabilities.mcp.noPreviewDescription")}
                        </div>
                    </div>
                </div>
            </div>
        )
    }
}

// Create a wrapper component that memoizes the LinkPreview to prevent unnecessary re-renders
const MemoizedLinkPreview = React.memo(
    (props: LocalizedLinkPreviewProps) => <LinkPreview {...props} />,
    (prevProps, nextProps) => prevProps.url === nextProps.url && prevProps.t === nextProps.t,
)

// Wrap the LinkPreview component with an error boundary
const LinkPreviewWithErrorBoundary: React.FC<LinkPreviewProps> = (props) => {
    const { t } = useUiTranslation()
    return (
        <ChatErrorBoundary errorBody={t("capabilities.mcp.boundaryBody")} errorTitle={t("capabilities.mcp.linkBoundary")}>
            <MemoizedLinkPreview {...props} t={t} />
        </ChatErrorBoundary>
    )
}

export default LinkPreviewWithErrorBoundary
