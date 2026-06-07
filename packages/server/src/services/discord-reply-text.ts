export function normalizeInlineDiscordText(text: string): string {
  return text
    .replaceAll('\\r\\n', '\n')
    .replaceAll('\\n', '\n');
}
