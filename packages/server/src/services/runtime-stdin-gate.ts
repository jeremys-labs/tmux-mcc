/**
 * Serializes user stdin passthrough against injected prompt sequences.
 *
 * An injection is a multi-write sequence (`\x15` → text → `\r`). If a forwarded keystroke lands
 * in the middle of one, it interleaves into the same input line and garbles it. This gate buffers
 * user input for the duration of an injection and flushes it once the (outermost) injection
 * completes, so the injected sequence stays contiguous.
 */
export interface StdinGate {
  /** Forward a chunk of user input, buffering it if an injection is in flight. */
  passthrough(data: string): void;
  /** Run an injection sequence with stdin passthrough suppressed. Buffered input flushes after. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createStdinGate(write: (data: string) => void): StdinGate {
  let active = 0;
  const buffer: string[] = [];

  return {
    passthrough(data) {
      if (active > 0) {
        buffer.push(data);
        return;
      }
      write(data);
    },
    async run(fn) {
      active += 1;
      try {
        return await fn();
      } finally {
        active -= 1;
        if (active === 0 && buffer.length > 0) {
          const pending = buffer.join('');
          buffer.length = 0;
          write(pending);
        }
      }
    },
  };
}
