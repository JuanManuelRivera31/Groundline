/**
 * Structured logs that can never carry customer text (ADR-0012): only an
 * allow-listed set of fields with primitive values is accepted, so a question,
 * note, answer or IP address cannot be logged by mistake.
 */

export interface LogFields {
  readonly event: string;
  readonly conversation_id?: string | undefined;
  readonly handoff_id?: string | undefined;
  readonly status?: string | undefined;
  readonly http_status?: number | undefined;
  readonly latency_ms?: number | undefined;
  readonly country?: string | null | undefined;
  readonly answered_by?: string | null | undefined;
  readonly redacted_spans?: number | undefined;
  readonly route?: string | undefined;
  /** Error class name or a fixed code, never an error message. */
  readonly error?: string | undefined;
  readonly count?: number | undefined;
}

export interface Logger {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

export function jsonLogger(write: (line: string) => void = (line) => { console.log(line); }): Logger {
  const emit = (level: string, fields: LogFields): void => {
    write(JSON.stringify({ level, ts: new Date().toISOString(), ...fields }));
  };
  return {
    info: (f) => { emit('info', f); },
    warn: (f) => { emit('warn', f); },
    error: (f) => { emit('error', f); },
  };
}

/** A safe label for an unknown error: its class name and, for Postgres errors, the SQLSTATE code. */
export function errorLabel(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `${error.name}:${code}` : error.name;
  }
  return typeof error;
}
