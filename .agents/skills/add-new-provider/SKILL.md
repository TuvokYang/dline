---
name: add-new-provider
description: Integrates an API provider into Dline across its Profile contract, handler, model metadata authority, remote listing, protocol selection, pricing, usage accounting, error mapping, and settings surface. Use when adding a provider, adding a plan or catalog key to one, or changing where its models come from. Do not use for editing a single model entry or for prompt changes.
---

# Add a New Dline Provider

Read the nearest analogous provider end to end before editing: its Profile message, handler, model metadata, remote source, settings component, and tests. A provider is complete only when every layer agrees about the same model.

---

## Architecture Contract

Read this first; every step follows from it.

- **One provider, one handler.** `ApiHandler` owns request construction, stream decoding, usage normalization, and error mapping. It must not own model metadata the vendor publishes.
- **Each model fact has one authority.** A vendor listing decides the model set and what it publishes. A local catalog decides only what a listing cannot express. Never hand-copy a number the listing carries.
- **Protocol is a default, not a whitelist.** Derive the initial `ApiFormat` from the vendor's own data, then let the user store any format the provider can carry.
- **Prices have one unit and one conversion.** Convert at the boundary, once, and assert the magnitude.
- **Usage has three separate contracts** that must not be merged: token accounting, the cost of one request, and the account's subscription quota.

---

## Step 0: Decide the Metadata Authority

Answer "who knows this model?" before writing any reader. This is the decision most likely to be wrong, and it determines whether Step 3 or Step 4 produces the catalog.

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

## Step 1: Profile Contract

A provider exists in the data model before it exists in the UI. Follow the nearest existing provider's shape.

1. `src/shared/api.ts`: add the id to the `ApiProvider` union.
2. `src/core/api/providers/models/index.ts`: add a `ProviderModelsConfig` entry to `allProviderModels`, carrying `provider`, `providerName`, `baseUrl`, `billingUrl`, `billingMode`, and `defaultModelId`. This registry entry is what makes the provider selectable — `PROVIDER_OPTIONS` in `src/shared/providers/providers.ts` is derived from it, so nothing else needs editing to appear in the selector. Use `catalogs` when one provider serves alternative model sets reached through the Profile.
3. `proto/dline/provider/<provider>.proto`: declare the provider's config message in the `dline.provider` namespace. It carries only provider-owned fields — plan or region selection, an endpoint that is not the shared base URL, a console link, a model override.
4. `proto/dline/profile.proto`: add one arm to the `oneof provider_config`. Adding an arm is a **persisted contract change**; confirm it with the user before implementing, and never reuse a field number.
5. Run `npm run protos`. Never edit generated output.
6. Read and write the config through `readProviderConfigField` / `withProviderConfigField` in `src/shared/providers/provider-config.ts`, so nested and flat shapes agree. Do not hand-read `profile.<provider>` at call sites.
7. Bump `schema_version` on the `ApiProfile` message only when an older stored profile cannot be read as written, and add the migration in the same change.

Acceptance: an existing stored profile without the new arm still loads, and a new arm round-trips through save and reload.

---

## Step 2: Handler

File: `src/core/api/providers/<provider>.ts`, registered in the construction switch in `src/core/api/index.ts`.

The base class `src/core/api/ApiHandler.ts` is the only implementation owner of real-send observation. A provider overrides provider-specific behavior and nothing else.

Required:
- `createMessage(systemPrompt, messages, tools?, options?)` returning `ApiStream`;
- `getModel()` returning `{ id, info }` resolved from the Profile.

Optional, each with a real reason:
- `parseError(error, modelId?)` — Step 9;
- `getAccountUsage()` and `supportsAccountUsagePolling` — Step 8;
- a `getApiStreamUsage` callback on the object returned by `getModel()` when the model reports usage out of band;
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

## Step 3: Local Catalog Entries

Skip this step when Step 0 chose remote-only.

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

## Step 4: Remote Listing Source

Five layers; do not invent a parallel path.

| Layer | File |
| --- | --- |
| Contract | `src/core/model-registry/remote/model-source.ts` |
| Shared base | `src/core/model-registry/remote/model-listing-source.ts` |
| Vendor implementation | `src/core/model-registry/remote/vendors/<provider>.ts` |
| Registry | `src/core/model-registry/remote/vendors/index.ts` |
| Orchestration | `src/core/model-registry/remote/model-refresh.ts` |

Extend `ModelListingSource` and implement only what the vendor differs on:

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

Acceptance: `getModelSource(everySelectableKey)` returns a source, and a listing that omits a curated model does not delete its metadata.

---

## Step 5: Trigger the Fetch

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
| Populate the picker while the user edits the Profile | `refreshProviderModels` → `discoverProviderModels(...)` | No |
| Materialise the provider catalog | `discoverProviderModels(..., { persist: true })` | Yes, then reloads the registry |

