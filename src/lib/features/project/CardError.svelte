<script lang="ts">
  import { t } from "$lib/i18n/index.svelte";
  import { gitFailure, gitFailureKey } from "./health";

  /**
   * What a card says when the thing behind it would not answer.
   *
   * Never the raw text. `fatal: not a git repository (or any of the parent
   * directories): .git` in red was the Git card's whole content on a fresh
   * install, and `invalid path: Le chemin d'accès spécifié est introuvable.
   * (os error 3)` was three cards' content on a project whose folder had
   * moved: stderr, drawn as if it were copy, in a window that is otherwise
   * translated.
   *
   * The known failures get a sentence. Everything else gets the generic line,
   * and the words git actually used stay one click away rather than being
   * thrown out: "not a repository" and "git: command not found" are different
   * problems with different fixes, and only the raw text tells them apart.
   */
  type Props = { error: string; class?: string };
  let { error, class: klass = "" }: Props = $props();

  const line = $derived(gitFailureKey(gitFailure(error)));
</script>

<div class={klass} role="status">
  <p class="text-sm text-muted-foreground">{t(line)}</p>
  <details class="mt-1">
    <summary class="cursor-pointer text-sm text-muted-2 transition hover:text-muted-foreground">
      {t("common.details")}
    </summary>
    <p class="mt-1 break-words font-mono text-sm text-muted-2">{error}</p>
  </details>
</div>
