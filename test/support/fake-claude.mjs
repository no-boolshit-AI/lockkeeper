#!/usr/bin/env node
// TEST ONLY: stands in for the `claude` CLI inside the local test sandbox.
// It follows the script in $FAKE_AGENT_SCRIPT, one entry per invocation, writes files
// in the working directory, prints Claude Code stream-json events, and records what it
// was given (arguments, prompt, system prompt, credential-like env names) for assertions.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('0.0.0 (fake Claude Code)\n');
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
const sessionId = flag('--resume') ?? flag('--session-id');

writeFileSync(
  join(home, `.fake-agent-call-${round}.json`),
  JSON.stringify({
    args,
    prompt,
    cwd: process.cwd(),
    systemPrompt: readFileSync(flag('--append-system-prompt-file'), 'utf8'),
    credentialEnv: Object.keys(process.env)
      .filter((name) => /KEY|TOKEN|SECRET|PASSWORD|LOCKKEEPER|AUTH/i.test(name))
      .sort(),
    anthropicKey: process.env.ANTHROPIC_API_KEY,
  }),
);

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({
  type: 'system',
  subtype: 'init',
  session_id: sessionId,
  model: 'fake-model',
  tools: ['Bash', 'Read', 'Edit'],
  claude_code_version: '0.0.0',
});

for (const [file, content] of Object.entries(step.writes ?? {})) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  emit({
    type: 'assistant',
    session_id: sessionId,
    message: {
      content: [
        { type: 'tool_use', id: `tool-${file}`, name: 'Write', input: { file_path: file } },
      ],
    },
  });
  emit({
    type: 'user',
    session_id: sessionId,
    message: { content: [{ type: 'tool_result', tool_use_id: `tool-${file}`, is_error: false }] },
  });
}
for (const file of step.deletes ?? []) rmSync(file, { force: true });
if (step.sleepMs) await new Promise((resolve) => setTimeout(resolve, step.sleepMs));

const text = step.text ?? 'Done.';
const subtype = step.subtype ?? 'success';
emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text }] } });
emit({
  type: 'result',
  subtype,
  is_error: subtype !== 'success',
  ...(subtype === 'success' ? { result: text } : { errors: [`fake ${subtype}`] }),
  total_cost_usd: step.costUsd ?? 0.25 * (round + 1),
  num_turns: 4,
  session_id: sessionId,
});
process.exit(step.exitCode ?? 0);
