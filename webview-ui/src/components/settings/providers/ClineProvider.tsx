import { ClineAccountInfoCard } from "../ClineAccountInfoCard"
import ClineModelPicker from "../ClineModelPicker"
import type { ApiProfile } from "./ProviderProfile"

/**
 * Props for the ClineProvider component
 */
interface ClineProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	/** NEW: ApiProfile for profile-driven config (preferred when provided) */
	profile?: ApiProfile
	/** NEW: Callback to persist profile updates */
	onUpdate?: (updates: Partial<ApiProfile>) => void
}

/**
 * The Cline provider configuration component.
 * Delegates model selection to ClineModelPicker.
 */
export const ClineProvider = ({ showModelOptions, isPopup, profile: _profile, onUpdate: _onUpdate }: ClineProviderProps) => {
	return (
		<div>
			{/* Cline Account Info Card */}
			<div style={{ marginBottom: 14, marginTop: 4 }}>
				<ClineAccountInfoCard />
			</div>

			{showModelOptions && <ClineModelPicker isPopup={isPopup} showProviderRouting={true} />}
		</div>
	)
}
