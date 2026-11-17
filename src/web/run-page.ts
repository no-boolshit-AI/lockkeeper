import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { formatCost } from '../engine/report.js';
import {
  type AuditEvent,
  FINISHED_STATES,
  PARKED_STATES,
  type RunRecord,
  type Store,
} from '../store/store.js';

/**
 * The run page (P1): a local, read-only web view of runs, with a live log, the diff
 * and the cost. It listens on 127.0.0.1 only, under an unguessable path, and answers
 * only requests addressed to that host, so other sites cannot read it through the
 * browser. Everything shown is escaped: agent text and diffs are untrusted.
 */

export interface RunPageOptions {
  store: Store;
  /** 0 picks a free port. */
  port?: number;
  /** The secret first path segment. Random when unset. */
  token?: string;
}

export interface RunPage {
  url: string;
  close(): Promise<void>;
}

/** One line of a run's log, as the page shows it. */
export interface LogLine {
  id: number;
  ts: string;
  text: string;
}

const MAX_TEXT = 600;

function clip(value: string, max = MAX_TEXT): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A short, human line for an audit event, or undefined for events not worth showing. */
export function describeEvent(event: AuditEvent): string | undefined {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  switch (event.kind) {
    case 'state':
      return `→ ${text(data.state)}${typeof data.round === 'number' && data.round > 0 ? ` (round ${data.round})` : ''}`;
    case 'snapshot':
      return `Read the ticket: ${clip(text(data.summary), 200)}`;
    case 'sandbox':
      return `${data.resumed ? 'Resumed' : 'Started'} sandbox ${text(data.id)}`;
    case 'baseline': {
      const failed = Array.isArray(data.failed) ? (data.failed as string[]) : [];
      return failed.length > 0
        ? `Checks on the base branch: already failing: ${failed.join(', ')}`
        : 'Checks on the base branch: all passed';
    }
    case 'checks': {
      const checks = Array.isArray(data.checks)
        ? (data.checks as { command: string; passed: boolean }[])
        : [];
      return `Checks: ${checks.map((check) => `${check.passed ? '✓' : '✗'} ${check.command}`).join(', ')}`;
    }
    case 'agent': {
      switch (data.type) {
        case 'tool_call':
          return `${text(data.tool)}: ${clip(text(data.summary))}`;
        case 'message':
          return clip(text(data.text));
        case 'result':
          return `Agent finished: ${text(data.outcome)}${typeof data.costUsd === 'number' ? `, ${formatCost(data.costUsd)}` : ''}`;
        case 'session':
          return `Agent session ${text(data.sessionId)}`;
        case 'retry':
          return `Model API retry ${String(data.attempt ?? '')}`;
        default:
          return undefined;
      }
    }
    case 'commit':
      return `Committed ${text(data.sha).slice(0, 12)} to ${text(data.branch)}`;
    case 'pull_request':
      return `Pull request ${text(data.url)}`;
    case 'pr_reply':
      return `Replied on the pull request`;
    case 'feedback':
      return data.kind === 'ci' ? 'CI failed on the pull request' : 'Review feedback arrived';
    case 'readiness':
      return `Readiness check: ${text(data.verdict)}`;
    case 'error':
      return `Stopped: ${clip(text(data.message))}`;
    case 'cancelled':
      return `Cancelled: ${clip(text(data.reason))}`;
    case 'pr_closed':
      return data.merged ? 'The pull request was merged' : 'The pull request was closed';
    default:
      return undefined;
  }
}

export function logLines(events: readonly AuditEvent[]): LogLine[] {
  const lines: LogLine[] = [];
  for (const event of events) {
    const text = describeEvent(event);
    if (text) lines.push({ id: event.id, ts: event.ts, text });
  }
  return lines;
}

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** U+2028 and U+2029, built from code points so no such character sits in the source. */
const LINE_SEPARATORS = new RegExp(`[${String.fromCodePoint(0x2028, 0x2029)}]`, 'g');

