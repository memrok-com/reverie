export class ReverieError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReverieError';
    this.code = code;
  }
}

export function requireValue(condition, code, message) {
  if (!condition) throw new ReverieError(code, message);
}

export function identifier(value, label = 'Identity') {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 512,
    'INVALID_INPUT', `${label} must be a nonempty string of at most 512 characters.`);
  return value;
}
