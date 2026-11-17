#!/usr/bin/env node
// TEST ONLY: stands in for the `codex` and `opencode` CLIs inside the local test
// sandbox, the way fake-claude.mjs stands in for `claude`. It follows the same script
// ($FAKE_AGENT_SCRIPT, one entry per invocation), writes files in the working directory,
// prints the CLI's own JSON event format, and records what it was given.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const cli = basename(process.argv[2] ?? '');
const args = process.argv.slice(3);
if (args[0] === '--version') {
  process.stdout.write(`0.0.0 (fake ${cli})\n`);
  process.exit(0);
}

const home = process.env.HOME;
const prompt = readFileSync(0, 'utf8');
const behaviour = JSON.parse(readFileSync(process.env.FAKE_AGENT_SCRIPT, 'utf8'));
const counterFile = join(home, '.fake-agent-round');
const round = existsSync(counterFile) ? Number(readFileSync(counterFile, 'utf8')) : 0;
writeFileSync(counterFile, String(round + 1));
const step = behaviour.rounds[Math.min(round, behaviour.rounds.length - 1)];
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

// The session to continue, or a new one the CLI names itself.
const resumed =
  cli === 'codex'
    ? args.includes('resume')
      ? args[args.indexOf('resume') + 1]
      : undefined
    : flag('--session');
const sessionId =
  resumed ??
  (cli === 'codex'
    ? `thread-${randomBytes(4).toString('hex')}`
    : `ses_${randomBytes(4).toString('hex')}`);

writeFileSync(
  join(home, `.fake-agent-call-${round}.json`),
  JSON.stringify({
    cli,
    args,
    prompt,
    cwd: process.cwd(),
    sessionId,
    resumed: resumed ?? null,
    permission: process.env.OPENCODE_PERMISSION ?? null,
    projectConfigOff: process.env.OPENCODE_DISABLE_PROJECT_CONFIG ?? null,
    credentialEnv: Object.keys(process.env)
      .filter((name) => /KEY|TOKEN|SECRET|PASSWORD|LOCKKEEPER|AUTH/i.test(name))
      .sort(),
  }),
);

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const files = Object.entries(step.writes ?? {});
const text = step.text ?? 'Done.';
const failed = (step.subtype ?? 'success') !== 'success';
const costUsd = step.costUsd ?? 0.1;

if (cli === 'codex') {
  emit({ type: 'thread.started', thread_id: sessionId });
  emit({ type: 'turn.started' });
  for (const [index, command] of (step.commands ?? []).entries()) {
    const item = {
      id: `cmd_${index}`,
      type: 'command_execution',
      command,
      aggregated_output: '',
      exit_code: null,
      status: 'in_progress',
    };
    emit({ type: 'item.started', item });
    emit({ type: 'item.completed', item: { ...item, exit_code: 1, status: 'failed' } });
  }
  for (const [file, content] of files) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    emit({
      type: 'item.completed',
      item: {
        id: `patch_${file}`,
        type: 'file_change',
        changes: [{ path: file, kind: 'add' }],
        status: 'completed',
      },
    });
  }
  if (step.sleepMs) await new Promise((resolve) => setTimeout(resolve, step.sleepMs));
  emit({ type: 'item.completed', item: { id: 'msg_1', type: 'agent_message', text } });
  if (failed) emit({ type: 'turn.failed', error: { message: `fake ${step.subtype}` } });
  else
    emit({
      type: 'turn.completed',
      usage: {
        input_tokens: 120_000,
        cached_input_tokens: 20_000,
        output_tokens: 5_000,
        reasoning_output_tokens: 0,
      },
    });
  process.exit(step.exitCode ?? (failed ? 1 : 0));
}

// opencode
const base = { timestamp: Date.now(), sessionID: sessionId };
emit({ ...base, type: 'step_start', part: { type: 'step-start' } });
for (const [file, content] of files) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  emit({
    ...base,
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'write',
      callID: `call_${file}`,
      state: { status: 'completed', input: { filePath: file } },
    },
  });
}
for (const [index, command] of (step.commands ?? []).entries()) {
  emit({
    ...base,
    type: 'tool_use',
    part: {
      type: 'tool',
      tool: 'bash',
      callID: `bash_${index}`,
      state: { status: 'error', input: { command } },
    },
  });
}
emit({
  ...base,
  type: 'step_finish',
  part: {
    type: 'step-finish',
    reason: 'tool-calls',
    cost: costUsd,
    tokens: { input: 1000, output: 100 },
  },
});
if (step.sleepMs) await new Promise((resolve) => setTimeout(resolve, step.sleepMs));
emit({ ...base, type: 'text', part: { type: 'text', text, time: { start: 1, end: 2 } } });
emit({
  ...base,
  type: 'step_finish',
  part: { type: 'step-finish', reason: 'stop', cost: 0, tokens: { input: 10, output: 10 } },
});
if (failed)
  emit({
    ...base,
    type: 'error',
    error: { name: 'APIError', data: { message: `fake ${step.subtype}` } },
  });
process.exit(step.exitCode ?? (failed ? 1 : 0));
