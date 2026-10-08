import type { Viewport } from "./touch";

// Paper pattern drawn behind the (transparent) Excalidraw canvas. It is expressed
// in scene units, so it scales and moves with the canvas exactly like the strokes.

export type BackgroundKind = "blank" | "grid" | "dots";

export interface BackgroundSettings {
	kind: BackgroundKind;
	/** Raster spacing in scene units. */
	size: number;
	/** Pattern color; null = theme default. */
	color: string | null;
}

export const DEFAULT_BACKGROUND: BackgroundSettings = { kind: "dots", size: 24, color: null };

/** Below this on-screen spacing the pattern is drawn at a multiple of its size. */
const MIN_SCREEN_SPACING = 8;

export class BackgroundLayer {
	readonly canvas: HTMLCanvasElement;
	private raf = 0;
	private view: Viewport = { scrollX: 0, scrollY: 0, zoom: 1 };
	private resizeObserver: ResizeObserver;

	constructor(
		parent: HTMLElement,
		private settings: BackgroundSettings,
		private dark: boolean,
	) {
		this.canvas = parent.createEl("canvas", { cls: "goodnodes-canvas-bg" });
		this.resizeObserver = new ResizeObserver(() => this.schedule());
		this.resizeObserver.observe(parent);
	}

	destroy(): void {
		cancelAnimationFrame(this.raf);
		this.resizeObserver.disconnect();
		this.canvas.remove();
	}

	setViewport(v: Viewport): void {
		this.view = v;
		this.schedule();
	}

	setSettings(s: BackgroundSettings): void {
		this.settings = s;
		this.schedule();
	}

	setDark(dark: boolean): void {
		this.dark = dark;
		this.schedule();
	}

	private schedule(): void {
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			this.draw();
		});
	}

	private draw(): void {
		const c = this.canvas;
		const dpr = window.devicePixelRatio || 1;
		const w = c.clientWidth;
		const h = c.clientHeight;
		if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
			c.width = Math.round(w * dpr);
			c.height = Math.round(h * dpr);
		}
		const ctx = c.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);
		const { kind, size, color } = this.settings;
		if (kind === "blank" || size <= 0) return;

		const { zoom, scrollX, scrollY } = this.view;
		let step = size;
		while (step * zoom < MIN_SCREEN_SPACING) step *= 2;
		const s = step * zoom;
		// Screen position of scene coordinate 0 along each axis, folded into [0, s).
		const ox = mod(scrollX * zoom, s);
		const oy = mod(scrollY * zoom, s);
		const ink =
			color ??
			(kind === "dots"
				? this.dark
					? "rgba(255,255,255,0.22)"
					: "rgba(0,0,0,0.22)"
				: this.dark
					? "rgba(255,255,255,0.08)"
					: "rgba(0,0,0,0.09)");

		if (kind === "dots") {
			ctx.fillStyle = ink;
			const r = Math.min(2.2, Math.max(0.8, 1.1 * Math.sqrt(zoom)));
			ctx.beginPath();
			for (let x = ox; x < w; x += s) {
				for (let y = oy; y < h; y += s) {
					ctx.moveTo(x + r, y);
					ctx.arc(x, y, r, 0, Math.PI * 2);
				}
			}
			ctx.fill();
		} else {
			ctx.strokeStyle = ink;
			ctx.lineWidth = 1;
			ctx.beginPath();
			for (let x = ox; x < w; x += s) {
				const px = Math.round(x) + 0.5;
				ctx.moveTo(px, 0);
				ctx.lineTo(px, h);
			}
			for (let y = oy; y < h; y += s) {
				const py = Math.round(y) + 0.5;
				ctx.moveTo(0, py);
				ctx.lineTo(w, py);
			}
			ctx.stroke();
		}
	}
}

function mod(a: number, n: number): number {
	return ((a % n) + n) % n;
}
