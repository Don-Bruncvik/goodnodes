import { setIcon } from "obsidian";
import { FONT_FAMILY } from "@excalidraw/excalidraw";
import type { PenType } from "../ink/penStyle";
import "./toolbar.css";

export type ToolbarTool = "lasso" | "pen" | "highlighter" | "eraser" | "text" | "shapes" | "image";
export type ToolbarShape = "line" | "arrow" | "rectangle" | "ellipse" | "diamond";
export type ToolbarState = {
	active: ToolbarTool;
	color: string;
	colors: string[];
	width: number;
	widths: number[];
	penType: PenType;
	drawAndHold: boolean;
	eraserMode: "precise" | "stroke";
	eraserSize: number;
	eraserHighlighterOnly: boolean;
	textSize: number;
	textFont: number;
	textAlign: "left" | "center" | "right";
	shape: ToolbarShape;
	canUndo?: boolean;
	canRedo?: boolean;
};

export interface ToolbarHost {
	state(): ToolbarState;
	supports(tool: ToolbarTool): boolean;
	leading?(parent: HTMLElement): void;
	select(tool: ToolbarTool): void;
	activateAgain?(tool: ToolbarTool): void;
	color(tool: ToolbarTool, value: string, favoriteIndex: number): void;
	width(tool: ToolbarTool, value: number, presetIndex: number): void;
	setting(
		key:
			| "penType"
			| "drawAndHold"
			| "eraserMode"
			| "eraserHighlighterOnly"
			| "textSize"
			| "textFont"
			| "textAlign"
			| "shape"
			| "eraserSize",
		value: string | number | boolean,
	): void;
	undo(): void;
	redo(): void;
	more(event: MouseEvent): void;
	eraserOptions?: boolean;
	eraserHighlighterOnly?: boolean;
}

const TOOLS: [ToolbarTool, string, string][] = [
	["lasso", "lasso", "Lasso"],
	["pen", "pen-line", "Pen"],
	["highlighter", "highlighter", "Highlighter"],
	["eraser", "eraser", "Eraser"],
	["text", "type", "Text"],
	["shapes", "shapes", "Shapes"],
	["image", "image-plus", "Image"],
];
const WIDTHS: Record<string, number[]> = { pen: [1, 2, 4], highlighter: [1.6, 2.4, 3.6], eraser: [6, 10, 16] };
/** Plain DOM so PDF and the React canvas can share one toolbar implementation. */
export class GoodNodesToolbar {
	private rows: HTMLElement[] = [];
	private tools: HTMLElement;
	private options: HTMLElement;
	private actions: HTMLElement;
	private observer: ResizeObserver;
	private activePopover: HTMLElement | null = null;
	private cleanup: (() => void)[] = [];
	private stopCanvasEvent = (event: Event) => event.stopPropagation();

	constructor(
		private hostEl: HTMLElement,
		private host: ToolbarHost,
	) {
		hostEl.addClass("goodnodes-toolbar-host");
		for (const type of ["pointerdown", "pointerup", "pointermove", "touchstart", "touchend", "touchmove"])
			hostEl.addEventListener(type, this.stopCanvasEvent);
		this.tools = hostEl.createDiv({ cls: "goodnodes-toolbar-row goodnodes-toolbar-tools" });
		this.options = hostEl.createDiv({ cls: "goodnodes-toolbar-row goodnodes-toolbar-options" });
		this.actions = hostEl.createDiv({ cls: "goodnodes-toolbar-row goodnodes-toolbar-actions" });
		this.rows = [this.tools, this.options, this.actions];
		this.observer = new ResizeObserver(() => this.layout());
		this.observer.observe(hostEl);
		// The view resizing (rotation, sidebar) decides between one and two rows.
		if (hostEl.parentElement) this.observer.observe(hostEl.parentElement);
		const pages = hostEl.parentElement?.querySelector(":scope > .goodnodes-pdf-scroll");
		if (pages) this.observer.observe(pages);
		this.render();
	}

