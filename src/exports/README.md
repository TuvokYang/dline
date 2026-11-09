# Dline Extension API

Dline exports a small API for other VS Code extensions.

1. Copy `src/exports/dline.d.ts` into the consuming extension, or provide an equivalent local declaration.
2. Add `tuvokyang.dline` to `extensionDependencies` when Dline must be activated first.
3. Resolve the Dline extension and call the exported compatibility interface:

```ts
import type { DlineAPI } from "./dline"
import * as vscode from "vscode"

const dlineExtension = vscode.extensions.getExtension<DlineAPI>("tuvokyang.dline")
if (!dlineExtension) {
    throw new Error("Dline is not installed")
}

const dline = dlineExtension.isActive ? dlineExtension.exports : await dlineExtension.activate()
await dline.startNewTask("Inspect the current workspace")
await dline.sendMessage("Summarize the findings")
```

The exported methods are declared in `src/exports/dline.d.ts`:

- `startNewTask(task?, images?)`;
- `sendMessage(message?, images?)`;
- `pressPrimaryButton()`;
- `pressSecondaryButton()`.

`tuvokyang.dline` is the canonical extension ID. The VS Code Marketplace build publishes the same extension under a separate registry-wide unique identity, `tuvokyangdline.dline-main`, so consumers resolving the Marketplace package must use that ID instead; Insiders uses the `dline-insiders` extension name under the corresponding publisher. The exported interface name does not determine extension identity.