Rules:
- Bind a real UI event — focus, open, or an explicit action button. A description that mentions refreshing is not a trigger.
- `useModelProbe` does not fetch on mount; it fetches when the caller invokes `refresh()`. A card whose model control only renders the catalog never issues a request.
- A provider whose catalog must survive a restart needs the persisting entry point, not the dropdown preview.
- Concurrent-call de-duplication keys on provider, profile, and persistence intent, so a preview never satisfies a caller expecting a write — and it is not a cache.

Acceptance: from a cold start, a user can open the provider's settings card and see models without typing an id.

---

## Step 6: Units, Capabilities, Protocol

**Prices.** Store per-million amounts, because that is what `flatMeteredPricing` in `src/shared/providers/pricing-shape.ts` expects. Its signature is `(input, output, cacheWrite?, cacheRead?)`; do not swap the cache arguments. Convert exactly once: a published figure may already be per-million, and scaling it again overstates every charge by a factor of one million. A time-window price must state the zone it is read in.

**Capabilities.** Read the flag the vendor states. Never infer a capability from a price: a free model can publish a cache rate of `0` while supporting no cache at all. Read modality entries as written — a MIME string never equals a bare `"image"`; match the prefix.

**Protocol.** The formats a new provider can offer are `OPENAI_CHAT`, `OPENAI_RESPONSES`, and `ANTHROPIC_CHAT`. The `ApiFormat` enum is generated from the models proto; `src/shared/providers/api-format.ts` maps each value to its user-facing label and holds the resolution helpers. A provider whose base URL serves more than one family offers the choice.

- Derive the default from the base-URL family the listing points at, not from the protocol's name: one OpenAI-compatible base commonly serves both Chat Completions and Responses.
- The derived value is a default. Reject only a format the provider cannot carry at all, and say so before the request is built.
- Resolve a stored selection through `resolveApiFormat` in `src/shared/providers/api-format.ts`: it keeps the user's choice when the model declares it, and falls back to the model's first format otherwise. A handler that treats the derivation as a whitelist, or a UI that drops a stored value the derivation did not list, silently discards a deliberate choice.
- A provider that serves several families declares them all on the model's `apiFormats`, ordered with the preferred default first.

Acceptance: a test asserts one published price value, not merely its presence, and both a Chat and a Responses model reach the handler with the format the user stored.

---

## Step 7: Streaming Usage and Cost

Token accounting (`ApiStreamUsageChunk` in `src/core/api/transform/stream.ts`) has three separate questions:

1. **Inclusive or exclusive input.** Some vendors count the cached share inside `prompt_tokens`. Use `splitInclusiveInputUsage` for that convention and never subtract twice.
2. **Cache read and write.** Map them separately. A vendor that reports one cache counter has no write price.
3. **Reasoning tokens.** Use `chatReasoningTokens` for the convention where reasoning is a subset of completion tokens. Never add it on top of an already-inclusive completion count.

Cost:
- When the vendor reports what it charged, that number is authoritative — read it and write it to `totalCost`. A local price table cannot see tiering or discounts.
- Fall back to the price table only when the charge is absent. An absent charge is unknown, not free.
- Keep a genuine `0`; it means the request itself cost nothing.
- Do not clamp a reported charge.
- For Responses-shaped traffic, `handleResponsesApiStreamResponse` in `src/core/api/utils/responses_api_support.ts` takes an optional `readReportedCost` callback. Use it instead of duplicating the wrapper's logic.

Acceptance: a reported charge beats the table; a missing charge falls back without becoming `0`; the normalized token split and the raw totals used for cost are both correct.

---

## Step 8: Account Usage

Add this only when the provider publishes a subscription quota. Establish it from written sources — vendor documentation first, then a published client's concrete choices. A request that happens to answer proves only that some route answered; it does not establish the path, the auth model, or what the numbers mean.

Contract: `getAccountUsage()` returns `AccountUsage` or `undefined`; `supportsAccountUsagePolling` defaults to polling every 60 seconds.

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

## Step 9: Error Parsing

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

## Step 10: Settings Surface

- Add the provider's component case to `webview-ui/src/components/settings/providers/ProviderProfileEditor.tsx`.
- Read models through `useProviderModelOptions`, which merges the remote listing with the local catalog as `{ ...discovered, ...catalog.models }` and reports each option's origin. Do not build a second merge. Two consequences follow: catalog metadata wins for a known id, and a listing-only entry reaches the picker with identity only, so it must not inherit another model's limits or prices.
- Provider-specific controls live in the nested provider config. Shared base fields such as `apiFormat`, `model`, and `reasoning` use the provider config helpers, not ad-hoc property writes.
- A capability the user can change must be a control, not a fixed derivation. Show the derived value as the initial selection and let the user override it.
- Mount the usage surface only where the provider reports a quota (Step 8).
- Copy that promises behavior is a contract: update it when the behavior changes.