	refresh(): void {
		this.render();
	}
	destroy(): void {
		this.observer.disconnect();
		this.closePopover();
		for (const type of ["pointerdown", "pointerup", "pointermove", "touchstart", "touchend", "touchmove"])
			this.hostEl.removeEventListener(type, this.stopCanvasEvent);
		this.hostEl.empty();
	}

	/** The tool the toolbar was last drawn for: a popover belongs to that tool only. */
	private renderedTool: ToolbarTool | null = null;

	private render(): void {
		const active = this.host.state().active;
		// A color picker or menu of the previous tool must not survive a tool switch; within
		// one tool it stays (re-renders while dragging the color input would kill it).
		if (active !== this.renderedTool) this.closePopover();
		this.renderedTool = active;
		this.tools.empty();
		this.options.empty();
		this.actions.empty();
		this.host.leading?.(this.tools);
		this.sep(this.tools);
		const state = this.host.state();
		for (const [tool, icon, label] of TOOLS) {
			const button = this.button(this.tools, icon, label, "goodnodes-toolbar-tool");
			button.dataset.tool = tool;
			button.toggleClass("is-active", state.active === tool);
			if (!this.host.supports(tool)) {
				button.disabled = true;
				button.title = "Coming soon in PDF notebooks";
			} else
				button.onclick = () => {
					if (state.active === tool) this.host.activateAgain?.(tool);
					else this.host.select(tool);
					this.render();
				};
		}
		this.sep(this.tools);
		this.renderOptions(state);
		this.sep(this.actions);
		const undo = this.button(this.actions, "undo-2", "Undo", "goodnodes-toolbar-history");
		undo.disabled = state.canUndo === false;
		undo.onclick = () => this.host.undo();
		const redo = this.button(this.actions, "redo-2", "Redo", "goodnodes-toolbar-history");
		redo.disabled = state.canRedo === false;
		redo.onclick = () => this.host.redo();
		const more = this.button(this.actions, "more-horizontal", "More", "goodnodes-toolbar-more");
		more.onclick = (event) => this.host.more(event);
		this.layout();
	}

