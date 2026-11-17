import {
  bold,
  bullets,
  code,
  codeBlock,
  type Doc,
  heading,
  type Inline,
  link,
  numbered,
  paragraph,
  table,
  tasks,
  text,
} from '../core/doc.js';
import type { PolicyFinding } from '../policy/diff-policy.js';
import { sanitizeAgentText } from '../policy/secrets.js';
import type { Person, TicketSnapshot } from '../tracker/tracker.js';
import type { FailingTestProof } from './failing-test.js';
import type { CriterionResult } from './prompts.js';
import type { CheckResult } from './workspace.js';

/**
 * Templates for everything Lockkeeper posts: one status comment per run, edited in
 * place (J1), and the PR body (V4). Agent-written text passes through
 * sanitizeAgentText (length cap, secret redaction) before it reaches a template.
 */

export interface RunContext {
  ticket: TicketSnapshot;
  runId: string;
  agentName: string;
  limits: { costUsd: number; minutes: number };
  /** Who asked for the run, such as the person who added the label. Notified at the end. */
  requester?: Person;
}

export function formatCost(usd: number | undefined): string {
  return usd === undefined ? 'cost unknown' : `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} min`;
}

function header(ctx: RunContext, status: string): Doc[number] {
  return paragraph(bold('Lockkeeper'), ` · ${ctx.ticket.key} · ${status}`);
}

function hiddenTextNotice(ticket: TicketSnapshot): Doc {
  const { invisibleChars, hiddenSegments } = ticket.hiddenText;
  if (invisibleChars === 0 && hiddenSegments === 0) return [];
  const parts: string[] = [];
  if (invisibleChars > 0) parts.push(`${invisibleChars} invisible characters`);
  if (hiddenSegments > 0) parts.push(`${hiddenSegments} pieces of unreadable coloured text`);
  return [
    paragraph(`Hidden text was removed before the agent read the ticket: ${parts.join(' and ')}.`),
  ];
}

export function pickedUpDoc(ctx: RunContext): Doc {
  return [
    header(ctx, 'working'),
    paragraph(
      'Picked up. The agent works in a sealed sandbox, and this comment is updated as the run goes.',
    ),
    ...hiddenTextNotice(ctx.ticket),
    paragraph(
      `Run ${ctx.runId} · ${ctx.agentName} · limits: ${formatCost(ctx.limits.costUsd)}, ${ctx.limits.minutes} min`,
    ),
  ];
}

export function progressDoc(ctx: RunContext, step: string): Doc {
  return [
    header(ctx, 'working'),
    paragraph(`Now: ${step}.`),
    ...hiddenTextNotice(ctx.ticket),
    paragraph(
      `Run ${ctx.runId} · ${ctx.agentName} · limits: ${formatCost(ctx.limits.costUsd)}, ${ctx.limits.minutes} min`,
    ),
  ];
}

export interface Outcome {
  pr: { url: string; number: number; draft: boolean };
  branch: string;
  criteria: CriterionResult[];
  checks: CheckResult[];
  draftReasons: string[];
  summary: string;
  costUsd: number | undefined;
  durationMs: number;
  fixRounds: number;
}

function checksLine(checks: readonly CheckResult[]): Inline[] {
  if (checks.length === 0) return [text('No lint or test commands are configured or detected.')];
  const failed = checks.filter((check) => !check.passed);
  const inlines: Inline[] = [text('Verified by: ')];
  checks.forEach((check, index) => {
    if (index > 0) inlines.push(text(', '));
    inlines.push(code(check.command));
  });
  inlines.push(
    text(
      failed.length === 0
        ? ' (all passed)'
        : ` (failed: ${failed.map((check) => check.command).join(', ')})`,
    ),
  );
  return inlines;
}

function runLine(
  ctx: RunContext,
  outcome: { costUsd: number | undefined; durationMs: number; fixRounds: number },
): string {
  const rounds = outcome.fixRounds === 1 ? '1 fix round' : `${outcome.fixRounds} fix rounds`;
  return `Run: ${formatDuration(outcome.durationMs)} · ${formatCost(outcome.costUsd)} · ${ctx.agentName} · ${rounds} · ${ctx.runId}`;
}

