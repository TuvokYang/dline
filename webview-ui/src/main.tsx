import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./main.css"
import "./index.css"
import App from "./App.tsx"
import { RootErrorBoundary } from "./components/common/RootErrorBoundary"
import { installGlobalWebviewErrorReporting } from "./services/webviewErrorReporter"

installGlobalWebviewErrorReporting()

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<RootErrorBoundary>
			<App />
		</RootErrorBoundary>
	</StrictMode>,
)