/** JSON for a script block: no closing tags or line separators can break out of it. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(LINE_SEPARATORS, (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16)}`);

const STYLE = `
  body { font: 14px/1.45 system-ui, sans-serif; margin: 24px; color: #1f2328; background: #fff; }
  h1 { font-size: 18px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 24px 0 8px; }
  table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 4px 8px; border-bottom: 1px solid #d0d7de; }
  a { color: #0969da; } .muted { color: #59636e; }
  pre, ol { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f6f8fa; padding: 12px; overflow-x: auto; }
  ol { list-style: none; margin: 0; max-height: 50vh; overflow-y: auto; } li { white-space: pre-wrap; word-break: break-word; }
  .add { color: #116329; } .del { color: #82071e; } .hunk { color: #8250df; }
  @media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } pre, ol { background: #161b22; }
    td, th { border-color: #30363d; } a { color: #4493f8; } .muted { color: #9198a1; } .add { color: #3fb950; } .del { color: #f85149; } }`;

function page(title: string, nonce: string, body: string, refresh = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="5">' : ''}<title>${escapeHtml(title)}</title><style nonce="${nonce}">${STYLE}</style></head><body>${body}</body></html>`;
}

const isLive = (run: RunRecord) =>
  !FINISHED_STATES.includes(run.state) && !PARKED_STATES.includes(run.state);

function runsPage(runs: readonly RunRecord[], base: string, nonce: string): string {
  const rows = runs
    .map(
      (run) =>
        `<tr><td><a href="${base}/runs/${encodeURIComponent(run.id)}">${escapeHtml(run.ticketKey)}</a></td><td>${escapeHtml(run.kind)}</td><td>${escapeHtml(run.state)}</td><td>${escapeHtml(formatCost(run.costUsd ?? undefined))}</td><td>${run.prUrl ? `<a href="${escapeHtml(run.prUrl)}" rel="noreferrer">#${run.prNumber}</a>` : ''}</td><td class="muted">${escapeHtml(run.updatedAt.replace('T', ' ').slice(0, 19))}</td></tr>`,
    )
    .join('');
  return page(
    'Lockkeeper runs',
    nonce,
    `<h1>Lockkeeper runs</h1><p class="muted">The newest ${runs.length} runs. This page refreshes every 5 seconds.</p><table><thead><tr><th>Ticket</th><th>Kind</th><th>State</th><th>Cost</th><th>PR</th><th>Updated</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No runs yet.</td></tr>'}</tbody></table>`,
    true,
  );
}

function diffBlock(diff: string): string {
  if (!diff.trim()) return '<p class="muted">No diff yet.</p>';
  const lines = diff.split('\n').map((line) => {
    const cls =
      line.startsWith('+++') || line.startsWith('---')
        ? ''
        : line.startsWith('+')
          ? 'add'
          : line.startsWith('-')
            ? 'del'
            : line.startsWith('@@')
              ? 'hunk'
              : '';
    return cls ? `<span class="${cls}">${escapeHtml(line)}</span>` : escapeHtml(line);
  });
  return `<pre>${lines.join('\n')}</pre>`;
}

function runPage(run: RunRecord, store: Store, base: string, nonce: string): string {
  const lines = logLines(store.events(run.id));
  const diff = store.latestEvent<{ text?: string }>(run.id, 'diff')?.text ?? '';
  const log = lines
    .map((line) => `<li>${escapeHtml(line.ts.slice(11, 19))}  ${escapeHtml(line.text)}</li>`)
    .join('');
  const pr = run.prUrl
    ? ` · <a href="${escapeHtml(run.prUrl)}" rel="noreferrer">pull request #${run.prNumber}</a>`
    : '';
  const state = {
    base,
    id: run.id,
    after: lines.at(-1)?.id ?? 0,
    live: isLive(run),
  };
  const script = `
const state = ${scriptJson(state)};
const log = document.getElementById('log');
const fields = { state: document.getElementById('state'), cost: document.getElementById('cost') };
async function poll() {
  try {
    const response = await fetch(state.base + '/api/runs/' + encodeURIComponent(state.id) + '?after=' + state.after);
    const data = await response.json();
    for (const line of data.lines) {
      const item = document.createElement('li');
      item.textContent = line.ts.slice(11, 19) + '  ' + line.text;
      log.appendChild(item);
      state.after = line.id;
    }
    if (data.lines.length > 0) log.scrollTop = log.scrollHeight;
    fields.state.textContent = data.run.state;
    fields.cost.textContent = data.cost;
    if (data.live) { setTimeout(poll, 2000); } else if (data.lines.length > 0) { location.reload(); }
  } catch { setTimeout(poll, 5000); }
}
if (state.live) setTimeout(poll, 2000);
log.scrollTop = log.scrollHeight;`;
  return page(
    `${run.ticketKey} · Lockkeeper`,
    nonce,
    `<p><a href="${base}/">All runs</a></p><h1>${escapeHtml(run.ticketKey)} <span class="muted">${escapeHtml(run.kind)} run ${escapeHtml(run.id)}</span></h1><p><span id="state">${escapeHtml(run.state)}</span> · <span id="cost">${escapeHtml(formatCost(run.costUsd ?? undefined))}</span> · ${escapeHtml(run.agent)}${run.branch ? ` · <code>${escapeHtml(run.branch)}</code>` : ''}${pr}</p>${run.error ? `<p>${escapeHtml(run.error)}</p>` : ''}<h2>Log</h2><ol id="log">${log}</ol><h2>Diff</h2>${diffBlock(diff)}<script nonce="${nonce}">${script}</script>`,
  );
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
  nonce?: string,
): void {
  res.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; ${nonce ? `script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; ` : ''}connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
  res.end(body);
}

export async function startRunPage(options: RunPageOptions): Promise<RunPage> {
  const { store } = options;
  const token = options.token ?? randomBytes(16).toString('hex');
  const base = `/${token}`;
  let allowedHosts = new Set<string>();

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain', 'This page is read-only.');
      return;
    }
    // A page on another site could point a name it controls at 127.0.0.1 (DNS
    // rebinding). Answering only this host keeps it from reading anything.
    if (!allowedHosts.has(req.headers.host ?? '')) {
      send(res, 421, 'text/plain', 'Open the address Lockkeeper printed.');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
      send(res, 404, 'text/plain', 'Not found.');
      return;
    }
    const path = url.pathname.slice(base.length) || '/';
    const nonce = randomBytes(12).toString('base64');
    if (path === '/') {
      send(res, 200, 'text/html', runsPage(store.listRuns({ limit: 100 }), base, nonce), nonce);
      return;
    }
    const pageMatch = /^\/runs\/([\w-]+)$/.exec(path);
    if (pageMatch) {
      const run = store.getRun(pageMatch[1] as string);
      if (!run) send(res, 404, 'text/plain', 'No such run.');
      else send(res, 200, 'text/html', runPage(run, store, base, nonce), nonce);
      return;
    }
    if (path === '/api/runs') {
      send(res, 200, 'application/json', JSON.stringify(store.listRuns({ limit: 100 })));
      return;
    }
    const apiMatch = /^\/api\/runs\/([\w-]+)$/.exec(path);
    if (apiMatch) {
      const run = store.getRun(apiMatch[1] as string);
      if (!run) {
        send(res, 404, 'application/json', JSON.stringify({ error: 'No such run.' }));
        return;
      }
      const after = Number(url.searchParams.get('after') ?? 0) || 0;
      const lines = logLines(store.events(run.id)).filter((line) => line.id > after);
      send(
        res,
        200,
        'application/json',
        JSON.stringify({
          run,
          lines,
          live: isLive(run),
          cost: formatCost(run.costUsd ?? undefined),
        }),
      );
      return;
    }
    send(res, 404, 'text/plain', 'Not found.');
  };

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      if (!res.headersSent) send(res, 500, 'text/plain', 'Something went wrong.');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return {
    url: `http://127.0.0.1:${port}${base}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
