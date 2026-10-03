import { LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { HistoryTaskOpening } from "@/hooks/useHistoryTaskOpening"

/** Never render the previous Task's actions under a pending history selection. */
export function HistoryTaskOpeningView({
	opening,
	onRetry,
	onBack,
}: {
	opening: HistoryTaskOpening
	onRetry: () => void
	onBack: () => void
}) {
	const failed = opening.status === "failed"
	return (
		<section
			aria-busy={!failed}
			aria-live="polite"
			className="flex flex-1 flex-col gap-4 p-4"
			data-testid="history-task-opening">
			<div className="ph-no-capture break-words font-medium">{opening.target.task}</div>
			<div className="flex items-center gap-2 text-description" role={failed ? "alert" : "status"}>
				{!failed && <LoaderCircle aria-hidden="true" className="animate-spin" size={16} />}
				{failed ? "Could not open this task. Retry or return to history." : "Opening task history…"}
			</div>
			{failed && (
				<div className="flex gap-2">
					<Button onClick={onRetry}>Retry</Button>
					<Button onClick={onBack} variant="secondary">
						Back to history
					</Button>
				</div>
			)}
		</section>
	)
}
