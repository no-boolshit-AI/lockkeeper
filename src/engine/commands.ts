/**
 * Commands people write in ticket comments. A command is the first word after
 * `/agent` at the start of the comment; the rest of the comment is its text:
 *
 * - `/agent stop` cancels the active run (F3).
 * - `/agent retry <hint>` starts a new run on the same branch (F3).
 * - `/agent go <answers>` continues a run waiting for answers (R2).
 */
export type AgentCommand =
  | { kind: 'stop' }
  | { kind: 'retry'; hint: string }
  | { kind: 'go'; text: string }
  | { kind: 'unknown'; word: string };

// Closing marks may follow `/agent` itself, as in **/agent** stop.
const COMMAND = /^\/agent[`*_]*(?:\s+([A-Za-z-]+))?\b[ \t]*([\s\S]*)$/;

/**
 * Commands on a pull request (F1). `/agent stop` stops a follow-up in progress. Any
 * other `/agent <text>` asks for a follow-up, and the whole comment is the request.
 */
export type PullRequestCommand = { kind: 'stop' } | { kind: 'request' };

export function parsePullRequestCommand(body: string): PullRequestCommand | undefined {
  const start = body.trimStart().replace(/^[`*_>\s]+/, '');
  if (!/^\/agent\b/i.test(start)) return undefined;
  const command = parseCommand(`/agent${start.slice('/agent'.length)}`);
  return command?.kind === 'stop' ? { kind: 'stop' } : { kind: 'request' };
}

export function parseCommand(body: string): AgentCommand | undefined {
  // Jira's rich text may wrap the command in code, bold or quote marks.
  const start = body.trimStart().replace(/^[`*_>\s]+/, '');
  const match = COMMAND.exec(start);
  if (!match) return undefined;
  const word = (match[1] ?? '').toLowerCase();
  const rest = (match[2] ?? '').replace(/^[`*_]+/, '').trim();
  switch (word) {
    case 'stop':
    case 'cancel':
      return { kind: 'stop' };
    case 'retry':
      return { kind: 'retry', hint: rest };
    case 'go':
      return { kind: 'go', text: rest };
    default:
      return { kind: 'unknown', word: word || '(none)' };
  }
}
