/**
 * Task history, the Recent preview and its completion/usage wrappers.
 *
 * Task titles, model identifiers, timestamps and money values are data, not
 * translation units; only the product-owned wrapper text lives here.
 */
export const en = {
    "shell.history.title": "History",
    "shell.history.searchPlaceholder": "Fuzzy search history...",
    "shell.history.clearSearch": "Clear search",
    "shell.history.sort.newest": "Newest",
    "shell.history.sort.oldest": "Oldest",
    "shell.history.sort.mostExpensive": "Most Expensive",
    "shell.history.sort.mostTokens": "Most Tokens",
    "shell.history.sort.mostRelevant": "Most Relevant",
    "shell.history.filter.workspaceOnly": "Workspace Only",
    "shell.history.filter.favoritesOnly": "Favorites Only",
    "shell.history.group.today": "Today",
    "shell.history.group.older": "Older",
    "shell.history.selectAll": "Select All",
    "shell.history.selectNone": "Select None",
    "shell.history.deleteSelected": "Delete selected items",
    // The count is omitted for a single selection, matching the original button that
    // read "Delete Selected"; a multi-selection names how many rows it will remove.
    "shell.history.deleteSelectedCount": ({ count, size }: { count: number; size: string }) =>
        `${count > 1 ? `Delete ${count} Selected` : "Delete Selected"}${size === "" ? "" : ` (${size})`}`,
    "shell.history.deleteAll": "Delete all history",
    "shell.history.deleteAllCount": ({ size }: { size: string }) => `Delete All History${size === "" ? "" : ` (${size})`}`,
    "shell.history.lockedSingle": "This task is currently in use by another instance and cannot be deleted.",
    "shell.history.lockedMany": ({ count }: { count: number }) =>
        `${count} task(s) are currently in use by another instance and were not deleted.`,

    "shell.historyItem.openTask": "Open Task",
    "shell.historyItem.opening": "Opening task",
    "shell.historyItem.openInNewWindow": "Open in New Window",
    "shell.historyItem.delete": "Delete",
    "shell.historyItem.addFavorite": "Add to favorites",
    "shell.historyItem.removeFavorite": "Remove from favorites",
    "shell.historyItem.export": "Export",
    "shell.historyItem.tokens": "Tokens:",
    "shell.historyItem.model": "Model:",
    "shell.historyItem.size": "Size:",

    "shell.historyOpening.message": "Opening task…",

    "shell.completion.completed": "Completed",

    "shell.historyPreview.recent": "Recent",
    "shell.historyPreview.viewAll": "View All",
    "shell.historyPreview.filterGroup": "Recent task filter",
    "shell.historyPreview.filter.workspace": "Workspace",
    "shell.historyPreview.filter.favorite": "Favorite",
    "shell.historyPreview.filter.all": "All",
    "shell.historyPreview.favorited": "Favorited",
    "shell.historyPreview.lastEdited": ({ timestamp }: { timestamp: string }) => `Last edited ${timestamp}`,
    "shell.historyPreview.empty": "No recent tasks",

    "shell.taskUsage.totalCost": "Total cost",
    "shell.taskUsage.tokens": ({ count }: { count: string }) => `${count} tokens`,
    "shell.taskUsage.totalTokens": ({ count }: { count: string }) => `Total tokens: ${count}`,
} as const
