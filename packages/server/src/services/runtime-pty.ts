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

const DEFAULT_CHUNK_SIZE = 512;
const SHORT_PROMPT_SUBMIT_DELAY_MS = 80;
const LARGE_PROMPT_MIN_SUBMIT_DELAY_MS = 250;
const LARGE_PROMPT_MAX_SUBMIT_DELAY_MS = 1_000;

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
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkDelayMs = options.chunkDelayMs ?? 10;
  // Preserve the old 80ms latency for short prompts. Large prompts scale to cover
  // terminal ingest, with a cap so an anomalous answer-context cannot hold stdinGate
  // for an unbounded pre-submit delay.
  const defaultSubmitDelayMs = prompt.length <= DEFAULT_CHUNK_SIZE
    ? SHORT_PROMPT_SUBMIT_DELAY_MS
    : Math.min(
      LARGE_PROMPT_MAX_SUBMIT_DELAY_MS,
      Math.max(LARGE_PROMPT_MIN_SUBMIT_DELAY_MS, Math.ceil(prompt.length / 10)),
    );
  const submitDelayMs = options.submitDelayMs ?? defaultSubmitDelayMs;

  term.write('\x15');
  await delay(clearDelayMs);
  if (chunkSize > 0 && prompt.length > chunkSize) {
    for (let index = 0; index < prompt.length;) {
      let end = Math.min(index + chunkSize, prompt.length);
      const splitsSurrogatePair =
        end < prompt.length &&
        prompt.charCodeAt(end - 1) >= 0xd800 &&
        prompt.charCodeAt(end - 1) <= 0xdbff &&
        prompt.charCodeAt(end) >= 0xdc00 &&
        prompt.charCodeAt(end) <= 0xdfff;
      if (splitsSurrogatePair) {
        // Keep each PTY write valid UTF-16. For chunkSize=1 the pair cannot fit
        // by moving the boundary backward, so let this chunk exceed the target.
        end = end - index === 1 ? end + 1 : end - 1;
      }
      term.write(prompt.slice(index, end));
      index = end;
      if (chunkDelayMs > 0) await delay(chunkDelayMs);
    }
  } else {
    term.write(prompt);
  }
  await delay(submitDelayMs);
  term.write('\r');
}
