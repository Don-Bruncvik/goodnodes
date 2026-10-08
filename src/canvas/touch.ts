import { debug } from "../debug";

// Finger gestures for the Excalidraw canvas.
//
// Excalidraw's pen mode lets a finger pan, but pinch-zoom stops working once the
// Apple Pencil has been detected. So fingers never reach Excalidraw at all: touch
// pointer events are swallowed in the capture phase on our wrapper and turned into
// pan (1 finger) and pinch-zoom (2 fingers) ourselves. Pen and mouse pass through.
//
// Excalidraw's viewport transform: viewport = (scene + scroll) * zoom, relative to
// the canvas container, so the scene point under a screen point c is
// c / zoom - scroll.

export interface Viewport {
	scrollX: number;
	scrollY: number;
	zoom: number;
}

export interface TouchGestureHost {
	getViewport(): Viewport;
	setViewport(v: Viewport): void;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 30;
/** Touches starting this soon after the pen lifted are treated as the palm too. */
const PALM_GRACE_MS = 250;

interface Pt {
	x: number;
	y: number;
}

export class TouchGestures {
	private touches = new Map<number, Pt>();
	private pens = new Set<number>();
	private penUpAt = 0;
	/** Gesture baseline, reset whenever the number of fingers changes. */
	private start: { view: Viewport; center: Pt; dist: number } | null = null;
	private pending: Viewport | null = null;
	private raf = 0;
	private cleanup: (() => void)[] = [];

	constructor(
		private el: HTMLElement,
		private host: TouchGestureHost,
	) {
		const opts = { capture: true, passive: false } as const;
		const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
			el.addEventListener(type, fn as EventListener, opts);
			this.cleanup.push(() => el.removeEventListener(type, fn as EventListener, opts));
		};
		on("pointerdown", this.onPointerDown);
		on("pointermove", this.onPointerMove);
		on("pointerup", this.onPointerUp);
		on("pointercancel", this.onPointerUp);
		// Finger touch events would otherwise trigger Excalidraw's own touch handling
		// and WebKit's native gestures; stylus touches are left alone.
		for (const type of ["touchstart", "touchmove", "touchend"] as const) on(type, this.onTouch);
		// Safari pinch events (Excalidraw listens to these for its own zoom).
		for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
			const fn = (e: Event) => {
				e.preventDefault();
				e.stopPropagation();
			};
			el.addEventListener(type, fn, opts);
			this.cleanup.push(() => el.removeEventListener(type, fn, opts));
		}
	}

	destroy(): void {
		cancelAnimationFrame(this.raf);
		for (const fn of this.cleanup) fn();
		this.cleanup = [];
	}

	private local(e: PointerEvent): Pt {
		const r = this.el.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	private isPenActive(): boolean {
		return this.pens.size > 0 || performance.now() - this.penUpAt < PALM_GRACE_MS;
	}

	private onPointerDown = (e: PointerEvent) => {
		debug.pointer("canvas", e);
		if (e.pointerType === "pen") this.pens.add(e.pointerId);
		if (e.pointerType !== "touch") return;
		e.stopPropagation();
		e.preventDefault();
		if (this.isPenActive()) {
			debug.log(`touch #${e.pointerId} ignored (pen active, palm)`);
			return;
		}
		this.touches.set(e.pointerId, this.local(e));
		this.resetBaseline();
	};

	private onPointerMove = (e: PointerEvent) => {
		debug.pointer("canvas", e);
		if (e.pointerType !== "touch") return;
		e.stopPropagation();
		e.preventDefault();
		if (!this.touches.has(e.pointerId)) return;
		this.touches.set(e.pointerId, this.local(e));
		this.update();
	};

	private onPointerUp = (e: PointerEvent) => {
		debug.pointer("canvas", e);
		if (e.pointerType === "pen" && this.pens.delete(e.pointerId)) this.penUpAt = performance.now();
		if (e.pointerType !== "touch") return;
		e.stopPropagation();
		e.preventDefault();
		if (!this.touches.delete(e.pointerId)) return;
		this.resetBaseline();
	};

	private onTouch = (e: TouchEvent) => {
		const stylus = Array.from(e.changedTouches).some((t) => (t as Touch & { touchType?: string }).touchType === "stylus");
		if (stylus) return;
		e.stopPropagation();
		if (e.cancelable) e.preventDefault();
	};

	private resetBaseline(): void {
		this.flush();
		const pts = [...this.touches.values()];
		if (pts.length === 0) {
			this.start = null;
			return;
		}
		const view = this.host.getViewport();
		this.start = { view, center: centerOf(pts), dist: distOf(pts) };
	}

	private update(): void {
		const s = this.start;
		if (!s) return;
		const pts = [...this.touches.values()];
		const center = centerOf(pts);
		let zoom = s.view.zoom;
		if (pts.length >= 2 && s.dist > 0) zoom = clamp(s.view.zoom * (distOf(pts) / s.dist), MIN_ZOOM, MAX_ZOOM);
		// Scene point that was under the starting center stays under the current center.
		const sceneX = s.center.x / s.view.zoom - s.view.scrollX;
		const sceneY = s.center.y / s.view.zoom - s.view.scrollY;
		this.pending = { zoom, scrollX: center.x / zoom - sceneX, scrollY: center.y / zoom - sceneY };
		if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
	}

	private flush(): void {
		cancelAnimationFrame(this.raf);
		this.raf = 0;
		if (this.pending) this.host.setViewport(this.pending);
		this.pending = null;
	}
}

function centerOf(pts: Pt[]): Pt {
	if (pts.length === 1) return pts[0];
	const [a, b] = pts;
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distOf(pts: Pt[]): number {
	if (pts.length < 2) return 0;
	const [a, b] = pts;
	return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}