Acceptance: changing a control writes through the config helper; a stored value always wins over a derived default; the card renders for a profile with no provider config yet.

---

## Step 11: Documentation

A shipped provider needs a page in both language trees, because the docs site publishes each edition from its own file.

- Write `docs/src/content/docs/provider-config/<provider>.mdx` and `docs/src/content/docs/zh-cn/provider-config/<provider>.mdx` for the same scope. The two editions must carry equivalent facts, not a translation of one into the other.
- Register the page in `docs/src/data/navigation.mjs`. A page that is absent from the navigation is unreachable in the built site.
- State the plan or region options, the protocols offered, what the usage surface reports, and what a reported per-request cost means. Do not promise behavior the code does not implement.
- Run `npm run docs:verify`.

Acceptance: both editions exist, both are in the navigation, and their claims match the implementation.

---

## Step 12: Tests

Write tests at the boundary that owns the fact, and make each one fail for a plausible defect:

1. **Authority.** A curated entry survives a listing that omits it; a listing-only entry stays selectable without inheriting another model's limits.
2. **Magnitude.** A published price is asserted as a value, so a wrong unit conversion fails.
3. **Capability source.** A zero cache price without the cache flag is not cache support.
4. **Protocol.** Both families of one base yield their format; the stored format reaches the handler unchanged.
5. **Usage.** Inclusive and exclusive input splits, cache read and write, reasoning subset, and the reported-versus-computed cost fallback.
6. **Quota.** A full payload, a malformed window, an unavailable plan, a rejected request, and an abort.
7. **Errors.** One case per mapped status, asserting the shared error type and that nothing sensitive survives.
8. **Trigger.** A test proving the settings entry point reaches the controller, because a missing binding passes every source-level test.

Replace the shared transport with `mockFetchForTesting` from `@shared/net`. Assigning `globalThis.fetch` does not intercept the shared wrapper and silently hits the real network.

---

## Step 13: Verify

```text
npm run check-types                           # includes npm run protos
npm run lint
npm run test:run -- <focused test files>
npm run test:webview                          # settings component changed
npm run docs:verify                           # documentation changed
```

Report which checks ran and which did not, and never treat an unrun check as passing.

---

## Completion Checklist

### Contract and identity
- [ ] `ApiProvider` union updated (`src/shared/api.ts`) and a `ProviderModelsConfig` entry added to `allProviderModels` (`src/core/api/providers/models/index.ts`)
- [ ] provider config message declared; `oneof provider_config` arm added; `npm run protos` run and its generated diff inspected
- [ ] config read and written only through `readProviderConfigField` / `withProviderConfigField`
- [ ] `schema_version` bumped only if an old profile would misread, with its migration

### Handler
- [ ] handler registered in the construction switch (`src/core/api/index.ts`)
- [ ] every request uses the shared transport, with a timeout and an abort path
- [ ] `abort()` cancels the streaming request and every auxiliary request
- [ ] errors sanitized before leaving the handler

### Metadata
- [ ] metadata authority chosen and stated in the source header
- [ ] local entries cite the vendor page and date, and declare only what the listing cannot
- [ ] remote source implemented, registered in `MODEL_SOURCES`, catalog keys in `CATALOG_KEY_OWNERS`
- [ ] `reconciliation` and `requiresApiKey` chosen deliberately
- [ ] a real UI trigger is bound and its persistence intent is stated

### Data correctness
- [ ] prices stored per million, converted once, asserted by value, cache arguments in order
- [ ] capabilities read from vendor flags, not inferred from prices
- [ ] `ApiFormat` derived as a default and overridable in both handler and UI
- [ ] token accounting follows the vendor's inclusive/exclusive convention
- [ ] reported per-request cost preferred; absent cost is unknown; genuine `0` kept
- [ ] quota endpoint kept separate from the inference base URL; windows and direction taken from documentation
- [ ] malformed quota readings dropped rather than zeroed; reads bounded and cancellable

### Presentation
- [ ] settings component registered; provider config written through the helpers
- [ ] usage surface mounted only where the provider reports a quota
- [ ] no control promises behavior the handler does not implement

### Documentation
- [ ] English and Chinese provider pages exist for the same scope
- [ ] both pages registered in `docs/src/data/navigation.mjs`
- [ ] `npm run docs:verify` passes

### Verification
- [ ] focused tests cover authority, magnitude, protocol, usage, quota, errors, and the trigger
- [ ] `npm run check-types` and `npm run lint` pass
- [ ] `npm run test:webview` passes when the settings component changed
- [ ] every check that ran, and every check that did not, is reported with its result
