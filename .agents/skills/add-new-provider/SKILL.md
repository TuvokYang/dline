---
name: add-new-provider
description: Implement or diagnose Dline provider Profile, handler, metadata authority, catalog-source/plan changes, listing triggers, formats, usage, quota and settings; use integrate-new-provider for the full integration workflow.
---

# Add a New Dline Provider

Use for provider development, adding a plan/catalog key, or changing where a provider's models come from; not for editing a single model entry or prompt text. Read an analogous Profile, handler, model metadata, remote source, settings component and tests first. Load `integrate-new-provider` for a new provider's long implementation workflow; use the relevant technical topics here for targeted changes without running that whole workflow.

---

Handler/model-fact ownership and the separate token, request-cost and account-quota contracts are defined in `dline-overview`. The following topics show how to implement them.

---

## Decide the Metadata Authority

Answer "who knows this model?" before writing any reader. This determines whether local catalog entries, remote listing, or both supply the catalog.

| Vendor shape | Authority | Consequence |
| --- | --- | --- |
| Relay or gateway that resells other vendors' models | Remote listing only | Write no model entries. The vendor owns the set, the versioning, and the price. |
| First-party model vendor | Local catalog + remote listing | The catalog carries what the listing cannot: display names, context-window tiers, thinking controls, server tools, media types, defaults. The listing adds ids released after this build. |
| Local runtime or self-hosted server | Remote listing only, with a manual fallback | The user's machine decides the set. Never ship a guess. |

Then decide, explicitly:

- whether one selectable catalog key maps to one provider id, or several plans map to one source;
- whether the listing needs credentials to answer;
- which `ApiFormat` families the provider can carry;
- whether the provider reports a per-request charge, account quota, both, or neither;
- whether the provider needs provider-specific settings beyond the shared fields.

State the chosen authority in the provider's source header so the next reader does not add a second copy.

---

## Profile Contract

For a new provider, establish its identity before wiring the UI. For an existing provider's plan or catalog change, keep the provider identity and handler and change only the affected config/catalog selection. `opencode-go` in `allProviderModels.opencode.catalogs` is the existing example of a catalog key that is not a provider id.

1. For a new provider, add its id to `ApiProvider` in `src/shared/api.ts`; an existing provider's plan keeps that id.
2. Add a new provider's `ProviderModelsConfig` entry to `allProviderModels` in `src/core/api/providers/models/index.ts`, with its name, models, billing mode and applicable endpoint/default metadata. `PROVIDER_OPTIONS` in `src/shared/providers/providers.ts` is derived from this registry. For an existing provider's alternative model set, extend its `catalogs` and Profile-to-catalog selection instead of adding a selectable provider. Do not invent a default model for an initially empty remote catalog.
3. Reuse `BaseProviderConfig` when shared model fields suffice; DeepSeek and Nebius already use it in `proto/dline/profile.proto`. Create `proto/dline/provider/<provider>.proto` only for provider-specific fields such as a plan, region or separate account endpoint, using the `dline.provider` namespace.
4. Add a `oneof provider_config` arm only when the chosen stored contract needs a new one. An existing provider's plan normally keeps its arm. Adding an arm is a **persisted contract change**; confirm it with the user before implementing, and never reuse a field number.
5. Run `npm run protos`. Never edit generated output.
6. Lift the provider's typed config from the Profile. Read and write its **shared fields** through `readProviderConfigField` / `withProviderConfigField` in `src/shared/providers/provider-config.ts`; their `ProviderConfigField` union is not an arbitrary-key API. Read and immutably update provider-specific fields through that typed config. `OpenCodeProvider` uses the helpers for `apiFormat` and `reasoning`, but updates its own `mode` field in `changePlan`.
7. Bump `schema_version` on the `ApiProfile` message only when an older stored profile cannot be read as written, and add the migration in the same change.

Acceptance: an existing stored profile still loads, and every changed config field round-trips through save and reload. A new oneof arm is tested only when the chosen contract adds one.

---

## Handler

File: `src/core/api/providers/<provider>.ts`, registered in the construction switch in `src/core/api/index.ts`.

