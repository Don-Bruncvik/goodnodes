// Pen settings for the canvas, GoodNotes-style: tap the (already active) pen in
// Excalidraw's toolbar to pick a color and width. Replaces Excalidraw's big
// properties panel on the left, which is hidden while the pen is active.

export const PEN_COLORS = [
	"#1e1e1e",
	"#5c5f66",
	"#1971c2",
	"#0c8599",
	"#2f9e44",
	"#f08c00",
	"#e03131",
	"#c2255c",
	"#9c36b5",
	"#ffffff",
];

/** Excalidraw freedraw strokeWidth values (Excalidraw's own options are 1, 2, 4). */
export const PEN_WIDTHS = [0.5, 1, 2, 3, 4];

export interface PenChoice {
	color: string;
	width: number;
}

export class PenPopover {
	private el: HTMLElement | null = null;
	private cleanup: (() => void)[] = [];

	constructor(
		private host: HTMLElement,
		private get: () => PenChoice,
		private set: (choice: PenChoice) => void,
	) {}

	get isOpen(): boolean {
		return this.el !== null;
	}

	toggle(anchor: HTMLElement): void {
		if (this.el) this.close();
		else this.open(anchor);
	}

	open(anchor: HTMLElement): void {
		this.close();
		const el = this.host.createDiv({ cls: "goodnodes-pen-popover" });
		this.el = el;
		this.render();

		// Anchor under the toolbar button, kept inside the host.
		const hostRect = this.host.getBoundingClientRect();
		const a = anchor.getBoundingClientRect();
		const width = el.offsetWidth;
		const left = Math.min(
			Math.max(8, a.left + a.width / 2 - width / 2 - hostRect.left),
			hostRect.width - width - 8,
		);
		el.style.left = `${left}px`;
		el.style.top = `${a.bottom - hostRect.top + 8}px`;

		const outside = (e: PointerEvent) => {
			if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.close();
		};
		const escape = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.close();
		};
		// Capture phase: the canvas swallows touch events before they would bubble here.
		document.addEventListener("pointerdown", outside, true);
		document.addEventListener("keydown", escape, true);
		this.cleanup.push(
			() => document.removeEventListener("pointerdown", outside, true),
			() => document.removeEventListener("keydown", escape, true),
		);
	}

	close(): void {
		for (const fn of this.cleanup) fn();
		this.cleanup = [];
		this.el?.remove();
		this.el = null;
	}

	private render(): void {
		const el = this.el;
		if (!el) return;
		el.empty();
		const { color, width } = this.get();

		const colors = el.createDiv({ cls: "goodnodes-pen-colors" });
		const presets = PEN_COLORS.includes(color.toLowerCase()) ? PEN_COLORS : [...PEN_COLORS.slice(0, -1), color];
		for (const c of presets) {
			const b = colors.createEl("button", { cls: "goodnodes-pen-swatch", attr: { "aria-label": c, title: c } });
			b.createSpan({ cls: "goodnodes-pen-swatch-fill" }).style.background = c;
			b.toggleClass("is-active", c.toLowerCase() === color.toLowerCase());
			b.onclick = () => this.choose({ color: c, width });
		}
		const custom = colors.createEl("label", {
			cls: "goodnodes-pen-swatch goodnodes-pen-custom",
			attr: { title: "Custom color" },
		});
		custom.createSpan({ cls: "goodnodes-pen-swatch-fill" });
		const input = custom.createEl("input", { type: "color" });
		input.value = /^#[0-9a-f]{6}$/i.test(color) ? color : "#1e1e1e";
		input.oninput = () => this.choose({ color: input.value, width }, false);
		input.onchange = () => this.choose({ color: input.value, width });

		const widths = el.createDiv({ cls: "goodnodes-pen-widths" });
		for (const w of PEN_WIDTHS) {
			const b = widths.createEl("button", {
				cls: "goodnodes-pen-width",
				attr: { "aria-label": `Width ${w}`, title: `Width ${w}` },
			});
			const dot = b.createSpan({ cls: "goodnodes-pen-width-dot goodnodes-pen-swatch-fill" });
			const size = Math.round(3 + w * 4);
			dot.style.width = dot.style.height = `${size}px`;
			dot.style.background = color;
			b.toggleClass("is-active", w === width);
			b.onclick = () => this.choose({ color, width: w });
		}
	}

	private choose(choice: PenChoice, rerender = true): void {
		this.set(choice);
		if (rerender) this.render();
	}
}
