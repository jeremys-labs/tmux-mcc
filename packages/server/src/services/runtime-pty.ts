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
  // A prompt is pasted into a live TUI, not handed to an API. Writing it in one go and
  // waiting a flat 80ms before `\r` works for short prompts and silently truncates long
  // ones: the Enter lands while the terminal is still ingesting, so the tail is dropped
  // and the submit applies to an incomplete buffer. On 2026-09-13 that lost Discord
  // messages to Remy at promptLength 3365, 3397 and 5289 while 1680-1918 delivered
  // normally -- the wrapper logged `submitted` for all of them. The 250ms already
  // hardcoded at the handoff call site was this same bug, fixed for one caller.
  const clearDelayMs = options.clearDelayMs ?? 40;
  const chunkSize = options.chunkSize ?? 512;
  const chunkDelayMs = options.chunkDelayMs ?? 10;
  // Scale with size rather than pick a bigger constant: a constant is just a larger
  // prompt away from being wrong again.
  const submitDelayMs = options.submitDelayMs ?? Math.max(250, Math.ceil(prompt.length / 10));

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
