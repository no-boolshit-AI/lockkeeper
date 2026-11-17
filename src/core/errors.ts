/** Base class for errors that carry a user-facing fix hint. */
export class LockkeeperError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.hint = hint;
  }
}

/** The config file or environment is wrong. Always names the field or variable. */
export class ConfigError extends LockkeeperError {}

/** A run was refused before any sandbox started (T2, T3, T5). */
export class RunRefusedError extends LockkeeperError {}

/** The ticket already has an active run (T6). */
export class AlreadyActiveError extends LockkeeperError {
  constructor(
    readonly ticketKey: string,
    readonly runId: string,
    hint?: string,
  ) {
    super(`${ticketKey} already has an active run (${runId}).`, hint);
  }
}

export type CapName =
  | 'cost'
  | 'minutes'
  | 'turns'
  | 'fix_rounds'
  | 'diff_size'
  | 'parallel_runs'
  | 'runs_per_day'
  | 'open_prs_per_repo';

/** A per-run or per-install cap was hit (E7). The cap is named on the ticket. */
export class CapExceededError extends LockkeeperError {
  constructor(
    readonly cap: CapName,
    message: string,
  ) {
    super(message);
  }
}

/** A step inside the sandbox failed in a way the requester should see, with the log tail. */
export class StepFailedError extends LockkeeperError {
  constructor(
    readonly step: string,
    message: string,
    readonly logTail?: string,
  ) {
    super(message);
  }
}

/** The run was cancelled from the ticket or the CLI. */
export class RunCancelledError extends LockkeeperError {}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
