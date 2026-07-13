// Codex boot hardening: headless codex sessions wedge on the interactive
// "update available" dialog unless `check_for_update_on_startup = false` is
// set at the ROOT of CODEX_HOME/config.toml (7/9–7/12 incidents: blocked
// auto-heal respawns, burned the crash cap, needed manual keys every boot).
//
// Scope-awareness matters: a key written below a `[table]` header belongs to
// that table, not the root — the exact bug that broke cecelia's model config
// on 7/8 ("Model metadata for cecelia not found"). The check only trusts the
// root section, and the injector inserts before the first table header.

import fs from 'fs';
import path from 'path';

export type UpdateGuardStatus =
  | 'ok'                 // key present at root scope, set to false
  | 'missing'            // key absent from root scope (may exist mis-scoped under a table)
  | 'explicitly-enabled' // key present at root scope, set to true — respect it, warn
  | 'no-config';         // config.toml does not exist

const KEY_LINE = /^\s*check_for_update_on_startup\s*=\s*(true|false)\s*(#.*)?$/;
const TABLE_HEADER = /^\s*\[/;
const GUARD_LINE = 'check_for_update_on_startup = false';

export function checkUpdateGuard(configText: string): Exclude<UpdateGuardStatus, 'no-config'> {
  for (const line of configText.split('\n')) {
    if (TABLE_HEADER.test(line)) break; // root scope ends at the first table header
    const match = KEY_LINE.exec(line);
    if (match) return match[1] === 'false' ? 'ok' : 'explicitly-enabled';
  }
  return 'missing';
}

// Insert the guard line into root scope: before the first table header, or
// appended if the file has no tables. Never appends blindly at EOF when
// tables exist — that would scope the key into the last table.
export function injectUpdateGuard(configText: string): string {
  const lines = configText.split('\n');
  const firstTable = lines.findIndex((line) => TABLE_HEADER.test(line));
  if (firstTable === -1) {
    const body = configText.endsWith('\n') || configText === '' ? configText : `${configText}\n`;
    return `${body}${GUARD_LINE}\n`;
  }
  lines.splice(firstTable, 0, GUARD_LINE, '');
  return lines.join('\n');
}

export function ensureCodexUpdateGuard(codexHome: string): { status: UpdateGuardStatus; patched: boolean } {
  const configPath = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(configPath)) {
    return { status: 'no-config', patched: false };
  }
  const text = fs.readFileSync(configPath, 'utf8');
  const status = checkUpdateGuard(text);
  if (status !== 'missing') {
    return { status, patched: false };
  }
  fs.writeFileSync(configPath, injectUpdateGuard(text));
  return { status, patched: true };
}
