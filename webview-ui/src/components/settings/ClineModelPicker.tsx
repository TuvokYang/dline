import OpenRouterModelPicker, { type OpenRouterModelPickerProps } from "./OpenRouterModelPicker"

/** Cline uses the shared gateway picker with its own catalog and Profile config. */
const ClineModelPicker = (props: OpenRouterModelPickerProps) => <OpenRouterModelPicker {...props} />

export default ClineModelPicker
