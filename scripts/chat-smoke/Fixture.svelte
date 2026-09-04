<script lang="ts">
  import Composer from "../../src/lib/features/pilot/Composer.svelte";
  import RequestCard from "../../src/lib/features/pilot/RequestCard.svelte";
  import ChatText from "../../src/lib/shared/components/ChatText.svelte";
  import type { PilotCatalog, PilotRequest } from "../../src/lib/features/pilot/types";

  const state = new URLSearchParams(location.search).get("state");
  const catalog: PilotCatalog = {
    drivers: [{ id: "codex", models: ["gpt-5"], capabilities: {
      model_switch: "in_session", rollback: true, modes: ["ask", "edit_alone", "yolo"], interrupt: true,
    } }], instances: [],
  };
  const request: PilotRequest = {
    id: "approval", kind: "tool_approval", tool_name: "shell",
    title: "Exécuter les tests du projet ?", input: { command: "bun run test" },
    options: [{ value: "allow", label: "Autoriser" }, { value: "deny", label: "Refuser" }],
  };
</script>

<main class="flex h-dvh flex-col bg-background text-foreground" data-testid="smoke-ready">
  <header class="flex items-center justify-between border-b border-border px-6 py-4">
    <strong>Boite · Conversation</strong><span class="text-sm text-muted-foreground">Codex</span>
  </header>
  <section class="mx-auto flex w-full max-w-[52rem] flex-1 flex-col gap-6 overflow-auto px-4 py-8">
    <div class="flex justify-end"><ChatText mine text="Ajoute une messagerie native dans Boite." /></div>
    <ChatText plain text="La conversation passe par l'interface de Boite. Le moteur travaille en arrière-plan et les demandes d'autorisation apparaissent ici." />
    <RequestCard threadId="smoke" {request} outcome={null} />
  </section>
  <Composer threadId="smoke" draftScope="smoke" status="idle"
    open={state !== "connecting" && state !== "failed"}
    connecting={state === "connecting"} connectionFailed={state === "failed"}
    onOpen={() => {}} commands={[]} {catalog} driver="codex" instance={null}
    model="gpt-5" availableModels={["gpt-5"]} mode="ask" />
</main>
