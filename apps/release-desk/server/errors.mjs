export class DeskError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = code; this.status = status; }
}
export function ensure(condition, code, message, status = 409) { if (!condition) throw new DeskError(code, message, status); }
export const isSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const nowIso = () => new Date().toISOString();
export function safeError(error) { return error instanceof DeskError ? error.message : 'An upstream operation failed. Retry or inspect the server audit log.'; }
