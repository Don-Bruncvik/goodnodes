import { setIcon } from "obsidian";
import { FONT_FAMILY } from "@excalidraw/excalidraw";
import { PEN_COLORS } from "./penPopover";

export interface TextChoice {
	color: string;
	size: number;
	font: number;
	align: "left" | "center" | "right";
}

const SIZES = [16, 20, 28, 36];
const FONTS = [
	{ id: FONT_FAMILY.Excalifont, label: "Hand-drawn" },
	{ id: FONT_FAMILY.Nunito, label: "Normal" },
	{ id: FONT_FAMILY["Comic Shanns"], label: "Code" },
];

export class TextPopover {
	private el: HTMLElement | null = null;
	private cleanup: (() => void)[] = [];

	constructor(
		private host: HTMLElement,
		private get: () => TextChoice,
		private set: (choice: TextChoice) => void,
	) {}

	toggle(anchor: HTMLElement): void {
		if (this.el) this.close();
		else this.open(anchor);
	}

	close(): void {
		for (const fn of this.cleanup) fn();
		this.cleanup = [];
		this.el?.remove();
		this.el = null;
	}

	private open(anchor: HTMLElement): void {
		this.close();
		const el = this.host.createDiv({ cls: "goodnodes-text-popover" });
		this.el = el;
		this.render();
		const rect = this.host.getBoundingClientRect();
		const a = anchor.getBoundingClientRect();
		const width = el.offsetWidth;
		el.style.left = `${Math.min(Math.max(8, a.left + a.width / 2 - width / 2 - rect.left), rect.width - width - 8)}px`;
		el.style.top = `${a.bottom - rect.top + 8}px`;
		const outside = (e: PointerEvent) => {
			if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.close();
		};
		const escape = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.close();
		};
		document.addEventListener("pointerdown", outside, true);
		document.addEventListener("keydown", escape, true);
		this.cleanup.push(
			() => document.removeEventListener("pointerdown", outside, true),
			() => document.removeEventListener("keydown", escape, true),
		);
	}

	private render(): void {
		const el = this.el;
		if (!el) return;
		el.empty();
		const choice = this.get();
		const colors = el.createDiv({ cls: "goodnodes-text-colors" });
		const presets = PEN_COLORS.includes(choice.color.toLowerCase())
			? PEN_COLORS
			: [...PEN_COLORS.slice(0, -1), choice.color];
		for (const color of presets) {
			const b = colors.createEl("button", {
				cls: "goodnodes-pen-swatch",
				attr: { title: color, "aria-label": color },
			});
			b.createSpan({ cls: "goodnodes-pen-swatch-fill" }).style.background = color;
			b.toggleClass("is-active", color.toLowerCase() === choice.color.toLowerCase());
			b.onclick = () => this.choose({ ...choice, color });
		}
		const custom = colors.createEl("label", {
			cls: "goodnodes-pen-swatch goodnodes-pen-custom",
			attr: { title: "Custom color" },
		});
		custom.createSpan({ cls: "goodnodes-pen-swatch-fill" });
		const input = custom.createEl("input", { type: "color" });
		input.value = /^#[0-9a-f]{6}$/i.test(choice.color) ? choice.color : "#1e1e1e";
		input.oninput = () => this.choose({ ...choice, color: input.value }, false);
		input.onchange = () => this.choose({ ...choice, color: input.value });
		const sizes = el.createDiv({ cls: "goodnodes-text-options" });
		SIZES.forEach((size, i) =>
			this.option(sizes, ["S", "M", "L", "XL"][i], size === choice.size, () => this.choose({ ...choice, size })),
		);
		const fonts = el.createDiv({ cls: "goodnodes-text-options" });
		FONTS.forEach((font) =>
			this.option(fonts, font.label, font.id === choice.font, () => this.choose({ ...choice, font: font.id })),
		);
		const aligns = el.createDiv({ cls: "goodnodes-text-options goodnodes-text-align" });
		(["left", "center", "right"] as const).forEach((align) => {
			const b = aligns.createEl("button", {
				cls: choice.align === align ? "is-active" : "",
				attr: { title: `Align ${align}`, "aria-label": `Align ${align}` },
			});
			setIcon(b, `align-${align}`);
			b.onclick = () => this.choose({ ...choice, align });
		});
	}

	private option(parent: HTMLElement, label: string, active: boolean, click: () => void): void {
		const b = parent.createEl("button", { text: label, cls: active ? "is-active" : "" });
		b.onclick = click;
	}

	private choose(choice: TextChoice, rerender = true): void {
		this.set(choice);
		if (rerender) this.render();
	}
}
