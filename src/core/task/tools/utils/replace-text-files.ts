import { glob } from "fast-glob"

const REPLACE_TEXT_IGNORES = ["node_modules/**", ".git/**", "dist/**", "build/**"]

/** Resolve the exact files a replace_text call would inspect, relative to the Task workspace. */
export async function findReplaceTextFiles(cwd: string, filePattern: string): Promise<string[]> {
	return glob(filePattern, {
		cwd,
		absolute: true,
		dot: true,
		onlyFiles: true,
		ignore: REPLACE_TEXT_IGNORES,
	})
}
