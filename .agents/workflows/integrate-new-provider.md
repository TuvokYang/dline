---
name: integrate-new-provider
description: Integrate a new Dline provider or a cross-layer plan/catalog source through authority decisions, Profile and handler wiring, listing triggers, accounting, settings, documentation, and verification.
---

# Integrate a New Provider

Use for a new provider or a plan/catalog-source change requiring the full cross-layer chain. Do not use for one model entry, a prompt edit, or a local parser fix. Follow `dline-overview`, `engineering-guide`, `network`, and `storage`; load `add-new-provider` for the implementation methods, tables, examples and behavioral oracles.

## 1. Establish Source Authority and Scope

Read an analogous provider end to end: Profile message, handler, model catalog, remote source, settings component and tests. Inspect current workspace changes. Establish vendor facts from current documentation/listing rather than guessing.

Choose relay/first-party/local-runtime authority; identify catalog keys and plan ownership, listing credentials, supported protocol families, reported request charge and subscription quota, and provider-specific fields. Record source authority in the provider source header. Decide which later branches apply: remote-only skips curated entries; undocumented quota does not create a guessed endpoint/window.

Choose the branch before proceeding:

- **New provider:** add identity, selectable registry entry, handler dispatch and settings component in step 2.
- **Existing provider's plan/catalog:** keep its identity and handler. Change only the plan/config fields, catalog selection, source aliases and consumers that differ; a new catalog key is not a new provider.
- **No supported listing:** keep the justified curated/manual model path and skip remote-source implementation. Do not invent a listing endpoint to satisfy this workflow.

Output: agreed authority, behavior, data and compatibility scope. Resolve an undecided provider_config arm or migration before implementing the dependent stages.

## 2. Establish Profile Identity and Handler

For a new provider, add its `ApiProvider` identity and selectable `allProviderModels` entry. For an existing provider's plan, extend its `catalogs` and config only where necessary: `opencode-go` is an alternative catalog of `opencode`, not a second provider. Reuse `BaseProviderConfig` when shared fields suffice; define a dedicated Proto message only for provider-specific fields. Add an approved compatible oneof arm only when the stored contract requires it, then generate projections. Use the config helpers for shared fields; read and update provider-specific fields through their typed config. Change the stored Profile revision only when older profiles would otherwise misread, with the migration in the same change. Verify old-profile loading and new-config save/reload.

Implement and register a new handler through the existing API construction switch only for a new provider; keep the existing handler for a plan/catalog change. Resolve `getModel()` from the Profile, construct and decode requests, normalize usage, and map safe errors. Preserve ApiHandler's send-observation ownership. Load `using-shared-network` for shared transport/SDK injection, bounded requests, abort propagation and stream cleanup. Every auxiliary request belongs to the same cancellation accounting, not an untracked request.

Output: a selectable identity and usable handler with compatible stored configuration, not merely a settings label.

## 3. Complete Catalog, Source, Reconciliation and Trigger

For a first-party curated catalog, cite vendor page/date and add only facts the listing cannot carry. For relay/local remote-only authority, skip local model entries rather than shipping guesses. Preserve wire ids and unknown values.

When listing is supported, implement the vendor source using `ModelListingSource` for the common listing shape, or the `ProviderRemoteSource` contract when the source needs a different implementation. Register it in `MODEL_SOURCES`; add `CATALOG_KEY_OWNERS` aliases for alternative keys that consume that source. Static/manual catalogs do not need a fabricated source. Choose `requiresApiKey`, default endpoint and reconciliation from the actual vendor contract; keep wire payload parsing inside the source.

Then bind the actual settings event through `useProviderModelOptions`, the generated Models service, `refreshProviderModels` and `discoverProviderModels`. Choose preview versus persistent discovery in the controller: its `PERSISTED_DISCOVERY_PROVIDER_IDS` currently includes `opencode` and `opencode-go`, and persistent refresh also posts the updated state to the Webview. A new remote-authoritative catalog must deliberately choose that path rather than receive only IDs with no usable metadata. Source registration and de-duplication do not trigger a request or establish durability. Verify from a cold start that the model control reaches the right source and shows usable models.

Output: model facts have one authority, all selectable keys resolve, and a real consumer triggers the intended read/write path.

## 4. Complete Accounting, Protocol, Errors and UI

Verify per-million price units, declared currency, cache argument order, vendor capability flags and modality shapes. When no charge is reported, use `ApiHandler.calculateUsageCost(pricing, tokens, sentAtMs)` with the normalized tokens and the actual send time for that attempt; preserve its currency and unavailable/invalid outcomes. Check a request that crosses a time-price boundary and a retry that starts in a different window. Preserve user-selected formats within the formats the handler can carry; do not use a derived model default as a whitelist.

Normalize inclusive/exclusive token usage, cache read/write and reasoning subsets independently. Prefer a genuine reported per-request charge, including zero; compute only when absent. Implement account quota only from a documented quota contract, with separate endpoint/plan identity, documented windows/direction, malformed-window handling and bounded abortable polling. Never derive task cost from account quota.

