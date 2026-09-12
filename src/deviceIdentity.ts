/** Firebase can contain a literal null key; it does not identify a lamp. */
export function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/^(null|undefined)$/i.test(value.trim());
}
