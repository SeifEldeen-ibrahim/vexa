/** One logger. Lines are prefixed per concern so a live meeting's trail is greppable. */
const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let threshold = LEVELS.info;

export function setLogLevel(level: string): void {
  threshold = LEVELS[(level || '').toLowerCase()] ?? LEVELS.info;
}

const emit = (level: keyof typeof LEVELS, scope: string, msg: string): void => {
  if ((LEVELS[level] ?? 9) > threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
};

export const log = {
  error: (scope: string, msg: string) => emit('error', scope, msg),
  warn: (scope: string, msg: string) => emit('warn', scope, msg),
  info: (scope: string, msg: string) => emit('info', scope, msg),
  debug: (scope: string, msg: string) => emit('debug', scope, msg),
};