Map status/transport/cancellation errors safely and distinguish plan restrictions from client restrictions. Wire the settings component, config helpers and common model-options merge; expose actual user controls and mount usage only when supported. Verify no-config rendering and stored-selection precedence.

Output: handler, metadata, stored choice, displayed cost/quota and settings promises agree, including error and cancellation paths.

## 5. Deliver Bilingual Documentation

A shipped provider needs a page in both language trees; load `writing-documentation`:

- Write `docs/src/content/docs/provider-config/<provider>.mdx` and `docs/src/content/docs/zh-cn/provider-config/<provider>.mdx` for the same scope, with equivalent facts.
- Add the shared page slug once to `docs/src/data/navigation.mjs`; its navigation checks require that slug to exist in both languages. Content files are published even without a sidebar entry, so an intentionally unlisted page needs an explicit `unlistedSlugs` decision rather than being assumed unpublished.
- State plan/region choices, offered protocols, account-usage meaning, and reported per-request cost semantics. Do not promise unimplemented behavior.
- Run `npm run docs:verify`.

Output: both pages exist, are navigable, and match the implementation.

## 6. Verify and Close the Chain

Use the eight behavioral-test categories in `add-new-provider`: authority, magnitude, capability source, protocol, usage, quota, errors and actual trigger. Verify configuration round-trip, handler selection and reconciliation; when tool support/transport changes, verify native/XML contracts with `reviewing-prompt-contracts`, cancellation and sanitized failures. Use the shared transport hook rather than replacing global fetch. Load `use-vitest` for focused execution; source-level tests do not prove UI-trigger reachability.

```text
npm run check-types                           # includes npm run protos
npm run lint
npm run test:run -- <focused test files>
npm run test:webview                          # settings component changed
npm run docs:verify                           # documentation changed
```

Check current scripts first and inspect generated diffs without absorbing another Task's changes. Select focused host coverage only when the changed boundary warrants it. Report which checks ran and which did not; an unrun check is not passing.

## Completion Checklist

Apply the branches selected in step 1; mark unsupported listing, quota or protocol branches not applicable rather than implementing them to fill a checkbox.

### Contract and identity
- [ ] new-provider identity and selectable registry entry added, or existing-provider catalog/plan branch explicitly selected
- [ ] shared `BaseProviderConfig` reused where sufficient; dedicated message/oneof changes and generation limited to the approved stored contract
- [ ] shared fields use `readProviderConfigField` / `withProviderConfigField`; provider-specific fields use their typed config
- [ ] `schema_version` bumped only if an old profile would misread, with its migration

### Handler
- [ ] new handler registered in `src/core/api/index.ts`, or the existing handler deliberately retained for a plan/catalog change
- [ ] every request uses the shared transport, with a timeout and an abort path
- [ ] `abort()` cancels the streaming request and every auxiliary request
- [ ] errors sanitized before leaving the handler

### Metadata
- [ ] metadata authority chosen and stated in the source header
- [ ] local entries cite the vendor page and date, and declare only what the listing cannot
- [ ] supported remote source registered in `MODEL_SOURCES` and applicable aliases in `CATALOG_KEY_OWNERS`, or justified static/manual path retained
- [ ] `reconciliation` and `requiresApiKey` chosen deliberately
- [ ] a real UI trigger is bound and its persistence intent is stated

### Data correctness
- [ ] prices stored per million with their declared currency, converted once, asserted by value, cache arguments in order
- [ ] computed costs use `ApiHandler.calculateUsageCost` and each attempt's send time; time-boundary and retry cases covered
- [ ] capabilities read from vendor flags, not inferred from prices
- [ ] `ApiFormat` derived as a default and overridable in both handler and UI
- [ ] token accounting follows the vendor's inclusive/exclusive convention
- [ ] reported per-request cost preferred; missing charge falls back to valid pricing, otherwise remains unknown; genuine `0` and source currency kept
- [ ] quota endpoint kept separate from the inference base URL; windows and direction taken from documentation
- [ ] malformed quota readings dropped rather than zeroed; reads bounded and cancellable

### Presentation
- [ ] settings component wired; shared fields use the helpers and provider-specific fields use their typed config
- [ ] usage surface mounted only where the provider reports a quota
- [ ] no control promises behavior the handler does not implement

### Documentation
- [ ] English and Chinese provider pages exist for the same scope
- [ ] one shared navigation slug resolves to both language pages, or an intentional unlisted-page decision is recorded
- [ ] `npm run docs:verify` passes

### Verification
- [ ] focused tests cover authority, magnitude, protocol, usage, quota, errors, and the trigger
- [ ] `npm run check-types` and `npm run lint` pass
- [ ] `npm run test:webview` passes when the settings component changed
- [ ] every check that ran, and every check that did not, is reported with its result

Report authority/configuration choices, handler/source/consumer wiring, old/new profile compatibility, applicable branches and actual verification results.
