export function resolveServerHost(value: string | undefined = process.env.SERVER_HOST): string {
  const host = value?.trim();
  return host || '127.0.0.1';
}
