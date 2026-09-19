import { createRequire } from 'node:module';
import type * as Headless from '@xterm/headless';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless') as typeof Headless;

export interface RuntimeTerminalScreenOptions {
  cols: number;
  rows: number;
  scrollback?: number;
}

export interface RuntimeTerminalViewport {
  cols: number;
  rows: number;
  baseY: number;
  viewportY: number;
  cursorX: number;
  cursorY: number;
  lines: string[];
}

export interface RuntimeTerminalScreen {
  write(data: string | Uint8Array): Promise<RuntimeTerminalViewport>;
  resize(cols: number, rows: number): void;
  snapshot(): RuntimeTerminalViewport;
  dispose(): void;
}

export function createRuntimeTerminalScreen(options: RuntimeTerminalScreenOptions): RuntimeTerminalScreen {
  const terminal = new Terminal({
    cols: options.cols,
    rows: options.rows,
    scrollback: options.scrollback ?? 1_000,
    // The rendered buffer is a proposed xterm API. Pinning the package version and
    // freezing its output against a golden fixture makes that instability explicit.
    allowProposedApi: true,
  });

  const snapshot = (): RuntimeTerminalViewport => {
    const buffer = terminal.buffer.active;
    const lines = Array.from({ length: terminal.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(false) ?? ''.padEnd(terminal.cols),
    );
    return {
      cols: terminal.cols,
      rows: terminal.rows,
      baseY: buffer.baseY,
      viewportY: buffer.viewportY,
      cursorX: buffer.cursorX,
      cursorY: buffer.cursorY,
      lines,
    };
  };

  return {
    write(data) {
      return new Promise((resolve, reject) => {
        terminal.write(data, () => {
          try {
            resolve(snapshot());
          } catch (error) {
            reject(error);
          }
        });
      });
    },
    resize(cols, rows) {
      terminal.resize(cols, rows);
    },
    snapshot,
    dispose() {
      terminal.dispose();
    },
  };
}
