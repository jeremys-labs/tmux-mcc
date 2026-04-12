import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import EventEmitter from 'eventemitter3';
import type { AgentConfig } from '../types/agent';
import { isoToScreen } from './tiles';
import { ZONES, resolveZone, drawZoneFloor, drawZoneWalls } from './rooms';
import {
  drawDesk,
  drawDualMonitorDesk,
  drawConferenceTable,
  drawKitchenCounter,
  drawStove,
  drawFridge,
  drawWhiteboard,
} from './furniture';
import { drawNameLabel } from './characters';

export class IsometricScene extends EventEmitter {
  private app: Application;
  private world: Container;
  private agents: Record<string, AgentConfig>;
  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private worldStart = { x: 0, y: 0 };
  private lastPinchDist = 0;
  private avatarTextures: Map<string, Texture>;

  constructor(
    app: Application,
    agents: Record<string, AgentConfig>,
    avatarTextures: Map<string, Texture>,
  ) {
    super();
    this.app = app;
    this.agents = agents;
    this.avatarTextures = avatarTextures;
    this.world = new Container();
    this.app.stage.addChild(this.world);
    this.setupPanZoom();
  }

  render(): void {
    this.drawFloors();
    this.drawBackWalls();
    this.drawFurniture();
    this.drawAgents();
    this.drawFrontWalls();

    // Center the world in the viewport
    this.world.x = this.app.screen.width / 2;
    this.world.y = 80;
  }

  // ─── Floor layer ────────────────────────────────────────────────

  private drawFloors(): void {
    const g = new Graphics();
    for (const zone of ZONES) {
      drawZoneFloor(g, zone);
    }
    this.world.addChild(g);
  }

  // ─── Walls (back = top + left, front = bottom + right) ─────────

  private drawBackWalls(): void {
    const g = new Graphics();
    for (const zone of ZONES) {
      const backZone = {
        ...zone,
        walls: zone.walls.filter((w) => w === 'top' || w === 'left'),
      };
      drawZoneWalls(g, backZone);
    }
    this.world.addChild(g);
  }

  private drawFrontWalls(): void {
    const g = new Graphics();
    for (const zone of ZONES) {
      const frontZone = {
        ...zone,
        walls: zone.walls.filter((w) => w === 'bottom' || w === 'right'),
      };
      drawZoneWalls(g, frontZone);
    }
    this.world.addChild(g);
  }

  // ─── Furniture layer ────────────────────────────────────────────

  private drawFurniture(): void {
    const furnitureLayer = new Container();

    // ── Conference room ──
    drawConferenceTable(furnitureLayer, 2, 9);
    drawWhiteboard(furnitureLayer, 1, 7);

    // ── Kitchen ──
    drawKitchenCounter(furnitureLayer, 12, 8);
    drawStove(furnitureLayer, 13, 8);
    drawFridge(furnitureLayer, 15, 8);

    this.world.addChild(furnitureLayer);
  }

  // ─── Agent layer (desks + characters, y-sorted) ─────────────────

  private drawAgents(): void {
    const entries = Object.entries(this.agents).map(([key, agent]) => {
      const zone = resolveZone(agent.position?.zone || 'desk');
      const zoneDef = ZONES.find((z) => z.id === zone) || ZONES[0];
      const col = zoneDef.originCol + (agent.position?.x ?? 1);
      const row = zoneDef.originRow + (agent.position?.y ?? 1);
      return { key, agent, col, row };
    });

    // Sort by row (y) for correct isometric depth
    entries.sort((a, b) => a.row - b.row || a.col - b.col);

    for (const { key, agent, col, row } of entries) {
      const { x, y } = isoToScreen(col, row);

      // Draw desk (or dual-monitor desk for architect)
      if (agent.position?.zone === 'kitchen') {
        // Kitchen agents don't get a desk
      } else if (agent.role.toLowerCase().includes('architect')) {
        drawDualMonitorDesk(this.world, col, row);
      } else {
        drawDesk(this.world, col, row);
      }

      const agentContainer = new Container();
      agentContainer.x = x;
      agentContainer.y = y;
      agentContainer.eventMode = 'static';
      agentContainer.cursor = 'pointer';

      // Draw DiceBear pixel-art avatar as Sprite
      const texture = this.avatarTextures.get(key);
      if (texture) {
        const sprite = new Sprite(texture);
        sprite.anchor.set(0.5, 1);
        sprite.width = 42;
        sprite.height = 42;
        sprite.y = 4;
        agentContainer.addChild(sprite);
      }

      // Name label below avatar
      drawNameLabel(agentContainer, agent.name, 8);

      // Hover highlight
      const highlight = new Graphics();
      highlight.circle(0, -16, 26);
      highlight.fill({ color: 0xffffff, alpha: 0 });
      agentContainer.addChild(highlight);

      agentContainer.on('pointerover', () => {
        highlight.clear();
        highlight.circle(0, -16, 26);
        highlight.fill({ color: 0xffffff, alpha: 0.1 });
      });
      agentContainer.on('pointerout', () => {
        highlight.clear();
        highlight.circle(0, -16, 26);
        highlight.fill({ color: 0xffffff, alpha: 0 });
      });

      agentContainer.on('pointerdown', (e: { stopPropagation: () => void }) => {
        e.stopPropagation();
        this.emit('agentClick', key);
      });

      this.world.addChild(agentContainer);
    }
  }

  // ─── Pan & Zoom ─────────────────────────────────────────────────

  private setupPanZoom(): void {
    const stage = this.app.stage;
    stage.eventMode = 'static';
    stage.hitArea = this.app.screen;

    stage.on('pointerdown', (e) => {
      this.isDragging = true;
      this.dragStart = { x: e.global.x, y: e.global.y };
      this.worldStart = { x: this.world.x, y: this.world.y };
    });

    stage.on('pointermove', (e) => {
      if (!this.isDragging) return;
      this.world.x = this.worldStart.x + (e.global.x - this.dragStart.x);
      this.world.y = this.worldStart.y + (e.global.y - this.dragStart.y);
    });

    stage.on('pointerup', () => {
      this.isDragging = false;
    });
    stage.on('pointerupoutside', () => {
      this.isDragging = false;
    });

    this.app.canvas.addEventListener(
      'wheel',
      (e: WheelEvent) => {
        e.preventDefault();
        const scale = this.world.scale.x;
        const newScale = Math.max(0.3, Math.min(3, scale - e.deltaY * 0.001));
        this.world.scale.set(newScale);
      },
      { passive: false },
    );

    const canvas = this.app.canvas as HTMLCanvasElement;
    canvas.addEventListener(
      'touchstart',
      (e: TouchEvent) => {
        if (e.touches.length === 2) {
          e.preventDefault();
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          this.lastPinchDist = Math.sqrt(dx * dx + dy * dy);
        }
      },
      { passive: false },
    );

    canvas.addEventListener(
      'touchmove',
      (e: TouchEvent) => {
        if (e.touches.length === 2 && this.lastPinchDist > 0) {
          e.preventDefault();
          const dx = e.touches[0].clientX - e.touches[1].clientX;
          const dy = e.touches[0].clientY - e.touches[1].clientY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const scaleFactor = dist / this.lastPinchDist;
          const scale = this.world.scale.x;
          const newScale = Math.max(0.3, Math.min(3, scale * scaleFactor));
          this.world.scale.set(newScale);
          this.lastPinchDist = dist;
        }
      },
      { passive: false },
    );

    canvas.addEventListener('touchend', () => {
      this.lastPinchDist = 0;
    });
  }

  destroy(): void {
    this.world.destroy({ children: true });
  }
}
