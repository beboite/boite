export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  id: string;
  timestamp: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

const MAX_ENTRIES = 1000;

class LoggerStore {
  entries = $state<LogEntry[]>([]);

  private push(level: LogLevel, scope: string, message: string, data?: unknown) {
    const entry: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      level,
      scope,
      message,
      data,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    const tag = `[${scope}]`;
    if (level === "error") console.error(tag, message, data ?? "");
    else if (level === "warn") console.warn(tag, message, data ?? "");
    else console.log(tag, message, data ?? "");
  }

  debug(scope: string, message: string, data?: unknown) {
    this.push("debug", scope, message, data);
  }
  info(scope: string, message: string, data?: unknown) {
    this.push("info", scope, message, data);
  }
  warn(scope: string, message: string, data?: unknown) {
    this.push("warn", scope, message, data);
  }
  error(scope: string, message: string, data?: unknown) {
    this.push("error", scope, message, data);
  }

  clear() {
    this.entries = [];
  }
}

export const logger = new LoggerStore();