The base class `src/core/api/ApiHandler.ts` is the only implementation owner of real-send observation. A provider overrides provider-specific behavior and nothing else.

Required:
- `createMessage(systemPrompt, messages, tools?, options?)` returning `ApiStream`;
- `getModel()` returning `{ id, info }` resolved from the Profile.

Optional, each with a real reason:
- `parseError(error, modelId?)` — see Error Parsing;
- `getAccountUsage()` and `supportsAccountUsagePolling` — see Account Usage;
- the handler's `getApiStreamUsage()` method when usage is available out of band; `ApiHandlerModel` returned by `getModel()` contains `id` and `info`, not this callback;
- `abort()` that cancels every in-flight request the handler owns;
- `getSelectedApiFormat()` when the effective format differs from the stored default;
- `countInputTokens`, `supportsServerTool`, `getDisabledServerTools` only when the provider really implements them.

Rules:
- Build every HTTP call through the shared transport in `@shared/net`. A bare global `fetch` compiles, bypasses proxy configuration, and escapes the test double.
- Use the shared OpenAI-compatible client factory where one exists instead of constructing an SDK client.
- Bound every request with a timeout and an `AbortSignal`; propagate cancellation to the underlying request.
- Sanitize errors before they leave the handler: no keys, headers, or request bodies.

Acceptance: `abort()` cancels both the streaming request and any auxiliary request; an aborted call resolves as a cancelled stream, not an unhandled rejection.

---

## Local Catalog Entries

Skip local entries when the metadata-authority decision is remote-only.

Catalog file: `src/core/api/providers/models/<provider>.ts`, wired through `allProviderModels` in `src/core/api/providers/models/index.ts`.

When adding or changing an entry:

1. Record what the vendor's documentation states, with the page and date in the file header. A guessed context window or price silently misconfigures compaction and billing.
2. Declare only the facts this provider's listing cannot express: display name, `capabilities`, thinking effort levels and budget bounds, context-window tiers, input media types, hosted server tools, defaults.
3. Do not restate a limit, a price, or a capability flag the listing publishes for the same provider. Two copies create a defect that appears only when they disagree.
4. Keep `id` identical to the id the vendor accepts on the wire. A display name is `name`.
5. Leave an unpublished price or limit absent. An absent value reads as unknown; a fabricated `0` reads as free.
6. Never invent `apiFormats`. Derive them, and keep them a default.

Acceptance: for each fact in the entry, you can name the source that owns it — catalog or listing — and no fact appears twice.

---

## Remote Listing Source

Five layers; do not invent a parallel path.

| Layer | File |
| --- | --- |
| Contract | `src/core/model-registry/remote/model-source.ts` |
| Shared base | `src/core/model-registry/remote/model-listing-source.ts` |
| Vendor implementation | `src/core/model-registry/remote/vendors/<provider>.ts` |
| Registry | `src/core/model-registry/remote/vendors/index.ts` |
| Orchestration | `src/core/model-registry/remote/model-refresh.ts` |

For a vendor exposing a supported listing, extend `ModelListingSource` and implement only what the vendor differs on. `ProviderRemoteSource` is the contract for a source needing a different implementation. A curated/manual provider without a listing does not need a guessed source or endpoint.

The common listing subclass exposes:

- `providerId`, `providerName`, `billingMode`, `reconciliation`;
- `defaultBaseUrl` — required; the endpoint used when the Profile carries no base URL;
- `requiresApiKey` — defaults to `true`. Set it to `false` only when the listing answers without credentials; otherwise discovery returns an empty result before any request is sent;
- `preferredDefaultModelId` when a catalog default is gone;
- `buildListingUrl` — the listing path is often not the inference base path;
- `buildHeaders` — when the vendor needs more than a bearer token;
- `readPageEntries` / `fetchAllPages` — for a payload that is not one `{ data: [...] }` page;
- `readPricing`, `readCapabilities`, `readContextWindow`, `readMaxTokens`, `readModelName` — one reader per fact the vendor spells differently;
- `isChatModel` — drop entries whose API family this build has no front end for;
- `fetchModels(context)` — override only when the whole listing needs a different shape. Otherwise let the base class translate entries into plain `ModelInfo` records. No vendor wire format may leak past this file.

