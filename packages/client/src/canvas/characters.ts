import { Container, Text, TextStyle } from 'pixi.js';

export function drawNameLabel(parent: Container, name: string, y: number): void {
  const style = new TextStyle({
    fontSize: 11,
    fill: 0xd0d0e0,
    fontFamily: 'monospace',
    dropShadow: {
      color: 0x000000,
      alpha: 0.7,
      blur: 2,
      distance: 1,
    },
  });
  const text = new Text({
    text: name,
    style,
    resolution: 2,
  });
  text.anchor.set(0.5, 0);
  text.y = y;
  parent.addChild(text);
}
