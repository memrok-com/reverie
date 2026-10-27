export class ReverieError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ReverieError'; }
}
export function requireValue(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new ReverieError(code, message);
}
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function errorCode(error: unknown): string {
  return record(error) && typeof error.code === 'string' ? error.code : 'MEMORY_FAILURE';
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : record(error) && typeof error.message === 'string' ? error.message : 'Memory operation failed.';
}
export function identifier(value: unknown, label: string): string {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 512,
    'INVALID_INPUT', label + ' must be nonempty text of at most 512 characters.');
  return value;
}
