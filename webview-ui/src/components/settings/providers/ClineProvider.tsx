import { ClineAccountInfoCard } from "../ClineAccountInfoCard"
import ClineModelPicker from "../ClineModelPicker"
import type { ApiProfile } from "./ProviderProfile"

/**
 * Props for the ClineProvider component
 */
interface ClineProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	profile: ApiProfile
	onUpdate: (updates: Partial<ApiProfile>) => void
}

/**
 * The Cline provider configuration component.
 * Delegates model selection to ClineModelPicker.
 */
export const ClineProvider = ({ showModelOptions, isPopup, profile, onUpdate }: ClineProviderProps) => {
	return (
		<div>
			{/* Cline Account Info Card */}
			<div style={{ marginBottom: 14, marginTop: 4 }}>
				<ClineAccountInfoCard />
			</div>

			{showModelOptions && (
				<ClineModelPicker isPopup={isPopup} onUpdate={onUpdate} profile={profile} showProviderRouting={true} />
			)}
		</div>
	)
}
