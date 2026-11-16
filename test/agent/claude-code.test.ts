import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter, summarizeToolInput } from '../../src/agent/claude-code.js';

const adapter = new ClaudeCodeAdapter();

const invocation = {
  workdir: '/home/user/repo',
  promptFile: '/home/user/.lockkeeper/agent-0/prompt.md',
  systemPromptFile: '/home/user/.lockkeeper/agent-0/system.md',
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  resume: false,
  maxTurns: 150,
  maxBudgetUsd: 10,
};

describe('the Claude Code adapter', () => {
  it('builds a headless command that ignores repository hooks, settings and MCP servers', () => {
    const command = adapter.command(invocation);
    for (const part of [
      'claude -p --bare',
      '--output-format stream-json --verbose',
      '--permission-mode bypassPermissions',
      '--setting-sources user',
      '--strict-mcp-config',
      `--settings '{"disableAllHooks":true}'`,
      '--max-turns 150',
      '--max-budget-usd 10.00',
      '--session-id 550e8400-e29b-41d4-a716-446655440000',
      '--append-system-prompt-file /home/user/.lockkeeper/agent-0/system.md',
      '--disallowedTools WebFetch WebSearch',
    ]) {
      expect(command).toContain(part);
    }
    expect(command.endsWith('< /home/user/.lockkeeper/agent-0/prompt.md')).toBe(true);
  });

  it('resumes a session and passes a model when asked', () => {
    const command = adapter.command({
      ...invocation,
      resume: true,
      model: 'claude-opus-5-5',
      maxBudgetUsd: 3.456,
    });
    expect(command).toContain('--resume 550e8400-e29b-41d4-a716-446655440000');
    expect(command).not.toContain('--session-id');
    expect(command).toContain('--model claude-opus-5-5');
    expect(command).toContain('--max-budget-usd 3.46');
  });

  it('keeps the key out of subprocesses and trusts the egress proxy CA', () => {
    expect(adapter.environment()).toMatchObject({
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      DISABLE_AUTOUPDATER: '1',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/certs/ca-certificates.crt',
    });
    expect(adapter.credential).toEqual({
      env: 'ANTHROPIC_API_KEY',
      host: 'api.anthropic.com',
      header: 'x-api-key',
    });
  });

  it('parses the stream-json events into common events', () => {
    const lines = [
      {
        type: 'system',
        subtype: 'init',
        session_id: 's1',
        model: 'claude-opus-5-5',
        claude_code_version: '2.1.325',
        tools: ['Bash', 'Edit'],
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Looking.' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true }] },
      },
      { type: 'system', subtype: 'api_retry', attempt: 2, error_status: 529 },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Done.',
        total_cost_usd: 1.94,
        num_turns: 12,
        session_id: 's1',
      },
    ];
    const events = lines.flatMap((line) => adapter.parseLine(JSON.stringify(line)));
    expect(events).toEqual([
      {
        type: 'session',
        sessionId: 's1',
        model: 'claude-opus-5-5',
        version: '2.1.325',
        tools: ['Bash', 'Edit'],
      },
      { type: 'message', text: 'Looking.' },
      { type: 'tool_call', id: 't1', tool: 'Bash', summary: 'npm test' },
      { type: 'tool_result', id: 't1', isError: true },
      { type: 'retry', attempt: 2, error: '529' },
      {
        type: 'result',
        ok: true,
        outcome: 'success',
        text: 'Done.',
        costUsd: 1.94,
        turns: 12,
        sessionId: 's1',
      },
    ]);
  });

  it('names the cap when the agent stops at one', () => {
    const [turns] = adapter.parseLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        errors: ['max'],
      }),
    );
    const [budget] = adapter.parseLine(
      JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true }),
    );
    expect(turns).toMatchObject({ ok: false, cap: 'turns', errors: ['max'] });
    expect(budget).toMatchObject({ ok: false, cap: 'cost' });
  });

  it('tolerates noise', () => {
    expect(adapter.parseLine('')).toEqual([]);
    expect(adapter.parseLine('not json')).toEqual([{ type: 'unparsed', line: 'not json' }]);
    expect(adapter.parseLine(JSON.stringify({ type: 'stream_event' }))).toEqual([]);
  });

  it('summarises tool input briefly', () => {
    expect(summarizeToolInput('Edit', { file_path: 'src/a.ts', old_string: 'x' })).toBe('src/a.ts');
    expect(summarizeToolInput('Bash', { command: `echo ${'x'.repeat(400)}` })).toHaveLength(300);
  });
});
