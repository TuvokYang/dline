import react from "@vitejs/plugin-react-swc"
import { defineConfig } from "vitest/config"
import { webviewProjectConfig } from "./vitest.project"

export default defineConfig({
	...webviewProjectConfig,
	plugins: [react()],
})
