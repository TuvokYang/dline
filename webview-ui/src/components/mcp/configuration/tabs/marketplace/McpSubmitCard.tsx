const McpSubmitCard = () => {
    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "12px",
                padding: "15px",
                margin: "20px",
                backgroundColor: "var(--vscode-textBlockQuote-background)",
                borderRadius: "6px",
            }}>
            {/* Icon */}
            <i className="codicon codicon-add" style={{ fontSize: "18px" }} />

            {/* Content */}
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "4px",
                    textAlign: "center",
                    maxWidth: "480px",
                }}>
                <h3
                    style={{
                        margin: 0,
                        fontSize: "14px",
                        fontWeight: 600,
                        color: "var(--vscode-foreground)",
                    }}>
                    Submit MCP Server
                </h3>
                <p style={{ fontSize: "13px", margin: 0, color: "var(--vscode-descriptionForeground)" }}>
                    Suggest an MCP server through the{" "}
                    <a href="https://github.com/TuvokYang/Dline/issues/new">Dline issue tracker</a>
                </p>
            </div>
        </div>
    )
}

export default McpSubmitCard
