/**
 * Imported first by the CLI entry point: Node 22 prints an ExperimentalWarning when
 * node:sqlite loads, which would confuse people on every command. Other warnings pass.
 */
const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  const first = rest[0];
  const type =
    typeof first === 'string'
      ? first
      : ((first as { type?: string } | undefined)?.type ?? (warning as Error).name);
  if (type === 'ExperimentalWarning' && /sqlite/i.test(message)) return;
  return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
