<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";
  import { notifications } from "$lib/features/notifications/store.svelte";
  import { logger } from "$lib/shared/services/logger.svelte";
  import { todos } from "./store.svelte";
  import { todoFocus } from "./focus.svelte";
  import { confirmDialog } from "$lib/shared/components/confirm.svelte";
  import { registerEscape } from "$lib/shared/keyboard/overlay";
  import { t } from "$lib/i18n/index.svelte";
  import { scrollIntoViewSmooth } from "$lib/theme/motion";
  import { ptyWrite } from "$lib/storage/pty";
  import { openUrl } from "$lib/platform/opener";
  import { claimGitState, type ClaimGit } from "./claimGit";
  import type { TodoItem } from "$lib/types";
  import AlignLeft from "@lucide/svelte/icons/align-left";
  import CornerDownRight from "@lucide/svelte/icons/corner-down-right";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import Check from "@lucide/svelte/icons/check";
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import Bot from "@lucide/svelte/icons/bot";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";

  /**
   * The cards themselves, and everything you can do to one.
   *
   * Its own component because the list has two homes rather than one. The docked
   * column is the obvious one; the project dashboard is the other, and until now
   * its todo card was six truncated titles with an input under them. That was
   * the whole todo surface for anyone running the info-box experiment, which
   * takes the column away: no tick, no confirm, no delete, no reorder, no
   * description. A summary is the right thing for a card that has a panel behind
   * it, and there is no panel behind it any more.
   *
   * Everything the panel could do lives here, so the two cannot drift: ticking,
   * confirming an agent's claim, editing, reordering, deleting and handing a
   * card to the terminal in front. What stays outside is what belongs to a
   * surface rather than to the list — the header, the add form, the agent
   * section — because a card and a column disagree about all three.
   *
   * `class` is the scroller's, not decoration: the column gives it the room it
   * has left, the dashboard card caps it and lets the grid stay even.
   */
  type Props = { projectId: string | null; class?: string };
  let { projectId, class: klass = "" }: Props = $props();

  const encoder = new TextEncoder();

  const project = $derived(
    projectId ? app.projects.find((p) => p.id === projectId) ?? null : null,
  );
  const items = $derived(todos.forProject(projectId));

  // Handing an item over writes into whatever thread is in front. A thread with
  // no live PTY (never started, or exited) has nothing to receive it.
  const target = $derived(app.activeThread);
  const canSend = $derived(!!target?.ptyId);

  // No hover on a touch screen, so anything that only appears on hover is
  // unreachable there and stays out.
  const mobile = $derived(settings.state.mobileLayout);

  // Row controls: on show where there is no pointer to reveal them, and
  // otherwise revealed by a pointer over the row or by the keyboard reaching
  // them, which is the half that was missing.
  const ROW_ACTION = $derived(
    `grid size-[22px] shrink-0 place-items-center rounded text-muted-foreground/60 transition ${
      mobile
        ? ""
        : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
    }`,
  );

  /**
   * The scroller this list drew, and what scopes every DOM read below to it.
   *
   * The drag used to ask `document` for every `[data-todo-row]` on screen. With
   * one list in the window that was the same set; with two — the dashboard's
   * card beside the column, or a dashboard pane next to the panel — it is both
   * lists at once, so dropping a card computed its slot against rows belonging
   * to a list nobody was dragging in.
   */
  let listEl = $state<HTMLElement | null>(null);

  // Which card is open. One at a time: the panel is a column barely wider than
  // a sentence, and two open descriptions push everything else off screen.
  let openId = $state<string | null>(null);

  /**
   * Which chip has its detail showing, for the readers with no pointer.
   *
   * The strip's details (the commit subject, a PR url, why gh refused) hung off
   * `group-hover/tip` alone, so on a phone and from the keyboard they did not
   * exist. The chips are buttons now and this is what their press toggles.
   */
  let openTip = $state<string | null>(null);

  function toggleTip(key: string) {
    openTip = openTip === key ? null : key;
  }

  // Escape closes it, through the same stack every other floating surface in the
  // app claims, so one press never closes two things.
  $effect(() => {
    if (!openTip) return;
    return registerEscape(() => (openTip = null));
  });

  // A card opened in one project says nothing about the next one.
  $effect(() => {
    projectId;
    openId = null;
    openTip = null;
  });

  // Something outside the list named one card: the palette's content search.
  // The request is consumed rather than watched, so asking for the same id
  // again opens it again after the user has closed it — and a request that
  // arrives before the list has loaded is honoured when it does, because this
  // reads `items` too.
  $effect(() => {
    const wanted = todoFocus.requested;
    if (!wanted || !items.some((item) => item.id === wanted)) return;
    todoFocus.take();
    openId = wanted;
    // After the card has been drawn open: opening one changes its height, so
    // scrolling before that lands on the row's old box. Scoped to this list, so
    // a second one mounted elsewhere cannot be the thing that scrolls.
    queueMicrotask(() => {
      scrollIntoViewSmooth(listEl?.querySelector(`[data-todo-row="${wanted}"]`));
    });
  });

  /**
   * Deleting a task takes the description with it and nothing keeps a copy.
   */
  async function remove(item: TodoItem) {
    const ok = await confirmDialog.ask({
      title: t("todo.removeConfirmTitle"),
      message: t("todo.removeConfirmMessage", { title: item.title }),
      confirmLabel: t("todo.removeConfirmAction"),
      danger: true,
    });
    if (!ok) return;
    await todos.remove(item.id);
  }

  /**
   * Opening a card is the only way to read its description — a tooltip cannot
   * hold a paragraph, and one that could would cover the list to show it.
   *
   * Clicks that land on a control are that control's: the checkbox, the
   * hand-off and the delete button all sit inside the same box, and every one
   * of them would otherwise open the card on its way to doing its own job.
   *
   * Clicking the row is the pointer shortcut. The keyboard path is the title
   * itself, which is a button while the card is closed, so the description is no
   * longer behind a click nobody without a mouse can make.
   */
  function cardClick(item: TodoItem, e: MouseEvent) {
    if (suppressClick === item.id) return;
    if ((e.target as HTMLElement | null)?.closest("button, input, textarea, a")) return;
    toggleCard(item, false);
  }

  /**
   * Where the keyboard has to be after the next render.
   *
   * Opening a card replaces the title button with an input and closing it does
   * the reverse, so whichever element had focus is gone by the time its
   * replacement exists: without this, every toggle dropped the keyboard on
   * <body>. Deliberately not $state: it is read once, by the action on the
   * element that has just been created.
   */
  let claimFocus: string | null = null;

  function toggleCard(item: TodoItem, fromKeyboard: boolean) {
    // A drag that ended on this card produces a click on it, and on the title
    // button the drag started from.
    if (suppressClick === item.id) return;
    const opening = openId !== item.id;
    openId = opening ? item.id : null;
    if (!fromKeyboard) return;
    claimFocus = opening ? `title:${item.id}` : `row:${item.id}`;
  }

  /** Takes the keyboard only when the toggle above asked for this element. */
  function keepFocus(el: HTMLElement, want: string) {
    if (claimFocus !== want) return;
    claimFocus = null;
    el.focus();
    if (el instanceof HTMLInputElement) {
      // Caret at the end rather than a full selection: the first keystroke
      // after opening a card should not wipe the title.
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }

  // Escape leaves the card the way it was opened, with the keyboard back on the
  // line it came from.
  function fieldKeydown(item: TodoItem, e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    openId = null;
    claimFocus = `row:${item.id}`;
  }

  // Grows the box to whatever was typed, up to a third of the panel. Past that
  // it scrolls: a description long enough to fill the list has stopped being a
  // description of one card.
  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }

  function descriptionBox(el: HTMLTextAreaElement) {
    autosize(el);
  }

  type RowSnapshot = { id: string; top: number; height: number };
  type Drag = {
    id: string;
    pointerId: number;
    startY: number;
    y: number;
    /** False until the pointer has travelled far enough to mean a drag. */
    active: boolean;
    rows: RowSnapshot[];
    /** Where it would land, as an index into the list minus the dragged card. */
    slot: number | null;
  };

  let drag = $state<Drag | null>(null);
  let dragCaptureEl: HTMLElement | null = null;
  // A drag that ends over the card it started on is still a pointerup on that
  // card, and the browser follows it with a click. Without this the list would
  // open a card every time you finished moving one.
  let suppressClick = $state<string | null>(null);

  const liveDrag = $derived(drag?.active ? drag : null);
  const draggingId = $derived(liveDrag?.id ?? null);
  const dropSlot = $derived(liveDrag?.slot ?? null);
  const dragIndex = $derived(
    draggingId ? items.findIndex((t) => t.id === draggingId) : -1,
  );

  function cardPointerDown(item: TodoItem, e: PointerEvent) {
    // Left button only, and never from inside a field: the open card holds a
    // title input and a textarea, and selecting text in either is a drag of its
    // own that this must not steal.
    if (e.button !== 0) return;
    const control = (e.target as HTMLElement | null)?.closest(
      "input, textarea, button, a",
    );
    // The closed title is a button now, and it covers most of the row: vetoing
    // it would have taken the drag away from the only part of a card there is
    // room to grab.
    if (control && !control.hasAttribute("data-card-title")) return;
    dragCaptureEl = e.currentTarget as HTMLElement;
    drag = {
      id: item.id,
      pointerId: e.pointerId,
      startY: e.clientY,
      y: e.clientY,
      active: false,
      rows: [],
      slot: null,
    };
    document.addEventListener("pointermove", dragMove);
    document.addEventListener("pointerup", dragEnd);
    document.addEventListener("pointercancel", dragEnd);
  }

  function captureRows(d: Drag) {
    const rows = listEl?.querySelectorAll<HTMLElement>("[data-todo-row]") ?? [];
    d.rows = Array.from(rows).map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.todoRow ?? "", top: r.top, height: r.height };
    });
  }

  /** Index into the list without the dragged card, from the pointer's height. */
  function computeSlot(d: Drag): number | null {
    const reduced = d.rows.filter((r) => r.id !== d.id);
    if (reduced.length === 0) return null;
    for (let i = 0; i < reduced.length; i++) {
      if (d.y < reduced[i].top + reduced[i].height / 2) return i;
    }
    return reduced.length;
  }

  function dragMove(e: PointerEvent) {
    const d = drag;
    if (!d || e.pointerId !== d.pointerId) return;
    // Mutated in place. `drag` is already a $state proxy, so replacing the whole
    // object on every pointermove invalidated liveDrag, draggingId, dropSlot and
    // dragIndex (which walks the list) at pointer rate, plus the per-row slot
    // const, including in the pre-threshold branch where nothing had changed.
    d.y = e.clientY;
    if (!d.active) {
      if (Math.abs(e.clientY - d.startY) < 5) return;
      d.active = true;
      suppressClick = d.id;
      // Deferred until the drag is real: capturing on pointerdown retargets the
      // click to the row, and a plain click would then never reach the controls
      // inside it.
      try {
        dragCaptureEl?.setPointerCapture(d.pointerId);
      } catch {
        // pointer already released
      }
      captureRows(d);
    }
    e.preventDefault();
    d.slot = computeSlot(d);
  }

  function dragEnd(e: PointerEvent) {
    const d = drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.active) {
      if (d.slot !== null && projectId) {
        const order = items.filter((t) => t.id !== d.id).map((t) => t.id);
        order.splice(d.slot, 0, d.id);
        void todos.reorder(projectId, order);
      }
      // Cleared on the next tick, after the click this pointerup produces —
      // including when the drag landed nowhere, where opening the card would be
      // the one thing the user did not ask for.
      setTimeout(() => {
        if (suppressClick === d.id) suppressClick = null;
      }, 0);
    } else {
      suppressClick = null;
    }
    drag = null;
    dragCaptureEl = null;
    releaseDragListeners();
  }

  function releaseDragListeners() {
    document.removeEventListener("pointermove", dragMove);
    document.removeEventListener("pointerup", dragEnd);
    document.removeEventListener("pointercancel", dragEnd);
  }

  // The right panel destroys this component whenever its tab changes, which can
  // happen mid-drag. Without this the three listeners above stayed bound to
  // document forever, holding the dead component's drag state.
  onDestroy(() => {
    drag = null;
    dragCaptureEl = null;
    releaseDragListeners();
  });

  // The repository the sha has to exist in. gitRoot is only filled in once the
  // project has been inspected, so the cwd stands in — git resolves a sha from
  // anywhere inside the work tree.
  const gitRoot = $derived(project?.gitRoot ?? project?.cwd ?? null);

  function gitState(item: TodoItem): Promise<ClaimGit | null> {
    const sha = item.commitSha;
    const root = gitRoot;
    if (!sha || !root) return Promise.resolve(null);
    return claimGitState(root, sha);
  }

  function openPr(url: string) {
    if (!url) return;
    void openUrl(url).catch((err) => {
      logger.warn("todo", `could not open ${url}`, String(err));
      notifications.error(t("terminal.openLinkFailed"));
    });
  }

  // The same box the Confirm/Reopen buttons draw, minus its resting border, so
  // the strip stays a line of text until a pointer is on it.
  const CHIP =
    "rounded border border-transparent px-1 py-0.5 transition hover:border-border hover:bg-accent hover:text-foreground";

  onMount(() => {
    void todos.ensureLoaded();
  });

  /**
   * Types the scaffolded task into the active terminal without submitting it.
   * Sending the newline too would launch an agent run from a single mis-click,
   * and an agent turn is expensive and hard to call back — the user presses
   * Enter. The prompt carries the todo id so the agent can claim it back.
   */
  function handOff(item: TodoItem) {
    const ptyId = target?.ptyId;
    if (!ptyId) return;
    const description = item.description ?? "";
    const prompt = settings.state.todoPromptTemplate
      // `{{task}}` predates the split and is what every saved template still
      // holds, so it carries both halves — a card handed over without its
      // description is the paragraph the user wrote being thrown away.
      .replaceAll("{{task}}", description ? `${item.title}\n\n${description}` : item.title)
      .replaceAll("{{title}}", item.title)
      .replaceAll("{{description}}", description)
      .replaceAll("{{id}}", item.id);
    // Any newline in the payload would submit on the agent's behalf, so the
    // whole scaffold collapses to one line before it is written.
    const oneLine = prompt.replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (!oneLine) return;
    void ptyWrite(ptyId, encoder.encode(oneLine)).catch((err) => {
      notifications.error(t("todo.terminalUnreachable", { error: String(err) }));
    });
    app.view = "terminal";
  }
