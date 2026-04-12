import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('loads a valid config.yaml', () => {
    const yaml = `
branding:
  name: Test Office
  shortName: TO
gateway:
  url: http://localhost:18789
  token: test-token
agents:
  alice:
    name: Alice
    role: Tester
    emoji: "🧪"
    color:
      from: "#ff0000"
      to: "#00ff00"
    channel: "#test"
    greeting: Hello
    position:
      zone: desk
      x: 1
      y: 1
    tabs: []
`;
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), yaml);
    const config = loadConfig(tmpDir);
    expect(config.branding.name).toBe('Test Office');
    expect(config.agents.alice.name).toBe('Alice');
    expect(config.gateway.token).toBe('test-token');
  });

  it('throws if config.yaml is missing', () => {
    expect(() => loadConfig(tmpDir)).toThrow(/config\.yaml not found/);
  });

  it('throws if agents section is missing', () => {
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), 'branding:\n  name: X\n');
    expect(() => loadConfig(tmpDir)).toThrow(/agents/);
  });

  it('parses agent avatar block when present', () => {
    const yaml = `
branding:
  name: Test Office
  shortName: TO
gateway:
  url: http://localhost:18789
  token: test-token
agents:
  bob:
    name: Bob
    role: Dev Manager
    emoji: "🔧"
    color:
      from: "#0000ff"
      to: "#0000aa"
    channel: "#dev"
    greeting: Hey
    position:
      zone: desk
      x: 2
      y: 2
    tabs: []
    avatar:
      hair: [short05]
      beard: [variant02]
      beardProbability: 100
`;
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), yaml);
    const config = loadConfig(tmpDir);
    expect(config.agents.bob.avatar?.hair).toEqual(['short05']);
    expect(config.agents.bob.avatar?.beard).toEqual(['variant02']);
    expect(config.agents.bob.avatar?.beardProbability).toBe(100);
  });

  it('agent avatar block is optional', () => {
    const yaml = `
branding:
  name: Test Office
  shortName: TO
gateway:
  url: http://localhost:18789
  token: test-token
agents:
  alice:
    name: Alice
    role: Tester
    emoji: "🧪"
    color:
      from: "#ff0000"
      to: "#00ff00"
    channel: "#test"
    greeting: Hello
    position:
      zone: desk
      x: 1
      y: 1
    tabs: []
`;
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), yaml);
    const config = loadConfig(tmpDir);
    expect(config.agents.alice.avatar).toBeUndefined();
  });
});
