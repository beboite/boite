import { backend } from "$lib/backend";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  tsMs: number;
  level: string;
  source: string;
  message: string;
  details: string | null;
}

function serializeDetails(value: unknown): string {
  if (value instanceof Error) {
    return JSON.stringify({
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: value.cause ?? undefined,
    });
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

class Logger {
  private send(level: LogLevel, scope: string, message: string, data?: unknown) {
    const tag = `[${scope}]`;
    if (level === "error") console.error(tag, message, data ?? "");
    else if (level === "warn") console.warn(tag, message, data ?? "");
    else if (level === "debug") console.debug(tag, message, data ?? "");
    else console.log(tag, message, data ?? "");

    void backend()
      .log.event(level, scope, message, data == null ? null : serializeDetails(data))
      .catch(() => {});
  }

  debug(scope: string, message: string, data?: unknown) {
    this.send("debug", scope, message, data);
  }
  info(scope: string, message: string, data?: unknown) {
    this.send("info", scope, message, data);
  }
  warn(scope: string, message: string, data?: unknown) {
    this.send("warn", scope, message, data);
  }
  error(scope: string, message: string, data?: unknown) {
    this.send("error", scope, message, data);
  }

  read(scope: "current" | "previous" = "current"): Promise<LogEntry[]> {
    return backend().log.read(scope);
  }

  clear(): Promise<void> {
    return backend().log.clear();
  }

  filePath(): Promise<string> {
    return backend().log.filePath();
  }
}

export const logger = new Logger();