export function resultDoc(
  ctx: RunContext,
  outcome: Outcome,
  options: { status?: string; note?: string } = {},
): Doc {
  const status =
    options.status ??
    (outcome.pr.draft ? 'draft pull request, needs a person' : 'ready for review');
  const doc: Doc = [
    header(ctx, status),
    paragraph(text('PR: '), link(outcome.pr.url, outcome.pr.url)),
  ];
  if (options.note) doc.push(paragraph(options.note));
  doc.push(paragraph(text('Branch: '), code(outcome.branch)));
  if (outcome.summary) doc.push(paragraph(outcome.summary));
  if (outcome.criteria.length > 0) {
    doc.push(paragraph(bold('Acceptance criteria')));
    doc.push(
      tasks(
        ...outcome.criteria.map((criterion) => ({
          done: criterion.met,
          content: [
            criterion.criterion,
            criterion.met ? ` (${criterion.evidence})` : ' (no evidence)',
          ],
        })),
      ),
    );
  }
  doc.push(paragraph(...checksLine(outcome.checks)));
  if (outcome.draftReasons.length > 0) {
    doc.push(paragraph(bold('Draft because')));
    doc.push(bullets(...outcome.draftReasons));
  }
  doc.push(paragraph(runLine(ctx, outcome)));
  return doc;
}

/**
 * F2: the status comment once the pull request is merged or closed. The run's result
 * stays, under a status that says how it ended.
 */
export function closedOutDoc(
  ctx: RunContext,
  outcome: Outcome | undefined,
  closed: { merged: boolean; url: string },
): Doc {
  const status = closed.merged ? 'merged' : 'closed without merging';
  const note = closed.merged
    ? 'The pull request was merged. Its sandbox was deleted.'
    : 'The pull request was closed without merging. Its sandbox was deleted.';
  if (outcome) return resultDoc(ctx, outcome, { status, note });
  return [
    header(ctx, status),
    paragraph(text('PR: '), link(closed.url, closed.url)),
    paragraph(note),
    paragraph(`Run ${ctx.runId}`),
  ];
}

export function noChangesDoc(
  ctx: RunContext,
  outcome: { message: string; costUsd: number | undefined; durationMs: number; fixRounds: number },
): Doc {
  const doc: Doc = [
    header(ctx, 'no changes'),
    paragraph('The agent finished without changing any files, so there is no pull request.'),
  ];
  if (outcome.message) doc.push(paragraph(bold('The agent said:')), paragraph(outcome.message));
  doc.push(paragraph(runLine(ctx, outcome)));
  return doc;
}

/**
 * R2: the readiness check's questions, in a comment of their own so the requester is
 * notified (J1). The questions are agent text: cleaned, capped and rendered escaped.
 */
export function questionsDoc(
  ctx: RunContext,
  input: { questions: string[]; reason: string; label: string },
): Doc {
  const doc: Doc = [
    paragraph(
      ...mentionOf(ctx.requester ?? ctx.ticket.reporter),
      text(`Lockkeeper needs a few answers before it starts on ${ctx.ticket.key}.`),
    ),
  ];
  if (input.reason) doc.push(paragraph(input.reason));
  doc.push(numbered(...input.questions));
  doc.push(
    paragraph(
      'Reply with ',
      code('/agent go'),
      ' and your answers, or update the ticket and reply ',
      code('/agent go'),
      `. Removing the ${input.label} label cancels the run.`,
    ),
  );
  return doc;
}

/** The status comment while a run waits for answers. */
export function waitingDoc(
  ctx: RunContext,
  check: { costUsd: number | undefined; durationMs: number },
): Doc {
  return [
    header(ctx, 'waiting for answers'),
    paragraph(
      'The readiness check found open questions, asked in a separate comment. The run continues when someone replies /agent go.',
    ),
    paragraph(
      `Readiness check: ${formatDuration(check.durationMs)} · ${formatCost(check.costUsd)} · ${ctx.agentName} · ${ctx.runId}`,
    ),
  ];
}

/** The status comment when the readiness check declines the ticket. */
export function declinedDoc(
  ctx: RunContext,
  check: { reason: string; costUsd: number | undefined; durationMs: number },
): Doc {
  return [
    header(ctx, 'declined'),
    paragraph('The readiness check decided this ticket cannot be built as written:'),
    paragraph(check.reason),
    paragraph('Edit the ticket and add the label again, or comment /agent retry with a note.'),
    paragraph(
      `Readiness check: ${formatDuration(check.durationMs)} · ${formatCost(check.costUsd)} · ${ctx.agentName} · ${ctx.runId}`,
    ),
  ];
}