Register the instance in `MODEL_SOURCES`. When a selectable catalog key is not the provider id, add it to `CATALOG_KEY_OWNERS` so the settings form resolves the key to its owning source.

`reconciliation` decides how the persisted catalog combines with the listing (`src/core/model-registry/provider-model-reconciliation.ts`):

| Mode | Use it when |
| --- | --- |
| `replace` | The listing is the whole truth, as for a relay. Stored entries that disappear are dropped. |
| `overlay-remote` | The listing supplements curated metadata. Stored entries survive, and `userDefined` models are never overwritten. |
| `fill-missing` | Stored entries win for known ids; local metadata only fills gaps. |
| `refresh-built-ins` | Built-in entries are refreshed while user-defined entries are preserved. |

Acceptance: every key intended for remote discovery resolves to its owning source, static/manual catalogs remain usable without a source, and the chosen reconciliation preserves curated metadata where required. `discoverProviderModels` deliberately returns an empty discovery result when no source exists; that is not permission to fabricate one.

---

## Trigger the Fetch

Registering a source makes a listing possible; it does not make it happen. Trace one real path end to end:

```
settings control event → useProviderModelOptions (useModelProbe)
  → ModelsServiceClient.refreshProviderModels
  → src/core/controller/models/refreshProviderModels.ts
  → discoverProviderModels → getModelSource → fetchModels
```

Two different intents reach the same source, and they are not interchangeable:

| Intent | Entry point | Writes to disk |
| --- | --- | --- |
| Preview model IDs while the user edits a Profile | `refreshProviderModels` for a key outside its `PERSISTED_DISCOVERY_PROVIDER_IDS` | No |
| Refresh a remote-authoritative picker catalog | `refreshProviderModels` for a key in that set (`opencode`, `opencode-go`) | Yes, then posts state to the Webview |
| Materialise a catalog from another caller | `discoverProviderModels(..., { persist: true })` | Yes, then reloads the registry |

Rules:
- Bind a real UI event — focus, open, or an explicit action button. A description that mentions refreshing is not a trigger.
- `useModelProbe` does not fetch on mount; it fetches when the caller invokes `refresh()`. A card whose model control only renders the catalog never issues a request.
- A provider whose catalog must survive a restart needs persistent discovery. In the settings route, choose its key in `PERSISTED_DISCOVERY_PROVIDER_IDS` in `src/core/controller/models/refreshProviderModels.ts` and preserve the state publication after persistence. `useProviderModelOptions` receives IDs from the RPC; a preview alone does not make the source's pricing or capabilities available to the registry-backed UI.
- Concurrent-call de-duplication keys on provider, profile, and persistence intent, so a preview never satisfies a caller expecting a write — and it is not a cache.

Acceptance: from a cold start, a user can open the provider's settings card and see models without typing an id.

---

## Units, Capabilities, Protocol

**Prices.** Store per-million amounts and the vendor's declared currency. `flatMeteredPricing` in `src/shared/providers/pricing-shape.ts` accepts `(input, output, cacheWrite?, cacheRead?, currency = "USD")`; do not swap the cache arguments or rely on its USD default for a source declaring another currency. Convert exactly once: scaling an already-per-million figure again overstates every charge by one million. Time-window pricing also declares its schedule and timezone; the calculation uses the request's send time, not the time its last usage chunk arrives.

**Capabilities.** Read the flag the vendor states. Never infer a capability from a price: a free model can publish a cache rate of `0` while supporting no cache at all. Read modality entries as written — a MIME string never equals a bare `"image"`; match the prefix.

**Protocol.** Choose the formats the handler actually carries. OpenAI/Anthropic-compatible gateways commonly offer `OPENAI_CHAT`, `OPENAI_RESPONSES`, and `ANTHROPIC_CHAT`; the generated `ApiFormat` enum also has native and WebSocket formats, so those three are not a project-wide whitelist. `src/shared/providers/api-format.ts` owns shared labels and model-declaration resolution. A provider carrying several families offers the supported choice in both handler and UI.

