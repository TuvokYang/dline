# Dline Extension API

Dline exports a small API for other VS Code extensions. The TypeScript interface keeps its existing name for source compatibility; the extension identity and runtime are Dline-owned.

1. Copy `src/exports/cline.d.ts` into the consuming extension, or provide an equivalent local declaration.
2. Add the installed distribution's ID to `extensionDependencies` when Dline must be activated first: `tuvokyangdline.dline` for the VS Code Marketplace package, or `tuvokyang.dline` for Open VSX.
3. Resolve the Dline extension and call the exported compatibility interface:

```ts
import type { ClineAPI } from "./cline"
import * as vscode from "vscode"

const dlineExtension = vscode.extensions.getExtension<ClineAPI>("tuvokyangdline.dline")
if (!dlineExtension) {
    throw new Error("Dline is not installed")
}

const dline = dlineExtension.isActive ? dlineExtension.exports : await dlineExtension.activate()
await dline.startNewTask("Inspect the current workspace")
await dline.sendMessage("Summarize the findings")
```

The exported methods are declared in `src/exports/cline.d.ts`:

- `startNewTask(task?, images?)`;
- `sendMessage(message?, images?)`;
- `pressPrimaryButton()`;
- `pressSecondaryButton()`.

The example targets the VS Code Marketplace distribution. Open VSX consumers must resolve `tuvokyang.dline` instead; Insiders uses the `dline-insiders` extension name under the corresponding publisher. The compatibility interface name does not determine extension identity.