	private renderOptions(s: ToolbarState): void {
		const tool = s.active;
		if (tool === "lasso" || tool === "image") return;
		if (tool === "pen") {
			const type = this.button(
				this.options,
				s.penType === "brush" ? "brush" : s.penType === "ball" ? "pen" : "pen-tool",
				`${s.penType} pen options`,
				"goodnodes-toolbar-type",
			);
			setIcon(type, s.penType === "brush" ? "brush" : s.penType === "ball" ? "pen" : "pen-tool");
			this.chevron(type);
			type.onclick = () =>
				this.dropdown(
					type,
					["Fountain", "Ball", "Brush"],
					["fountain", "ball", "brush"],
					(v) => this.host.setting("penType", v),
					true,
					s.drawAndHold,
				);
		}
		if (tool === "pen" || tool === "highlighter" || tool === "eraser") {
			if (tool === "eraser" && this.host.eraserOptions !== false) {
				this.segment(this.options, "Precise", "precise", s.eraserMode, (v) =>
					this.host.setting("eraserMode", v),
				);
				this.segment(this.options, "Whole stroke", "stroke", s.eraserMode, (v) =>
					this.host.setting("eraserMode", v),
				);
			}
			for (const [presetIndex, width] of (tool === "eraser"
				? this.host.eraserOptions === false
					? []
					: [6, 10, 16]
				: s.widths?.length === 3
					? s.widths
					: WIDTHS[tool]
			).entries()) {
				const b = this.options.createEl("button", {
					cls: "goodnodes-toolbar-width",
					attr: { title: `Width ${width}` },
				});
				b.toggleClass("is-active", width === (tool === "eraser" ? s.eraserSize : s.width));
				const dot = b.createSpan({ cls: "goodnodes-toolbar-dot" });
				dot.style.width = dot.style.height = `${Math.max(4, Math.min(12, width * 2.5))}px`;
				b.onclick = () =>
					tool === "eraser"
						? this.host.setting("eraserSize", width)
						: this.host.width(tool, width, presetIndex);
			}
			if (tool !== "eraser") this.renderColors(tool, s);
			if (tool === "eraser" && this.host.eraserHighlighterOnly !== false) {
				const b = this.button(this.options, "highlighter", "Highlighter only", "goodnodes-toolbar-toggle");
				b.toggleClass("is-active", s.eraserHighlighterOnly);
				b.onclick = () => this.host.setting("eraserHighlighterOnly", !s.eraserHighlighterOnly);
			}
		}
		if (tool === "text") {
			for (const [label, size] of [
				["S", 16],
				["M", 20],
				["L", 28],
				["XL", 36],
			] as [string, number][])
				this.segment(this.options, label, size, s.textSize, (v) => this.host.setting("textSize", v));
			const font = this.button(this.options, "type", "Font", "goodnodes-toolbar-type");
			this.chevron(font);
			font.onclick = () =>
				this.dropdown(
					font,
					["Hand-drawn", "Normal", "Code"],
					[FONT_FAMILY.Excalifont, FONT_FAMILY.Nunito, FONT_FAMILY["Comic Shanns"]],
					(v) => this.host.setting("textFont", Number(v)),
				);
			this.renderColors(tool, s);
			const align = this.button(this.options, `align-${s.textAlign}`, "Text alignment", "goodnodes-toolbar-type");
			this.chevron(align);
			align.onclick = () =>
				this.dropdown(align, ["Left", "Center", "Right"], ["left", "center", "right"], (v) =>
					this.host.setting("textAlign", v),
				);
		}
		if (tool === "shapes") {
			for (const [label, shape] of [
				["Line", "line"],
				["Arrow", "arrow"],
				["Rectangle", "rectangle"],
				["Ellipse", "ellipse"],
				["Diamond", "diamond"],
			] as [string, ToolbarShape][]) {
				const b = this.button(
					this.options,
					shape === "line"
						? "minus"
						: shape === "arrow"
							? "arrow-right"
							: shape === "rectangle"
								? "square"
								: shape === "ellipse"
									? "circle"
									: "diamond",
					label,
					"goodnodes-toolbar-shape",
				);
				b.toggleClass("is-active", s.shape === shape);
				b.onclick = () => this.host.setting("shape", shape);
			}
			this.renderColors(tool, s);
		}
	}

	/**
	 * GoodNotes-style colors: three basic ones, then the user's two custom ones. Tapping a
	 * color selects it; tapping the selected custom color opens the system color picker
	 * (an invisible color input laid over it, the only reliable way on iOS).
	 */
	private renderColors(tool: ToolbarTool, s: ToolbarState): void {
		const colors = s.colors ?? [];
		const current = s.color.toLowerCase();
		const selected = colors.findIndex((color) => color.toLowerCase() === current);
		colors.slice(0, 5).forEach((color, i) => {
			if (i === 3) this.sep(this.options);
			const custom = i >= 3;
			const b = this.options.createEl("button", {
				cls: `goodnodes-toolbar-color${custom ? " is-custom" : ""}`,
				attr: { title: custom ? "Custom color – tap again to change" : color, "aria-label": color },
			});
			b.style.setProperty("--goodnodes-toolbar-color", color);
			b.toggleClass("is-active", i === selected);
			if (custom && i === selected) {
				const input = b.createEl("input", { cls: "goodnodes-toolbar-color-input", attr: { type: "color" } });
				input.value = /^#[0-9a-f]{6}$/i.test(color) ? color : "#1e1e1e";
				// `change` fires once the picker closes; re-rendering on every `input` would
				// remove the input under the open picker.
				input.onchange = () => this.host.color(tool, input.value, i);
			} else b.onclick = () => this.host.color(tool, color, i);
		});
	}

