import { styleText } from 'node:util';

export interface Logger {
  step(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export function consoleLogger(
  options: { verbose?: boolean; stream?: NodeJS.WritableStream } = {},
): Logger {
  const stream = options.stream ?? process.stderr;
  const colors = 'isTTY' in stream && Boolean((stream as NodeJS.WriteStream).isTTY);
  const paint = (format: Parameters<typeof styleText>[0], text: string) =>
    colors ? styleText(format, text) : text;
  const write = (line: string) => stream.write(`${line}\n`);
  return {
    step: (message) => write(`${paint('cyan', '›')} ${message}`),
    info: (message) => write(`  ${message}`),
    warn: (message) => write(`${paint('yellow', '!')} ${message}`),
    error: (message) => write(`${paint('red', '✗')} ${message}`),
    debug: (message) => {
      if (options.verbose) write(paint('gray', `  ${message}`));
    },
  };
}

/** Prefix every line, such as with a ticket key when several runs share one terminal. */
export function prefixedLogger(log: Logger, prefix: string): Logger {
  return {
    step: (message) => log.step(`${prefix} ${message}`),
    info: (message) => log.info(`${prefix} ${message}`),
    warn: (message) => log.warn(`${prefix} ${message}`),
    error: (message) => log.error(`${prefix} ${message}`),
    debug: (message) => log.debug(`${prefix} ${message}`),
  };
}

export const silentLogger: Logger = {
  step: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
