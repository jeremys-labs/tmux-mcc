export interface RuntimeWritablePty {
  write(data: string): void;
}

export interface SubmitRuntimePromptOptions {
  clearDelayMs?: number;
  submitDelayMs?: number;
  chunkSize?: number;
  chunkDelayMs?: number;
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
  const chunkSize = options.chunkSize ?? 0;
  const chunkDelayMs = options.chunkDelayMs ?? 0;

  term.write('\x15');
  await delay(clearDelayMs);
  if (chunkSize > 0 && prompt.length > chunkSize) {
    for (let index = 0; index < prompt.length; index += chunkSize) {
      term.write(prompt.slice(index, index + chunkSize));
      if (chunkDelayMs > 0) await delay(chunkDelayMs);
    }
  } else {
    term.write(prompt);
  }
  await delay(submitDelayMs);
  term.write('\r');
}
