// Tiny on-device debug log. The iPad has no devtools at hand, so everything
// interesting (pointer events, timings, errors) goes here and can be shown in
// a floating panel (ribbon/menu toggle) or copied to the clipboard.

export type DebugLevel = "info" | "warn" | "error" | "event";

export interface DebugEntry {
	t: number;
	level: DebugLevel;
	msg: string;
}

const MAX_ENTRIES = 400;

class DebugLog {
	private entries: DebugEntry[] = [];
	private listeners = new Set<() => void>();
	/** Last pointer event per pointerType, shown as a live line in the panel. */
	live: Record<string, string> = {};

	log(msg: string, level: DebugLevel = "info"): void {
		this.entries.push({ t: performance.now(), level, msg });
		if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
		if (level === "error") console.error("[goodnodes]", msg);
		this.emit();
	}

	error(msg: string, err?: unknown): void {
		const detail =
			err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : err !== undefined ? String(err) : "";
		this.log(detail ? `${msg}: ${detail}` : msg, "error");
	}

	/** Record a pointer event compactly; frequent moves only update the live line. */
	pointer(where: string, e: PointerEvent): void {
		const line =
			`${where} ${e.type} ${e.pointerType}#${e.pointerId} ` +
			`p=${e.pressure.toFixed(2)} w×h=${e.width.toFixed(0)}×${e.height.toFixed(0)} ` +
			`x=${e.clientX.toFixed(0)} y=${e.clientY.toFixed(0)}`;
		this.live[e.pointerType] = line;
		if (e.type === "pointermove") this.emit();
		else this.log(line, "event");
	}

	all(): readonly DebugEntry[] {
		return this.entries;
	}

	clear(): void {
		this.entries = [];
		this.live = {};
		this.emit();
	}

	text(): string {
		return this.entries.map((e) => `${(e.t / 1000).toFixed(3)} ${e.level} ${e.msg}`).join("\n");
	}

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(): void {
		for (const fn of this.listeners) fn();
	}
}

export const debug = new DebugLog();

/** Floating, draggable-free panel at the bottom of the screen. */
export class DebugPanel {
	private el: HTMLElement | null = null;
	private unsub: (() => void) | null = null;
	private raf = 0;

	get isOpen(): boolean {
		return this.el !== null;
	}

	toggle(): void {
		if (this.el) this.close();
		else this.open();
	}

	open(): void {
		if (this.el) return;
		const el = document.body.createDiv({ cls: "goodnodes-debug" });
		const bar = el.createDiv({ cls: "goodnodes-debug-bar" });
		bar.createSpan({ text: "GoodNodes debug" });
		const copy = bar.createEl("button", { text: "Copy" });
		copy.onclick = () => void navigator.clipboard.writeText(debug.text());
		const clear = bar.createEl("button", { text: "Clear" });
		clear.onclick = () => debug.clear();
		const close = bar.createEl("button", { text: "×" });
		close.onclick = () => this.close();
		el.createDiv({ cls: "goodnodes-debug-live" });
		el.createDiv({ cls: "goodnodes-debug-log" });
		this.el = el;
		this.unsub = debug.subscribe(() => this.schedule());
		this.render();
	}

	close(): void {
		this.unsub?.();
		this.unsub = null;
		cancelAnimationFrame(this.raf);
		this.el?.remove();
		this.el = null;
	}

	private schedule(): void {
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			this.render();
		});
	}

	private render(): void {
		if (!this.el) return;
		const live = this.el.querySelector(".goodnodes-debug-live") as HTMLElement;
		live.setText(Object.values(debug.live).join("\n"));
		const log = this.el.querySelector(".goodnodes-debug-log") as HTMLElement;
		log.empty();
		const entries = debug.all();
		for (let i = entries.length - 1; i >= Math.max(0, entries.length - 80); i--) {
			const e = entries[i];
			log.createDiv({ cls: `goodnodes-debug-${e.level}`, text: `${(e.t / 1000).toFixed(2)} ${e.msg}` });
		}
	}
}