- Derive the default from the base-URL family the listing points at, not from the protocol's name: one OpenAI-compatible base commonly serves both Chat Completions and Responses.
- The derived value is a default. Reject only a format the provider cannot carry at all, and say so before the request is built.
- Use `resolveApiFormat` when the model's declared formats are the supported set: it preserves a listed choice and otherwise falls back to the first declaration. When a gateway can translate protocols beyond that derived declaration, use its handler-supported resolver in both handler and UI instead. `OpenCodeProviderCard.resolveOpenCodeApiFormat` is the concrete example; blindly using the model-declaration resolver there would discard a choice the gateway can carry.
- A provider that serves several families declares them all on the model's `apiFormats`, ordered with the preferred default first.

Acceptance: a published price is asserted by value, not merely by presence. A handler carrying Chat and Responses is tested with both stored selections; a native-only handler is tested against its actual supported format rather than being required to implement another protocol.

---

## Streaming Usage and Cost

Token accounting (`ApiStreamUsageChunk` in `src/core/api/transform/stream.ts`) has three separate questions:

1. **Inclusive or exclusive input.** Some vendors count the cached share inside `prompt_tokens`. Use `splitInclusiveInputUsage` for that convention and never subtract twice.
2. **Cache read and write.** Map them separately. A vendor that reports one cache counter has no write price.
3. **Reasoning tokens.** Use `chatReasoningTokens` for the convention where reasoning is a subset of completion tokens. Never add it on top of an already-inclusive completion count.

Cost:
- When the vendor reports what it charged, that number is authoritative — read it and write it to `totalCost`. A local price table cannot see tiering or discounts.
- When the charge is absent, call `ApiHandler.calculateUsageCost(pricing, tokens, sentAtMs)` with the same disjoint cache/input segments and inclusive output count emitted in the usage chunk. Preserve a calculated amount and its currency; keep unavailable or invalid pricing distinct from a zero amount. Do not introduce another money calculator in the handler.
- Capture `sentAtMs` immediately before each real send, including a retry or protocol fallback. Do not use stream-completion time or the first failed attempt's time for a successful later attempt. `src/core/api/billing/__tests__/provider-sent-time.test.ts` covers both cases and checks cache/reasoning amounts with the source currency.
- Keep a genuine `0`; it means the request itself cost nothing.
- Do not clamp a reported charge.
- For Responses-shaped traffic, `handleResponsesApiStreamResponse` in `src/core/api/utils/responses_api_support.ts` takes an optional `readReportedCost` callback returning `{ totalCost, currency? }`, not a bare number. Use it instead of duplicating the wrapper's logic. Currency absent from a reported amount remains unknown; do not borrow the Profile's pricing currency.

Acceptance: a reported charge beats the table; a missing charge falls back without becoming `0`; the normalized token split and the raw totals used for cost are both correct.

---

## Account Usage

Add this only when the provider publishes a subscription quota. Establish it from written sources — vendor documentation first, then a published client's concrete choices. A request that happens to answer proves only that some route answered; it does not establish the path, the auth model, or what the numbers mean.

Contract: `getAccountUsage()` returns `AccountUsage` or `undefined`; `supportsAccountUsagePolling` is an optional handler capability flag. The polling consumer owns scheduling; declaring the flag does not create a timer in `ApiHandler`.

- **The quota endpoint is not the inference base URL.** It usually hangs off a plan or console host, while a Profile `baseUrl` may point at a relay. Keep it a separate constant; never derive it from `baseUrl`.
- Take the window definitions from the vendor's documentation. If the quota model is not documented, it is unknown — do not guess, and do not invent a window. When sources disagree, follow the current documentation and record the divergence in the constant's comment rather than blending two contracts.
- Read the number in the direction the vendor states: a percentage may be used or remaining. Map it to the contract's `used` / `limit` and let the UI compute the remainder.
- Keep the vendor's scale, shape tolerance, and overflow. Accept every documented shape, and accept a value beyond the limit when the vendor keeps serving past it.
- A malformed reading disappears rather than becoming zero. Drop a window whose value is not a finite number in the declared direction; return `undefined` when none survives. Normalize timestamps at the parse boundary, accepting the documented shapes only.
- Return an unavailable state carrying the plan identity when the provider has no endpoint, so the surface can explain why.
- Bound and cancel every read: one controller per read, replaced by the next tick, with a finite timeout, cancelled by `abort()` as well. A read replaced by a newer one is not a failure and must not log a warning.
- Disable polling only for a billable or session-bound read, and state the reason.

