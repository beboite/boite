import { invoke } from "./ipc";
import type { ConductApi, DispatchLine, OrchestratorMessage, PulseAnswer } from "../types";

// Same bus as records: `boite_core::command::conduct` answers for both hosts,
// this file only names the Tauri handlers. No long-poll goes through here — the
// desktop webview passes `timeoutMs: 0` because Tauri events already wake it,
// and holding an IPC call open for two minutes would starve the invoke queue.
export const tauriConduct: ConductApi = {
  record(moment): Promise<{ seq: number }> {
    return invoke("conduct_record", { params: moment });
  },

  pulse(params): Promise<PulseAnswer> {
    return invoke("conduct_pulse", { params });
  },

  post(params): Promise<{ messageId: string }> {
    return invoke("conduct_orchestrator_post", { params });
  },

  messages(params): Promise<OrchestratorMessage[]> {
    return invoke("conduct_orchestrator_messages", { params });
  },

  start(params): Promise<{ threadId: string }> {
    return invoke("conduct_orchestrator_start", { params });
  },

  status(params): Promise<{ threadId: string | null; state: string }> {
    return invoke("conduct_orchestrator_status", { params });
  },

  acceptDispatch(params): Promise<{ threadId: string; accept: boolean; dropped: number }> {
    return invoke("conduct_thread_accept_dispatch", { params });
  },

  drainDispatches(params): Promise<DispatchLine[]> {
    return invoke("conduct_dispatch_drain", { params });
  },

  settleDispatch(params): Promise<{ settled: boolean }> {
    return invoke("conduct_dispatch_settle", { params });
  },
};