export function failedDoc(
  ctx: RunContext,
  failure: { reason: string; logTail?: string; costUsd: number | undefined; durationMs: number },
): Doc {
  const doc: Doc = [header(ctx, 'stopped'), paragraph(failure.reason)];
  if (failure.logTail) doc.push(codeBlock(failure.logTail));
  doc.push(
    paragraph(
      `Run: ${formatDuration(failure.durationMs)} · ${formatCost(failure.costUsd)} · ${ctx.agentName} · ${ctx.runId}`,
    ),
  );
  return doc;
}

/**
 * A short, separate comment for the final result (J1). Edits to the status comment do
 * not notify anyone; a new comment that mentions the requester does.
 */
export function finalNoticeDoc(
  ctx: RunContext,
  notice:
    | { kind: 'pr'; url: string; draft: boolean }
    | { kind: 'no_changes' }
    | { kind: 'failed'; reason: string }
    | { kind: 'declined'; reason: string },
): Doc {
  const lead = mentionOf(ctx.requester ?? ctx.ticket.reporter);
  switch (notice.kind) {
    case 'pr':
      return [
        paragraph(
          ...lead,
          text(
            notice.draft
              ? 'Lockkeeper opened a draft pull request that needs a person: '
              : 'Lockkeeper opened a pull request that is ready for review: ',
          ),
          link(notice.url, notice.url),
          text(notice.draft ? '. The status comment says why it is a draft.' : ''),
        ),
      ];
    case 'no_changes':
      return [
        paragraph(
          ...lead,
          text(
            'The agent made no changes, so there is no pull request. The status comment has its explanation.',
          ),
        ),
      ];
    case 'failed':
      return [
        paragraph(
          ...lead,
          text(`Lockkeeper stopped: ${notice.reason} The status comment has the details.`),
        ),
      ];
    case 'declined':
      return [
        paragraph(
          ...lead,
          text(`Lockkeeper will not build this ticket as written: ${notice.reason}`),
        ),
      ];
  }
}

function mentionOf(person: Person | undefined): Inline[] {
  return person
    ? [{ kind: 'mention', id: person.accountId, name: person.displayName }, text(' ')]
    : [];
}

export function refusedDoc(key: string, reason: string, hint?: string): Doc {
  const doc: Doc = [paragraph(bold('Lockkeeper'), ` · ${key} · not started`), paragraph(reason)];
  if (hint) doc.push(paragraph(hint));
  return doc;
}

/**
 * The status comment for a run that waits before it starts: for a free slot, or under
 * the daily or open-PR caps (T1: feedback within a minute).
 */
export function queuedDoc(input: {
  key: string;
  runId: string;
  /** Why it waits and until when, in one or two sentences. */
  waiting: string;
  agentName: string;
  limits: RunContext['limits'];
}): Doc {
  return [
    paragraph(bold('Lockkeeper'), ` · ${input.key} · queued`),
    paragraph(`Picked up. ${input.waiting} This comment is updated as the run goes.`),
    paragraph(
      `Run ${input.runId} · ${input.agentName} · limits: ${formatCost(input.limits.costUsd)}, ${input.limits.minutes} min`,
    ),
  ];
}

/** The status comment for a run stopped before it started. */
export function stoppedBeforeStartDoc(key: string, reason: string, runId: string): Doc {
  return [
    paragraph(bold('Lockkeeper'), ` · ${key} · stopped`),
    paragraph(reason),
    paragraph(`Run ${runId}`),
  ];
}

// ---------------------------------------------------------------------------

export interface PullRequestBodyInput {
  ctx: RunContext;
  summary: string;
  addedLines: number;
  removedLines: number;
  fileCount: number;
  criteria: CriterionResult[];
  checks: CheckResult[];
  findings: PolicyFinding[];
  risks: string[];
  draftReasons: string[];
  costUsd: number | undefined;
  durationMs: number;
  fixRounds: number;
  /** Bug fixes: whether the new tests fail without the fix (E5). */
  proof?: FailingTestProof;
  /** What every run on this pull request cost together, once there is more than one. */
  total?: { costUsd: number; runs: number };
}

const MAX_PR_BODY = 60_000;

function listed(paths: readonly string[]): string {
  return `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', …' : ''}`;
}

