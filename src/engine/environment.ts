import { shellQuote } from '../sandbox/sandbox.js';
import type { DetectedCommands } from './detect.js';

/**
 * Where setup and verify commands come from (E6), in order: lockkeeper.yml, then the
 * dev container, then AGENTS.md, then detection from the repository's files. Setup and
 * verify are resolved separately: each takes the first source that has any.
 *
 * The dev container and AGENTS.md are read from the base commit. Their commands run
 * inside the sandbox, as the agent's own commands do, so reading them grants nothing.
 */

export type CommandSource = 'lockkeeper.yml' | 'devcontainer' | 'AGENTS.md' | 'detected';

export interface ResolvedCommands {
  setup: string[];
  verify: string[];
  sources: { setup: CommandSource; verify: CommandSource };
}

export function resolveCommands(input: {
  configured: { setup: string[] | undefined; verify: string[] | undefined };
  devcontainer?: string | undefined;
  agentsMd?: string | undefined;
  detected: DetectedCommands;
}): ResolvedCommands {
  const fromContainer = input.devcontainer ? devcontainerSetup(input.devcontainer) : [];
  const fromAgents = input.agentsMd ? agentsMdCommands(input.agentsMd) : { setup: [], verify: [] };

  let setup: [string[], CommandSource];
  if (input.configured.setup !== undefined) setup = [input.configured.setup, 'lockkeeper.yml'];
  else if (fromContainer.length > 0) setup = [fromContainer, 'devcontainer'];
  else if (fromAgents.setup.length > 0) setup = [fromAgents.setup, 'AGENTS.md'];
  else setup = [input.detected.setup, 'detected'];

  // A dev container says how to build the environment, not how to test it.
  let verify: [string[], CommandSource];
  if (input.configured.verify !== undefined) verify = [input.configured.verify, 'lockkeeper.yml'];
  else if (fromAgents.verify.length > 0) verify = [fromAgents.verify, 'AGENTS.md'];
  else verify = [input.detected.verify, 'detected'];

  return {
    setup: setup[0],
    verify: verify[0],
    sources: { setup: setup[1], verify: verify[1] },
  };
}

// ---------------------------------------------------------------------------
// Dev containers

/** JSON with comments and trailing commas, as devcontainer.json allows. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string;
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      out += '\n';
    } else if (char === '/' && next === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index++;
    } else {
      out += char;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** One lifecycle command: a shell string, an exec-form array, or named parallel commands. */
function lifecycleCommands(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === 'string');
    return parts.length > 0 ? [parts.map(shellQuote).join(' ')] : [];
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(lifecycleCommands);
  }
  return [];
}

/**
 * Setup from a dev container: the commands that run once when it is created, in the
 * spec's order. Commands for starting or attaching, and anything run on the host, are
 * left out.
 */
export function devcontainerSetup(content: string): string[] {
  let config: unknown;
  try {
    config = parseJsonc(content);
  } catch {
    return [];
  }
  if (!config || typeof config !== 'object') return [];
  const record = config as Record<string, unknown>;
  return ['onCreateCommand', 'updateContentCommand', 'postCreateCommand'].flatMap((key) =>
    lifecycleCommands(record[key]),
  );
}

// ---------------------------------------------------------------------------
// AGENTS.md

const SETUP_COMMAND =
  /^(?:npm (?:ci|install|i)\b|pnpm (?:install|i)\b|yarn(?: install)?(?:\s|$)|bun install\b|corepack enable\b|pip3? install\b|python3? -m (?:pip install|venv)\b|poetry install\b|uv sync\b|pipenv install\b|bundle install\b|go mod download\b|cargo fetch\b|composer install\b|make (?:setup|install|deps|bootstrap)\b)/;
const VERIFY_COMMAND =
  /^(?:(?:npm|pnpm|yarn|bun) (?:run )?(?:test|lint|check|typecheck|type-check|format:check)\b|npx (?:vitest|jest|eslint|tsc|biome)\b|(?:uv run |poetry run |python3? -m )?(?:pytest|ruff|mypy|flake8)\b|go (?:test|vet)\b|cargo (?:test|clippy|check)\b|bundle exec (?:rspec|rake test|rubocop)\b|rspec\b|phpunit\b|vendor\/bin\/phpunit\b|make (?:test|lint|check)\b|\.\/gradlew (?:test|check)\b|mvn (?:-q )?(?:test|verify)\b)/;
/** Commands that start servers, watch files or publish: never part of setup or checks. */
const EXCLUDED =
  /\b(?:dev|start|serve|watch|deploy|publish|release)\b|--watch\b|\bsudo\b|\brm -rf\b/;
const MAX_COMMANDS = 5;

function candidates(content: string): string[] {
  const found: string[] = [];
  const lines = content.split(/\r?\n/);
  let fence: string | undefined;
  let shellFence = false;
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
    if (fenceMatch) {
      if (fence === undefined) {
        fence = fenceMatch[1];
        const language = (fenceMatch[2] ?? '').toLowerCase();
        shellFence = ['', 'sh', 'bash', 'shell', 'console', 'zsh'].includes(language);
      } else if (fenceMatch[1]?.startsWith(fence.slice(0, 3))) {
        fence = undefined;
      }
      continue;
    }
    if (fence !== undefined) {
      if (shellFence) found.push(line.trim().replace(/^\$\s+/, ''));
      continue;
    }
    for (const span of line.matchAll(/`([^`\n]+)`/g)) found.push((span[1] ?? '').trim());
  }
  return found.filter(Boolean);
}

/** Setup and check commands named in AGENTS.md, recognised by what they run. */
export function agentsMdCommands(content: string): { setup: string[]; verify: string[] } {
  const setup: string[] = [];
  const verify: string[] = [];
  for (const command of candidates(content)) {
    if (EXCLUDED.test(command)) continue;
    if (SETUP_COMMAND.test(command)) {
      if (!setup.includes(command) && setup.length < MAX_COMMANDS) setup.push(command);
    } else if (VERIFY_COMMAND.test(command)) {
      if (!verify.includes(command) && verify.length < MAX_COMMANDS) verify.push(command);
    }
  }
  return { setup, verify };
}