This contract is display-only. It feeds the usage surface and nothing else. Do not derive task cost from it, and do not try to reconcile the two.

Acceptance: a well-formed full payload yields one quota per documented window; a bad window is dropped without zeroing the others; an aborted or failed read yields `undefined` without an unhandled rejection.

---

## Error Parsing

`parseError(error, modelId?)` maps a provider failure to the shared error types:

| Status | Meaning |
| --- | --- |
| 401 / 403 | Authentication or authorization |
| 404 | Unknown model or route |
| 429 | Rate limit, including any reset hint the vendor sends |
| 5xx | Provider failure |
| Network / abort | Transport failure, distinguishable from a user cancellation |

- Sanitize: never surface headers, keys, or complete request bodies.
- Keep the vendor's own message only when it is safe and actionable, and attach the status code.
- Distinguish "this model is not available in your plan" from "this model is not allowed in this client". Vendors often encode both as `403`/`404` and the remediation differs.

Acceptance: each mapped status is asserted in a test, and no mapped error carries credentials.

---

## Settings Surface

- Add the provider's component case to `webview-ui/src/components/settings/providers/ProviderProfileEditor.tsx`.
- Read models through `useProviderModelOptions`, which merges the remote listing with the local catalog as `{ ...discovered, ...catalog.models }` and reports each option's origin. Do not build a second merge. Two consequences follow: catalog metadata wins for a known id, and a listing-only entry reaches the picker with identity only, so it must not inherit another model's limits or prices.
- Provider-specific controls live in the nested provider config. Shared base fields such as `apiFormat`, `model`, and `reasoning` use the provider config helpers, not ad-hoc property writes.
- A capability the user can change must be a control, not a fixed derivation. Show the derived value as the initial selection and let the user override it.
- Mount the usage surface only where the provider reports a quota (see Account Usage).
- Copy that promises behavior is a contract: update it when the behavior changes.

Acceptance: shared-field controls update through the config helpers, provider-specific controls update their typed config, and both survive save/reload. A supported stored value wins over a derived default; the card renders for a profile with no provider config yet.

---

## Documentation Consumer

The complete bilingual page/navigation delivery stage is in `integrate-new-provider`; load `writing-documentation` for writing and site verification techniques. A provider's public documentation must describe only implemented behavior.

---

## Design Tests at the Fact's Boundary

Write tests at the boundary that owns the fact, and make each one fail for a plausible defect:

1. **Authority.** A curated entry survives a listing that omits it; a listing-only entry stays selectable without inheriting another model's limits.
2. **Magnitude.** A published price is asserted as a value, so a wrong unit conversion fails.
3. **Capability source.** A zero cache price without the cache flag is not cache support.
4. **Protocol.** Both families of one base yield their format; the stored format reaches the handler unchanged.
5. **Usage.** Inclusive and exclusive input splits, cache read and write, reasoning subset, reported-versus-computed cost fallback, source currency, and send-time selection across a price boundary, retry or fallback.
6. **Quota.** A full payload, a malformed window, an unavailable plan, a rejected request, and an abort.
7. **Errors.** One case per mapped status, asserting the shared error type and that nothing sensitive survives.
8. **Trigger.** A test proving the settings entry point reaches the controller, because a missing binding passes every source-level test.

For provider changes that affect tool support or transport, verify native and XML tool contracts on the real selected route, including configuration round-trip, handler selection, model reconciliation, cancellation and sanitized failures. Load `reviewing-prompt-contracts` for effective-input/projection examples; source registration alone does not prove either route works.

Replace the shared transport with `mockFetchForTesting` from `@shared/net`. Assigning `globalThis.fetch` does not intercept the shared wrapper and silently hits the real network.

---

## Execute the Relevant Checks

Load `use-vitest` for focused execution. `integrate-new-provider` owns the cross-layer implementation order, documentation delivery and completion checklist.
