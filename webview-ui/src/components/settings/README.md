# API Options Component Architecture

This directory contains the refactored API Options components for the Cline extension. The refactoring aims to improve maintainability, code organization, and reduce complexity by separating provider-specific code into modular components.

## Directory Structure

```
settings/
├── ApiOptions.tsx               # Main component that renders provider-specific components
├── common/                      # Reusable UI components
│   ├── ApiKeyField.tsx         # API key input with standard styling
│   ├── BaseUrlField.tsx        # Base URL input with standard styling
│   ├── ErrorMessage.tsx        # Standard error message display
│   ├── ModelInfoView.tsx       # Model information display
│   └── ModelSelector.tsx       # Model selection dropdown
├── providers/                   # Provider-specific components
│   ├── ClineProvider.tsx       # Cline configuration
│   ├── AnthropicProvider.tsx   # Anthropic-specific configuration
│   ├── BedrockProvider.tsx     # AWS Bedrock configuration
│   ├── GeminiProvider.tsx      # Google Gemini configuration
│   ├── MistralProvider.tsx     # Mistral configuration
│   ├── OllamaProvider.tsx      # Ollama configuration
│   ├── OpenAIProvider.tsx            # Unified OpenAI official/custom API configuration
│   ├── OpenRouterProvider.tsx  # OpenRouter configuration
│   └── ...
└── utils/                       # Utility functions
    ├── pricingUtils.ts         # Pricing formatting utilities
    └── providerUtils.ts        # Static model catalog lookup per provider

```

## Architecture

### Component Hierarchy

```
ApiOptions
└── [ProviderComponent] (based on selected provider)
    ├── ApiKeyField (if needed)
    ├── BaseUrlField (if needed)
    ├── ModelSelector (if showing model options)
    └── ModelInfoView (if showing model options)
```

### Data Flow

1. `ApiOptions` resolves the `ApiProfile` used by the current mode; the profile's `provider` selects the component to render
2. Each provider component receives the `profile` and an `onUpdate` callback
3. Edits are written back as partial `ApiProfile` updates through `useApiProfiles().updateProfile`

## Adding a New Provider

To add a new provider:

1. Create a new file in the `providers` directory, e.g. `MyNewProvider.tsx`
2. Implement the provider component against the profile contract:

```tsx
import { resolveProfileModelId, resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { ApiKeyField } from "../common/ApiKeyField"
import { ModelAutocomplete } from "../common/ModelAutocomplete"
import { ModelInfoView } from "../common/ModelInfoView"
import type { ApiProfile } from "./ProviderProfile"
import { useProviderModelOptions } from "./useProviderModelOptions"

interface MyNewProviderProps {
  showModelOptions: boolean
  isPopup?: boolean
  profile: ApiProfile
  onUpdate: (updates: Partial<ApiProfile>) => void
}

export const MyNewProvider = ({ showModelOptions, isPopup, profile, onUpdate }: MyNewProviderProps) => {
  const { models, defaultModelId, options, optionOrigins, refreshRemoteModels } = useProviderModelOptions({
    providerId: "mynewprovider",
    profileId: profile.id,
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    selectedModelId: resolveProfileModelId(profile),
  })
  const modelId = resolveProfileModelId(profile, { defaultModelId })
  const modelInfo = resolveProfileModelInfo(profile, { models, defaultModelId })

  return (
    <div>
      <ApiKeyField
        initialValue={profile.apiKey}
        onChange={(value) => onUpdate({ apiKey: value })}
        providerName="My New Provider"
        signupUrl="https://mynewprovider.com/signup"
      />
      {showModelOptions && (
        <>
          <ModelAutocomplete
            label="Model"
            models={options}
            onChange={(newModelId) => onUpdate({ modelId: newModelId, modelInfo: models[newModelId] })}
            onOpen={refreshRemoteModels}
            optionOrigins={optionOrigins}
            selectedModelId={modelId}
          />
          <ModelInfoView isPopup={isPopup} modelInfo={modelInfo} selectedModelId={modelId} />
        </>
      )}
    </div>
  )
}
```

3. Render it from `ApiOptions.tsx` when the profile selects it:

```tsx
{currentProfile && selectedProvider === "mynewprovider" && (
  <MyNewProvider
    isPopup={isPopup}
    onUpdate={handleProfileUpdate}
    profile={currentProfile}
    showModelOptions={showModelOptions}
  />
)}
```

4. Register the provider in `PROVIDER_OPTIONS` (`src/shared/providers/providers.ts`) so it appears in the provider search.

## Best Practices

1. **Reuse Common Components**: Use the common components for consistent UI and behavior
2. **Provider-Specific Logic**: Keep provider-specific logic within the provider component
3. **Type Safety**: Ensure all props and state are properly typed
4. **Error Handling**: Handle edge cases gracefully, such as missing configurations
5. **Documentation**: Document any provider-specific behaviors or requirements

## Testing

Each provider component should be tested in isolation to ensure it renders correctly and handles user input properly.
