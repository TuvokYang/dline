# Connect a Model Provider

Dline sends model requests through API Profiles that you configure. A Profile selects its provider, endpoint, model, and model-specific options; credentials are resolved from Dline's local credential stores.

1. Open **Settings → API Configuration**.
2. Create or edit a Profile for the provider and model you want to use.
3. Mark whether the Profile is available for **Plan**, **Act**, or **Subagents**. Plan and Act can use separate selections when that setting is enabled; named subagents choose from eligible Profiles.

Credentials are stored locally through Dline's credential stores, separate from task messages and Profile documents.

[Open API Configuration](command:dline.settingsButtonClicked) · [Read the Dline configuration guide](https://docs.dline.cc/getting-started/config/)