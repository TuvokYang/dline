import { TELEMETRY_CATEGORIES, type TelemetryCategory } from "../events/catalog"

/**
 * Which switchable event categories are collecting.
 *
 * Separate from user consent on purpose: consent decides whether telemetry
 * exists at all, while a category decides whether one noisy feature
 * contributes to it. Conflating them would mean silencing a chatty feature
 * required withdrawing reporting entirely.
 */
export class TelemetryCategoryPolicy {
    private readonly disabled = new Set<TelemetryCategory>()

    /**
     * Categories default to enabled.
     *
     * A category that has never been configured is one nobody has asked to
     * silence, so treating the unknown case as "off" would quietly drop events
     * whenever a new category is introduced.
     */
    isEnabled(category: TelemetryCategory): boolean {
        return !this.disabled.has(category)
    }

    setEnabled(category: TelemetryCategory, enabled: boolean): void {
        if (enabled) {
            this.disabled.delete(category)
        } else {
            this.disabled.add(category)
        }
    }

    /** Every category this policy knows about. */
    categories(): readonly TelemetryCategory[] {
        return TELEMETRY_CATEGORIES
    }
}
