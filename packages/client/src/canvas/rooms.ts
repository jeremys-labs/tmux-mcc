import { Graphics } from 'pixi.js';
import { TILE_WIDTH, TILE_HEIGHT, isoToScreen } from './tiles';

export interface ZoneDef {
  id: string;
  label: string;
  originCol: number;
  originRow: number;
  cols: number;
  rows: number;
  floorA: number;
  floorB: number;
  walls: ('top' | 'left' | 'right' | 'bottom')[];
}

export const ZONES: ZoneDef[] = [
  {
    id: 'workspace',
    label: 'Workspace',
    originCol: 0,
    originRow: 0,
    cols: 16,
    rows: 7,
    floorA: 0x2a2a45,
    floorB: 0x252540,
    walls: ['top', 'left', 'right'],
  },
  {
    id: 'conference',
    label: 'Conference',
    originCol: 0,
    originRow: 7,
    cols: 5,
    rows: 5,
    floorA: 0x2d2d48,
    floorB: 0x282843,
    walls: ['left', 'bottom', 'right'],
  },
  {
    id: 'lounge',
    label: 'Lounge',
    originCol: 5,
    originRow: 7,
    cols: 6,
    rows: 5,
    floorA: 0x3a2e1e,
    floorB: 0x33281a,
    walls: ['bottom'],
  },
  {
    id: 'kitchen',
    label: 'Kitchen',
    originCol: 11,
    originRow: 7,
    cols: 5,
    rows: 5,
    floorA: 0x383848,
    floorB: 0x303040,
    walls: ['right', 'bottom'],
  },
];

const ZONE_MAP: Record<string, string> = {
  desk: 'workspace',
  workspace: 'workspace',
  conference: 'conference',
  lounge: 'lounge',
  kitchen: 'kitchen',
};

export function resolveZone(agentZone: string): string {
  return ZONE_MAP[agentZone] ?? 'workspace';
}

export function drawZoneFloor(g: Graphics, zone: ZoneDef): void {
  for (let r = 0; r < zone.rows; r++) {
    for (let c = 0; c < zone.cols; c++) {
      const col = zone.originCol + c;
      const row = zone.originRow + r;
      const { x, y } = isoToScreen(col, row);
      const color = (r + c) % 2 === 0 ? zone.floorA : zone.floorB;

      g.poly([
        { x, y },
        { x: x + TILE_WIDTH / 2, y: y + TILE_HEIGHT / 2 },
        { x, y: y + TILE_HEIGHT },
        { x: x - TILE_WIDTH / 2, y: y + TILE_HEIGHT / 2 },
      ]);
      g.fill(color);
      g.stroke({ width: 1, color: 0x3d3d5a, alpha: 0.3 });
    }
  }
}

const WALL_HEIGHT = 36;
const WALL_COLOR = 0x4a4a6a;
const WALL_TOP_COLOR = 0x5a5a7a;

function drawWallSegmentTop(
  g: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  // Wall face
  g.poly([
    { x: x1, y: y1 },
    { x: x2, y: y2 },
    { x: x2, y: y2 - WALL_HEIGHT },
    { x: x1, y: y1 - WALL_HEIGHT },
  ]);
  g.fill(WALL_COLOR);
  g.stroke({ width: 1, color: WALL_TOP_COLOR, alpha: 0.5 });

  // Wall top cap
  g.poly([
    { x: x1, y: y1 - WALL_HEIGHT },
    { x: x2, y: y2 - WALL_HEIGHT },
    { x: x2, y: y2 - WALL_HEIGHT },
    { x: x1, y: y1 - WALL_HEIGHT },
  ]);
  g.fill(WALL_TOP_COLOR);
}

function drawWallSegmentLeft(
  g: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): void {
  // Wall face
  g.poly([
    { x: x1, y: y1 },
    { x: x2, y: y2 },
    { x: x2, y: y2 - WALL_HEIGHT },
    { x: x1, y: y1 - WALL_HEIGHT },
  ]);
  g.fill(WALL_COLOR);
  g.stroke({ width: 1, color: WALL_TOP_COLOR, alpha: 0.5 });

  // Wall top cap
  g.poly([
    { x: x1, y: y1 - WALL_HEIGHT },
    { x: x2, y: y2 - WALL_HEIGHT },
    { x: x2, y: y2 - WALL_HEIGHT },
    { x: x1, y: y1 - WALL_HEIGHT },
  ]);
  g.fill(WALL_TOP_COLOR);
}

export function drawZoneWalls(g: Graphics, zone: ZoneDef): void {
  const { originCol, originRow, cols, rows } = zone;

  for (const side of zone.walls) {
    switch (side) {
      case 'top': {
        // Top edge: from top-left corner going right along the top
        for (let c = 0; c < cols; c++) {
          const col = originCol + c;
          const row = originRow;
          const from = isoToScreen(col, row);
          const to = isoToScreen(col + 1, row);
          drawWallSegmentTop(g, from.x, from.y, to.x, to.y);
        }
        break;
      }
      case 'left': {
        // Left edge: from top-left corner going down along the left
        for (let r = 0; r < rows; r++) {
          const col = originCol;
          const row = originRow + r;
          const from = isoToScreen(col, row);
          const to = isoToScreen(col, row + 1);
          drawWallSegmentLeft(g, from.x, from.y, to.x, to.y);
        }
        break;
      }
      case 'right': {
        // Right edge: from top-right corner going down along the right
        for (let r = 0; r < rows; r++) {
          const col = originCol + cols;
          const row = originRow + r;
          const from = isoToScreen(col, row);
          const to = isoToScreen(col, row + 1);
          drawWallSegmentLeft(g, from.x, from.y, to.x, to.y);
        }
        break;
      }
      case 'bottom': {
        // Bottom edge: from bottom-left corner going right along the bottom
        for (let c = 0; c < cols; c++) {
          const col = originCol + c;
          const row = originRow + rows;
          const from = isoToScreen(col, row);
          const to = isoToScreen(col + 1, row);
          drawWallSegmentTop(g, from.x, from.y, to.x, to.y);
        }
        break;
      }
    }
  }
}
