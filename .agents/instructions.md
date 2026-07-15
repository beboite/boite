# Agent Guidelines & Developer Instructions

As an AI agent or developer working on **Boite**, you must follow these guidelines:

## Internationalization (i18n) Requirement

Boite uses a custom Svelte 5 Rune-based reactive translation system. 

When creating or modifying UI elements, **NEVER** hardcode user-facing text strings directly in `.svelte` files. Instead:

1. **Add translations to local files**: 
   Every new or modified string **MUST** be translated in both English and French at a minimum.
   - English dictionary: [`en.json`](file:///C:/Users/User/Documents/GitHub/boite/src/lib/i18n/locales/en.json)
   - French dictionary: [`fr.json`](file:///C:/Users/User/Documents/GitHub/boite/src/lib/i18n/locales/fr.json)

2. **Use nested keys** to keep the localization files clean (e.g. `common.loading` or `settings.language.title`).

3. **Import and use `i18n` in Svelte components**:
   ```svelte
   <script lang="ts">
     import { i18n } from "$lib/i18n/index.svelte";
   </script>

   <p>{i18n.t("my_feature.title")}</p>
   ```

4. **Do not use third-party i18n libraries** unless specifically requested, as Boite values speed, lightweight footprints, and native integration with Svelte 5 runes.