/** E5: what Lockkeeper found when it ran the new tests without the fix. */
function proofParagraph(proof: FailingTestProof): Doc[number] {
  switch (proof.kind) {
    case 'proven':
      return paragraph(
        bold('Failing test first: '),
        text('without the fix, '),
        code(proof.command),
        text(
          ` failed (exit ${proof.exitCode}) with the new tests (${listed(proof.tests)}). With the fix, it passes.`,
        ),
      );
    case 'passed_before':
      return paragraph(
        bold('Failing test first: no. '),
        text(
          `The new tests (${listed(proof.tests)}) pass without the fix too, so they do not show the bug.`,
        ),
      );
    case 'no_test':
      return paragraph(
        bold('No failing test. '),
        text(
          proof.reason
            ? `The agent says: ${proof.reason}`
            : 'The agent added no test and gave no reason.',
        ),
      );
    case 'skipped':
      return paragraph(bold('Failing test first: not checked. '), text(proof.reason));
  }
}

export function pullRequestBodyDoc(input: PullRequestBodyInput): Doc {
  const { ctx } = input;
  const doc: Doc = [
    heading(1, 'What changed'),
    paragraph(
      input.summary || 'The agent gave no summary.',
      ` (${input.addedLines} lines added, ${input.removedLines} removed, ${input.fileCount} ${input.fileCount === 1 ? 'file' : 'files'}.)`,
    ),
    paragraph(text('Ticket: '), link(`${ctx.ticket.key}: ${ctx.ticket.summary}`, ctx.ticket.url)),
  ];

  doc.push(heading(1, 'Acceptance criteria'));
  if (input.criteria.length === 0) {
    doc.push(paragraph('The ticket lists no acceptance criteria, and the agent reported none.'));
  } else {
    doc.push(
      table(
        ['Criterion', 'Evidence'],
        input.criteria.map((criterion) => [
          criterion.criterion,
          criterion.met
            ? criterion.evidence
            : `Not met: ${criterion.evidence || 'no evidence given'}`,
        ]),
      ),
    );
    if (ctx.ticket.acceptanceCriteriaSource === 'none') {
      doc.push(
        paragraph(
          'The ticket lists no acceptance criteria; these are the ones the agent inferred.',
        ),
      );
    }
  }

  doc.push(heading(1, 'Verification'));
  if (input.checks.length === 0) {
    doc.push(
      paragraph(
        'No lint or test commands are configured or detected, so nothing was run after the agent stopped.',
      ),
    );
  } else {
    doc.push(
      bullets(
        ...input.checks.map((check) => [
          code(check.command),
          text(
            check.passed
              ? `: passed (${Math.round(check.durationMs / 1000)} s)`
              : `: failed with exit code ${check.exitCode}`,
          ),
        ]),
      ),
    );
    for (const check of input.checks.filter((entry) => !entry.passed)) {
      doc.push(paragraph(text('Output of '), code(check.command), text(':')));
      doc.push(codeBlock(check.output));
    }
  }
  if (input.proof) doc.push(proofParagraph(input.proof));

  doc.push(heading(1, 'Risks and things to check'));
  const riskItems: Inline[][] = [];
  for (const finding of input.findings) {
    const paths = finding.paths?.length
      ? ` ${finding.paths.slice(0, 10).join(', ')}${finding.paths.length > 10 ? ', …' : ''}`
      : '';
    riskItems.push([text(`${finding.message}${paths}`)]);
  }
  if (!input.findings.some((finding) => finding.code === 'protected-path'))
    riskItems.push([text('No protected paths touched.')]);
  for (const risk of input.risks) riskItems.push([text(risk)]);
  doc.push(bullets(...riskItems));

  if (input.draftReasons.length > 0) {
    doc.push(heading(1, 'Why this is a draft'));
    doc.push(bullets(...input.draftReasons));
  }

  doc.push(heading(1, 'Run'));
  doc.push(paragraph(runLine(ctx, input)));
  if (input.total && input.total.runs > 1) {
    doc.push(
      paragraph(
        `All ${input.total.runs} runs on this pull request: ${formatCost(input.total.costUsd)}.`,
      ),
    );
  }
  doc.push(
    paragraph(
      'Opened by Lockkeeper. The agent worked in a sealed sandbox with no write access; Lockkeeper checked the diff and created this commit. Lockkeeper never merges.',
    ),
  );
  return doc;
}

// ---------------------------------------------------------------------------
// Replies on the pull request (F1). Reviewers stay in GitHub, so follow-ups answer there.

export type FollowUpKind = 'review' | 'ci';

