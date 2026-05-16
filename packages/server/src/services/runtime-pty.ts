export interface RuntimeWritablePty {
  write(data: string): void;
}

export interface SubmitRuntimePromptOptions {
  clearDelayMs?: number;
  submitDelayMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function submitRuntimePrompt(
  term: RuntimeWritablePty,
  prompt: string,
  options: SubmitRuntimePromptOptions = {},
): Promise<void> {
  const clearDelayMs = options.clearDelayMs ?? 40;
  const submitDelayMs = options.submitDelayMs ?? 80;

  term.write('\x15');
  await delay(clearDelayMs);
  term.write(prompt);
  await delay(submitDelayMs);
  term.write('\r');
}
