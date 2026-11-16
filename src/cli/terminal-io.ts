import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { InitIo } from './init.js';

/** Questions in the terminal. Each question gets its own readline, so secrets can mute it. */
export function terminalIo(): InitIo {
  const ask = async (question: string, output: NodeJS.WritableStream): Promise<string> => {
    const reader = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY });
    try {
      return await reader.question(output === process.stdout ? question : '');
    } finally {
      reader.close();
    }
  };
  return {
    async ask(question, fallback) {
      const answer = await ask(`${question}${fallback ? ` [${fallback}]` : ''}: `, process.stdout);
      return answer.trim() || fallback || '';
    },
    async secret(question) {
      process.stdout.write(`${question} (hidden): `);
      // Readline echoes typing to its output; a sink keeps the secret off the screen.
      const sink = new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
      const answer = await ask('', sink);
      process.stdout.write('\n');
      return answer;
    },
    say: (line) => {
      process.stdout.write(`${line}\n`);
    },
    open(url) {
      const [command, args] =
        process.platform === 'darwin'
          ? ['open', [url]]
          : process.platform === 'win32'
            ? ['cmd', ['/c', 'start', '', url]]
            : ['xdg-open', [url]];
      try {
        spawn(command as string, args as string[], { stdio: 'ignore', detached: true })
          .on('error', () => {})
          .unref();
      } catch {
        // The URL is printed too.
      }
    },
  };
}