/** Whose feedback a follow-up answers, in words: "the review by alice and bob". */
function feedbackFrom(kind: FollowUpKind, authors: readonly string[], checks: readonly string[]) {
  if (kind === 'ci') {
    const names = checks.slice(0, 5).join(', ');
    return `the failed CI checks${names ? ` (${names}${checks.length > 5 ? ', …' : ''})` : ''}`;
  }
  const people = authors.length === 0 ? 'a reviewer' : authors.slice(0, 5).join(', ');
  return `the feedback from ${people}`;
}

function followUpHeader(round: number, rounds: number, kind: FollowUpKind): Doc[number] {
  const what = kind === 'ci' ? 'CI fix' : 'follow-up';
  return paragraph(bold('Lockkeeper'), ` · ${what} ${round} of ${rounds}`);
}

export interface FollowUpReply {
  kind: FollowUpKind;
  round: number;
  rounds: number;
  /** GitHub logins whose feedback this answers. */
  authors: string[];
  /** CI follow-ups: the checks that failed. */
  checks?: string[];
}

export function followUpReplyDoc(
  ctx: RunContext,
  reply: FollowUpReply & {
    commit: { sha: string; url: string };
    summary: string;
    verify: CheckResult[];
    draftReasons: string[];
    costUsd: number | undefined;
    durationMs: number;
    fixRounds: number;
  },
): Doc {
  const doc: Doc = [
    followUpHeader(reply.round, reply.rounds, reply.kind),
    paragraph(
      text('Pushed '),
      link(reply.commit.sha.slice(0, 7), reply.commit.url),
      text(` for ${feedbackFrom(reply.kind, reply.authors, reply.checks ?? [])}.`),
    ),
  ];
  if (reply.summary) doc.push(paragraph(reply.summary));
  doc.push(paragraph(...checksLine(reply.verify)));
  if (reply.draftReasons.length > 0) {
    doc.push(paragraph(bold('Kept as a draft because')));
    doc.push(bullets(...reply.draftReasons));
  }
  doc.push(paragraph(runLine(ctx, reply)));
  return doc;
}

export function followUpNoChangesDoc(
  ctx: RunContext,
  reply: FollowUpReply & {
    message: string;
    costUsd: number | undefined;
    durationMs: number;
    fixRounds: number;
  },
): Doc {
  const doc: Doc = [
    followUpHeader(reply.round, reply.rounds, reply.kind),
    paragraph(
      `No code change for ${feedbackFrom(reply.kind, reply.authors, reply.checks ?? [])}.${reply.message ? ' The agent said:' : ''}`,
    ),
  ];
  if (reply.message) doc.push(paragraph(reply.message));
  doc.push(paragraph(runLine(ctx, reply)));
  return doc;
}

export function followUpFailedDoc(
  ctx: RunContext,
  reply: FollowUpReply & { reason: string; cancelled: boolean },
): Doc {
  return [
    followUpHeader(reply.round, reply.rounds, reply.kind),
    paragraph(
      `The ${reply.kind === 'ci' ? 'CI fix' : 'follow-up'} for ${feedbackFrom(reply.kind, reply.authors, reply.checks ?? [])} ${reply.cancelled ? 'was stopped' : 'stopped'}: ${reply.reason} Nothing was pushed.`,
    ),
    paragraph(`Run ${ctx.runId}`),
  ];
}

/** Said once when feedback arrives after the follow-up rounds are used up. */
export function roundsUsedDoc(input: { kind: FollowUpKind; rounds: number }): Doc {
  const what =
    input.kind === 'ci'
      ? `CI still fails, and Lockkeeper already made ${input.rounds} CI fix ${input.rounds === 1 ? 'round' : 'rounds'} on this pull request, the limit (ci.fix_rounds in lockkeeper.yml). The checks need a person.`
      : `Lockkeeper already made ${input.rounds} follow-up ${input.rounds === 1 ? 'round' : 'rounds'} on this pull request, the limit (review.rounds in lockkeeper.yml). Push the change yourself, or raise the limit.`;
  return [paragraph(bold('Lockkeeper'), ' · no follow-up'), paragraph(what)];
}

export function capPullRequestBody(markdown: string): string {
  return markdown.length <= MAX_PR_BODY
    ? markdown
    : `${markdown.slice(0, MAX_PR_BODY)}\n\n[… cut by Lockkeeper]\n`;
}

/** Clean agent text once, with the findings kept for the audit log. */
export function cleanAgentText(value: string, maxLength: number): string {
  return sanitizeAgentText(value, maxLength).text;
}