	private dropdown(
		anchor: HTMLElement,
		labels: string[],
		values: (string | number)[],
		choose: (v: string | number | boolean) => void,
		hold = false,
		holdOn = false,
	): void {
		this.closePopover();
		const pop = this.hostEl.createDiv({ cls: "goodnodes-toolbar-popover goodnodes-toolbar-menu" });
		this.activePopover = pop;
		labels.forEach((label, i) => {
			const b = pop.createEl("button", { text: label });
			b.onclick = () => {
				choose(values[i]);
				this.closePopover();
				this.render();
			};
		});
		if (hold) {
			const row = pop.createDiv({ cls: "goodnodes-toolbar-switch-row" });
			row.createSpan({ text: "Draw and hold" });
			const b = row.createEl("button", {
				cls: `goodnodes-toolbar-switch${holdOn ? " is-on" : ""}`,
				attr: { role: "switch", "aria-checked": String(holdOn) },
			});
			b.onclick = () => {
				choose(!holdOn);
				this.closePopover();
				this.render();
			};
		}
		this.place(pop, anchor);
	}

	private segment(
		parent: HTMLElement,
		label: string,
		value: string | number,
		current: string | number,
		action: (value: any) => void,
	): void {
		const b = parent.createEl("button", { cls: "goodnodes-toolbar-segment", text: label });
		b.toggleClass("is-active", value === current);
		b.onclick = () => action(value);
	}
	private button(parent: HTMLElement, icon: string, title: string, cls: string): HTMLButtonElement {
		const b = parent.createEl("button", { cls, attr: { title, "aria-label": title } });
		setIcon(b, icon);
		return b;
	}
	private sep(parent: HTMLElement): void {
		parent.createDiv({ cls: "goodnodes-toolbar-separator" });
	}
	private chevron(button: HTMLElement): void {
		const span = button.createSpan({ cls: "goodnodes-toolbar-chevron" });
		setIcon(span, "chevron-down");
	}
	private place(pop: HTMLElement, anchor: HTMLElement): void {
		const a = anchor.getBoundingClientRect(),
			h = this.hostEl.getBoundingClientRect();
		pop.style.left = `${Math.max(4, Math.min(h.width - pop.offsetWidth - 4, a.left + a.width / 2 - h.left - pop.offsetWidth / 2))}px`;
		pop.style.top = `${a.bottom - h.top + 6}px`;
		const outside = (e: PointerEvent) => {
			if (!pop.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.closePopover();
		};
		document.addEventListener("pointerdown", outside, true);
		this.cleanup.push(() => document.removeEventListener("pointerdown", outside, true));
	}
	private closePopover(): void {
		for (const fn of this.cleanup) fn();
		this.cleanup = [];
		this.activePopover?.remove();
		this.activePopover = null;
	}
	/**
	 * One row when everything fits; otherwise the active tool's options go to a second row
	 * (GoodNotes' two rows); if even tools + undo/redo don't fit, those move down too.
	 * Widths are summed from the buttons, not read from the rows: a stacked row is
	 * stretched to the full width and would keep the toolbar stacked forever.
	 */
	private layout(): void {
		// In a PDF the pages sidebar takes part of the view; the toolbar sits over the pages.
		const parent = this.hostEl.parentElement;
		const area = parent?.querySelector<HTMLElement>(":scope > .goodnodes-pdf-scroll") ?? parent;
		const available = (area?.clientWidth ?? window.innerWidth) - 16 - 12;
		// Each button/separator with its margins, plus the row's 2px gaps.
		const width = (row: HTMLElement) =>
			[...row.children].reduce(
				(sum, child) => {
					const style = getComputedStyle(child);
					return (
						sum +
						(child as HTMLElement).offsetWidth +
						parseFloat(style.marginLeft) +
						parseFloat(style.marginRight)
					);
				},
				Math.max(0, row.children.length - 1) * 2,
			);
		const tools = width(this.tools),
			options = width(this.options),
			actions = width(this.actions);
		const oneRow = tools + options + actions <= available;
		const stacked = !oneRow && tools + actions <= available;
		this.hostEl.toggleClass("is-stacked", stacked);
		this.hostEl.toggleClass("is-compact", !oneRow && !stacked);
		// A wrapped flex island would stretch to the full width; size it to its longest row.
		const longest = oneRow ? 0 : stacked ? Math.max(tools + actions, options) : Math.max(tools, actions + options);
		// + padding, border and the gaps between the row groups.
		this.hostEl.style.width = oneRow ? "" : `${Math.min(available + 12, longest + 20)}px`;
	}
}
