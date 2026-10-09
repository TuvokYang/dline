import { LoaderCircle } from "lucide-react"
import type { HistoryTaskOpening } from "@/hooks/useHistoryTaskOpening"

/** Never render the previous Task's actions under a pending history selection. */
export function HistoryTaskOpeningView({ opening: _opening }: { opening: HistoryTaskOpening }) {
	return (
		<section
			aria-busy="true"
			aria-live="polite"
			className="flex flex-1 flex-col gap-4 p-4"
			data-testid="history-task-opening">
			<div className="flex items-center gap-2 text-description" role="status">
				<LoaderCircle aria-hidden="true" className="animate-spin" size={16} />
				Opening task…
			</div>
		</section>
	)
}
