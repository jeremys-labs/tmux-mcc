export interface RuntimeWrapperArgs {
  agentKey: string;
  cwd: string;
  runtimeArgs: string[];
}

export interface ParseRuntimeWrapperArgsOptions {
  defaultCwd?: string;
  forwardAfterDoubleDash?: boolean;
}

export function parseRuntimeWrapperArgs(
  argv: string[],
  options: ParseRuntimeWrapperArgsOptions = {},
): RuntimeWrapperArgs {
  const args = [...argv];
  let agentKey = '';
  let cwd = options.defaultCwd ?? process.cwd();
  const runtimeArgs: string[] = [];
  let forwarding = false;

  while (args.length > 0) {
    const current = args.shift()!;
    if (options.forwardAfterDoubleDash && current === '--') {
      forwarding = true;
      continue;
    }
    if (forwarding) {
      runtimeArgs.push(current);
      continue;
    }
    if (current === '--agent') {
      agentKey = args.shift() ?? '';
      continue;
    }
    if (current === '--cd') {
      cwd = args.shift() ?? cwd;
      continue;
    }
    runtimeArgs.push(current);
  }

  if (!agentKey) {
    throw new Error('Missing required --agent <agentKey>');
  }

  return { agentKey, cwd, runtimeArgs };
}
