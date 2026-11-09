---
name: implement-i18n
description: Implements interface internationalization. Use when adding UI translations, typed message keys, or language-reactive rendering.
---

# Implement Internationalization

## Entry points

- `src/shared/UiLanguage.ts`: preference validation and effective-language resolution.
- `webview-ui/src/i18n/en.ts`: message keys and named-argument types.
- `webview-ui/src/i18n/zh_CN.ts`: matching Chinese messages. Chinese resource filenames use `zh_CN`; runtime BCP47 tags and preference values remain `zh-CN`.
- `webview-ui/src/i18n/messages.ts`: `translateUi` and `UiTranslator`.
- `webview-ui/src/i18n/UiLanguageProvider.tsx`: controlled Provider, React hook and document language effect.

## Add and call a message

1. Add the complete English sentence and its Chinese counterpart under the same stable key. Use typed named arguments for dynamic values; keep meaningful count branches inside the message definition.
2. In React, call `const { language, t } = useUiTranslation()`. Pure presenters receive `UiTranslator` or `UiLanguage` explicitly and call `translateUi(language, key, ...args)`.
3. Keep navigation/configuration constants as keys, then translate during rendering. Preserve narrow literal-key types; do not widen keys to arbitrary strings or cast away argument errors.

```tsx
const { t } = useUiTranslation()
const label = t("settings.general.uiLanguage.label")
const hostLabel = t("settings.general.uiLanguage.followHost", {
    language: UI_LANGUAGE_LABELS[resolveUiLanguage("auto", hostDisplayLanguage)],
})
```

Translate product-owned labels, descriptions, tooltips, placeholders, accessible names and loading/empty/error wrappers together. Preserve user/model content, code, paths, IDs and raw diagnostics. Keep links, emphasis and controls as React structures; do not inject translated HTML or assemble sentences from fragments.

## Keep switching reactive

- Keep preference (`auto`, `en`, `zh-CN`) separate from effective language (`en`, `zh-CN`). Derive display with `resolveUiLanguage`; never write the resolved value over `auto` or change the model's `preferredLanguage`.
- Feed effective language into the controlled `UiLanguageProvider`. In Storybook, derive it inside the final state overrides. Mount `UiDocumentLanguage` once at the root that owns the rendered language.
- Include `t` or language in output-affecting memo/callback dependencies. Store semantic error keys/arguments rather than frozen translated strings.
- Preserve component keys, drafts, focus, selections, navigation and disclosures. Do not reload or remount the interface to switch language.
- Await the setting update and render localized pending/retryable failure feedback. A late response must not replace newer committed state or newer user intent.
- Keep display text separate from business identity and conditions. Formatting changes must preserve currency, timezone, precision, stored values and input parsing; locale-aware formatter caches include locale.

## Verify the changed surface

- Check English/Chinese key and named-argument parity, real fallback behavior and compile-time rejection of invalid calls.
- Switch both directions in the same mounted component; assert accessible names, memo/presenter updates, portal content and preserved local state.
- For setting controls, test pending, failure/retry, late responses and the final Storybook override. Use the smallest applicable component or integration test through use-vitest or use-e2e.
- State the actual translated scope. Do not claim untouched surfaces are translated or add a repository-wide string gate for legacy content.