</script>

<div bind:this={listEl} class="{klass} {liveDrag ? 'select-none' : ''}">
  <!-- The error branch comes first. A failed load left the list empty, so
       "nothing to do here" was also what a broken database looked like. -->
  {#if todos.loadError}
    <div class="flex flex-col items-center gap-2 px-3 py-6 text-center">
      <p class="text-xs text-danger">{t("todo.loadFailed")}</p>
      <p class="text-xs text-muted-foreground">{todos.loadError}</p>
      <button
        type="button"
        class="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
        onclick={() => void todos.reload()}
      >
        {t("common.retry")}
      </button>
    </div>
  {:else if items.length === 0 && !todos.loading}
    <p class="px-3 py-6 text-center text-xs text-muted-foreground">
      {t("todo.empty")}
    </p>
  {/if}
  {#each items as item, i (item.id)}
    <!-- Index into the list as it reads without the card being carried,
         which is the list the drop slot counts in. -->
    {@const slotIndex = dragIndex >= 0 && i > dragIndex ? i - 1 : i}
    {#if dropSlot === slotIndex && item.id !== draggingId}
      {@render dropLine()}
    {/if}
    <!-- The row's click is a pointer convenience on top of the controls
         inside it: the title is a button, so opening a card and reading its
         description no longer needs a mouse, and a key handler here would
         fight the fields the open card holds. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      data-todo-row={item.id}
      class="group cursor-pointer border-b border-border/50 px-3 py-1.5 transition {item.id ===
      draggingId
        ? 'opacity-40'
        : 'hover:bg-accent'} {item.state === 'claimed'
        ? 'bg-[var(--color-surface-2)]/60'
        : ''} {openId === item.id ? 'bg-[var(--color-surface-2)]/50' : ''}"
      onpointerdown={(e) => cardPointerDown(item, e)}
      onclick={(e) => cardClick(item, e)}
    >
      <div class="flex items-center gap-2">
        <!-- The native control was the one white rectangle in the app: it
             draws itself, ignores the border and surface tokens, and sits on
             its own baseline rather than the row's. This is the same box the
             rest of Boite draws. -->
        <button
          type="button"
          role="checkbox"
          aria-checked={item.state === "done"}
          aria-label={item.state === "done" ? t("todo.markNotDone") : t("todo.markDone")}
          class="grid size-[15px] shrink-0 place-items-center rounded-[4px] border transition {item.state ===
          'done'
            ? 'border-foreground/30 bg-foreground/80 text-[var(--color-surface)]'
            : 'border-border text-transparent hover:border-foreground/40'}"
          onclick={() =>
            todos.setState(item.id, item.state === "done" ? "open" : "done")}
        >
          <Check class="size-2.5" strokeWidth={3.5} />
        </button>
        <!-- Closed, the title is text and the whole row is the button that
             opens the card. Open, it becomes the field it always was.
             Keeping the input on show cost a click to read a description
             and gave the panel one editable line per row to tab through,
             which is not what a list of cards is for. -->
        {#if openId === item.id}
          <input
            type="text"
            value={item.title}
            placeholder={t("todo.titlePlaceholder")}
            use:keepFocus={`title:${item.id}`}
            onkeydown={(e) => fieldKeydown(item, e)}
            onchange={(e) =>
              todos.setTitle(item.id, (e.currentTarget as HTMLInputElement).value)}
            class="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm leading-snug outline-none transition focus:border-border focus:bg-[var(--color-surface)] {item.state ===
            'done'
              ? 'text-muted-foreground/60 line-through'
              : 'text-foreground'}"
          />
        {:else}
          <button
            type="button"
            data-card-title
            aria-expanded={false}
            use:keepFocus={`row:${item.id}`}
            onclick={(e) => toggleCard(item, e.detail === 0)}
            class="min-w-0 flex-1 truncate px-1 py-0.5 text-left text-sm leading-snug {item.state ===
            'done'
              ? 'text-muted-foreground/60 line-through'
              : 'text-foreground'}"
          >
            {item.title}
          </button>
          {#if item.description}
            <!-- The only sign that there is more behind the line. Dropped
                 when the card is open, where the description is right
                 there. -->
            <span
              class="shrink-0 text-muted-foreground/60"
              use:tip={t("todo.hasDescription")}
            >
              <AlignLeft class="size-3" />
            </span>
          {/if}
        {/if}
        <button
          type="button"
          class="{ROW_ACTION} hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground/50"
          onclick={() => handOff(item)}
          disabled={!canSend}
          use:tip={canSend
            ? t("todo.sendTo", {
                target: target?.title ?? target?.label ?? "the terminal",
              })
            : t("todo.sendNoTerminal")}
          aria-label={t("todo.sendLabel")}
        >
          <CornerDownRight class="size-3.5" />
        </button>
        <button
          type="button"
          class="{ROW_ACTION} hover:bg-danger/15 hover:text-danger"
          onclick={() => void remove(item)}
          use:tip={t("todo.remove")}
          aria-label={t("todo.removeLabel")}
        >
          <Trash2 class="size-3.5" />
        </button>
      </div>

      {#if openId === item.id}
        <!-- Aligned under the title rather than the checkbox: the box is
             the same object as the line above it, and a description that
             started at the tick would read as a second column. -->
        <div class="mt-1 pl-[23px]">
          <textarea
            value={item.description ?? ""}
            rows="2"
            placeholder={t("todo.descriptionPlaceholder")}
            use:descriptionBox
            onkeydown={(e) => fieldKeydown(item, e)}
            oninput={(e) => autosize(e.currentTarget as HTMLTextAreaElement)}
            onchange={(e) =>
              todos.setDescription(
                item.id,
                (e.currentTarget as HTMLTextAreaElement).value,
              )}
            class="w-full resize-none rounded border border-border bg-[var(--color-surface)] px-1.5 py-1 text-sm leading-relaxed text-foreground/90 outline-none transition placeholder:text-muted-foreground/60 focus:border-foreground/30"
          ></textarea>
        </div>
      {/if}

      <!-- Shown while the task is still live — claimed, or reopened after a
           claim — because that is when where the work landed is something
           you act on. A ticked box is a closed matter and collapses back to
           one line. Nothing is cleared either way: unticking brings the same
           strip back rather than an empty one. -->
      {#if item.state !== "done" && (item.claimedBy || item.commitSha || item.note)}
        <!-- What the agent said, reduced to what can be checked. The
             sentence it wrote is not shown at all: it is the one part of a
             claim nothing can back, and the badge next to it says who by.
             It is still stored, and still what a reopened task is judged on.

             Not selectable: this is a readout, and every chip on it is a
             hover target, so dragging across one only produced a highlight
             nobody asked for. -->
        <div
          class="mt-1 flex select-none items-center gap-1 pl-[23px] text-xs text-muted-foreground"
        >
          <!-- A label, not a control: nothing hides behind it, so it gets
               no box and no hover of its own. -->
          <span class="flex shrink-0 items-center px-0.5">
            {#if item.claimedBy}
              <ShortcutIcon iconKey={item.claimedBy} size={12} />
            {:else}
              <!-- Claimed through a credentials file, which names a project
                   and no thread: Boite did not launch this one and cannot
                   say which agent it was. -->
              <Bot class="size-3 shrink-0 text-muted-foreground/70" />
            {/if}
          </span>
          {#await gitState(item) then g}
            {#if !item.commitSha}
              <span class="px-1 text-muted-foreground/70">{t("todo.gitNoCommit")}</span>
            {:else if !g}
              <!-- Nowhere to look it up: no project folder to run git in.
                   Shown bare rather than judged — not finding a repository
                   is not the same as not finding the commit. -->
              <code class="px-1 tabular-nums text-muted-foreground/70">
                {item.commitSha.slice(0, 7)}
              </code>
            {:else if g.commit.unreachable}
              <!-- The repository was never reached, so nothing below this
                   line has been checked. Ahead of the `known` test because
                   an unreached clone answers `known: false` too, and that
                   used to draw "commit not found" over work that is there.
                   Muted, not warning: git has contradicted nothing. -->
              <button
                type="button"
                class="group/tip relative text-muted-foreground/70 {CHIP}"
                aria-expanded={openTip === `${item.id}:sha`}
                onclick={() => toggleTip(`${item.id}:sha`)}
              >
                {t("todo.gitUnreachable")}
                {@render chipDetail(item.commitSha, `${item.id}:sha`)}
              </button>
            {:else if !g.commit.known}
              <!-- Reported a sha the repository has never heard of. Said
                   plainly: this is the one claim git can flatly contradict. -->
              <button
                type="button"
                class="group/tip relative text-warning {CHIP}"
                aria-expanded={openTip === `${item.id}:sha`}
                onclick={() => toggleTip(`${item.id}:sha`)}
              >
                {t("todo.gitUnknownCommit")}
                {@render chipDetail(item.commitSha, `${item.id}:sha`)}
              </button>
            {:else}
              <!-- The branch first: it says where the work is, which is the
                   question being asked. The sha is what was verified, so it
                   stays reachable rather than on show. -->
              <button
                type="button"
                class="group/tip relative min-w-0 text-left {CHIP}"
                aria-expanded={openTip === `${item.id}:commit`}
                onclick={() => toggleTip(`${item.id}:commit`)}
              >
                <span class="block truncate text-foreground/80">
                  {g.commit.branch ?? g.commit.short}
                </span>
                {@render chipDetail(
                  `${g.commit.short}${g.commit.subject ? ` — ${g.commit.subject}` : ""}`,
                  `${item.id}:commit`,
                )}
              </button>
              <span class="shrink-0 text-muted-foreground/60">·</span>
              <span
                class="shrink-0 px-1 {g.commit.pushed ? '' : 'text-muted-foreground/70'}"
              >
                {g.commit.pushed ? t("todo.gitPushed") : t("todo.gitLocal")}
              </span>
              {#if g.pr.kind === "found"}
                <span class="shrink-0 text-muted-foreground/60">·</span>
                <button
                  type="button"
                  class="group/tip relative shrink-0 {CHIP}"
                  onclick={() => openPr(g.pr.kind === "found" ? g.pr.pr.url : "")}
                >
                  {t("todo.gitPr", { number: String(g.pr.pr.number) })}
                  <!-- No toggle on this one: pressing it opens the PR, which
                       is more than the url it would have shown. -->
                  {@render chipDetail(g.pr.pr.url, null)}
                </button>
              {:else if g.pr.kind === "failed"}
                <!-- gh was there and refused. Said, because unlike a missing
                     gh this is a state the user can be in without knowing —
                     and the signed-out case they can fix in one command. -->
                <span class="shrink-0 text-muted-foreground/60">·</span>
                <button
                  type="button"
                  class="group/tip relative shrink-0 text-warning/80 {CHIP}"
                  aria-expanded={openTip === `${item.id}:pr`}
                  onclick={() => toggleTip(`${item.id}:pr`)}
                >
                  {g.pr.auth ? t("todo.gitPrNoAuth") : t("todo.gitPrFailed")}
                  {@render chipDetail(
                    g.pr.auth ? t("todo.gitPrNoAuthHint") : g.pr.detail,
                    `${item.id}:pr`,
                  )}
                </button>
              {/if}
            {/if}
          {/await}
        </div>
      {/if}

      {#if item.state === "claimed"}
        <!-- An agent said it finished, and it stops here on purpose: a model
             that can tick its own boxes will, and the list would then record
             assertions instead of verified work. -->
        <div class="mt-1 flex gap-1 pl-[23px]">
          <button
            type="button"
            class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
            onclick={() => todos.setState(item.id, "done")}
          >
            <Check class="size-3" />
            {t("todo.confirm")}
          </button>
          <button
            type="button"
            class="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground transition hover:border-foreground/30 hover:text-foreground"
            onclick={() => todos.setState(item.id, "open")}
          >
            <Undo2 class="size-3" />
            {t("todo.reopen")}
          </button>
        </div>
      {/if}
    </div>
  {/each}
  <!-- The one slot no row can draw: past the last card. -->
  {#if dropSlot !== null && dropSlot === items.length - 1}
    {@render dropLine()}
  {/if}
</div>

{#snippet dropLine()}
  <!-- Where the card would land. A line rather than a gap: opening a
       row-height hole in a list this dense moves everything below it on every
       pointer move, and the thing you are aiming at stops holding still. -->
  <div class="pointer-events-none -my-px h-0.5 bg-foreground/50"></div>
{/snippet}

{#snippet chipDetail(text: string, key: string | null)}
  <!-- Replaces the native `title`, whose ~1s delay is the browser's and cannot
       be configured. Appears on hover with nothing in between.
       Below the chip, not above: the list scrolls, and anything absolute is
       clipped by that container at whichever edge it crosses. Measured — above
       the chip it lost 4.5px off the top row, which is the row that is always on
       screen, while below it there is nearly always list left. Left-aligned to
       the chip so a long one grows into the panel rather than off it.
       Hover was the only way in, which left it out of reach of a keyboard and of
       every touch screen: focus opens it now, and the chip's own press keeps it
       open for a finger that has no hover to give. -->
  <span
    class="pointer-events-none absolute left-0 top-full z-30 mt-1 w-max max-w-[240px] rounded border border-border bg-[var(--color-surface-2)] px-1.5 py-0.5 text-left text-xs leading-snug text-foreground shadow-md group-hover/tip:block group-focus-within/tip:block {key !==
    null && openTip === key
      ? 'block'
      : 'hidden'}"
  >
    {text}
  </span>
{/snippet}
