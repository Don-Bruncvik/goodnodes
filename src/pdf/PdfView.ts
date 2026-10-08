import { App, FileView, loadPdfJs, Menu, Modal, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { getStroke } from "perfect-freehand";
import { findScratchedStrokes } from "../scratch/detect";
import type GoodNodesPlugin from "../main";
import { debug } from "../debug";
import { createAnnotatedPdf } from "./export";
import { displayedToUnrotated, unrotatedToDisplayed } from "./coordinates";
import { findEraserHits } from "./eraser";
import { PdfHistory } from "./history";
import type { InkPoint, InkStroke, InkTool, PdfSidecar } from "./model";
import { newStrokeId } from "./model";
import { parseSidecar, serializeSidecar } from "./sidecar";
import "./pdf.css";

export const PDF_VIEW_TYPE = "goodnodes-pdf";
type PdfDoc = any;
type PdfPage = any;
/** Rotation info in the convention of coordinates.ts (unrotated page size). */
function rotationInfo(slot: PageSlot): { width: number; height: number; rotation: number } {
	return { width: slot.unrotatedWidth, height: slot.unrotatedHeight, rotation: slot.rotation };
}

type PageSlot = {
	el: HTMLElement;
	width: number;
	height: number;
	unrotatedWidth: number;
	unrotatedHeight: number;
	rotation: number;
	canvas?: HTMLCanvasElement;
	ink?: HTMLCanvasElement;
	live?: HTMLCanvasElement;
	task?: any;
	page?: PdfPage;
	busy?: boolean;
};
type Tool = InkTool | "eraser";
type ZoomAnchor = { page: number; x: number; y: number };
type Gesture = {
	distance: number;
	zoom: number;
	originX: number;
	originY: number;
	centerX: number;
	centerY: number;
	anchor: ZoomAnchor;
	visualScale: number;
};
type SessionTool = { tool: Tool; color: string; width: number };
type SidebarTab = "pages" | "outline" | "bookmarks";
const PEN_COLORS = [
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
const HIGHLIGHTER_COLORS = ["#ffd43b", "#69db7c", "#74c0fc", "#faa2c1", "#ffa94d", "#b197fc"];
let sessionTool: Tool = "pen";

export class PdfNotebookView extends FileView {
	navigation = true;
	zoom = 1;
	private plugin: GoodNodesPlugin;
	private doc: PdfDoc | null = null;
	private pdfjs: any;
	private scroller: HTMLElement;
	private pagesEl: HTMLElement;
	private toolbar: HTMLElement;
	private historyToolbar: HTMLElement;
	private indicator: HTMLElement;
	private sidebar: HTMLElement | null = null;
	private sidebarContent: HTMLElement | null = null;
	private sidebarTab: SidebarTab = "pages";
	private restoredSidebar: SidebarTab | null = null;
	private popover: HTMLElement | null = null;
	private settingsTimer: number | null = null;
	private bookmarks = new Set<number>();
	private scrubber: HTMLElement;
	private scrubberThumb: HTMLElement;
	private scrubberBubble: HTMLElement;
	private scrubberTimer: number | null = null;
	private scrubberRaf = 0;
	private scrubberDragging = false;
	private scrubberPointer = 0;
	private scrubberPendingY = 0;
	private outlineItems: { row: HTMLElement; page: number | null }[] = [];
	private observer: IntersectionObserver | null = null;
	private thumbObserver: IntersectionObserver | null = null;
	private slots: PageSlot[] = [];
	private loaded = new Map<number, PdfPage>();
	private visible = new Set<number>();
	private queue: number[] = [];
	private running = 0;
	private raf = 0;
	private pageScale = 1;
	private baseWidth = 612;
	private baseHeight = 792;
	private strokes = new Map<number, InkStroke[]>();
	private history = new PdfHistory();
	private toolState: SessionTool;
	/** The stroke in progress belongs to exactly one pen/mouse pointer. */
	private activeStroke: { pointerId: number; page: number; points: InkPoint[]; tool: Tool } | null = null;
	private pointers = new Map<number, PointerEvent>();
	private pinch: Gesture | null = null;
	private penUntil = 0;
	private penDown = false;
	private ignoredTouches = new Set<number>();
	private jumpStarted = new Map<number, number>();
	private disposed = false;
	private loadStartedAt = 0;
	private sidecarPath = "";
	private lastSerialized = "";
	private saveTimer: number | null = null;
	private loadGeneration = 0;
	private dirty = false;
	/** Bumped on every change; a finished write only clears `dirty` if nothing changed meanwhile. */
	private revision = 0;
	private loadingSidecar = false;
	private currentPage = 0;
	private touchStart = (e: TouchEvent) => this.blockStylusTouch(e);
	private touchMove = (event: TouchEvent) => {
		this.blockStylusTouch(event);
		if (this.pointers.size >= 2) event.preventDefault();
	};

	constructor(leaf: WorkspaceLeaf, plugin: GoodNodesPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.toolState = {
			tool: sessionTool,
			color: plugin.settings.penColor,
			width: plugin.settings.penWidth,
		};
		this.contentEl.addClass("goodnodes-pdf-root");
		this.scroller = this.contentEl.createDiv({ cls: "goodnodes-pdf-scroll" });
		// Obsidian doesn't call onResize for every size change (window resize, iPad rotation,
		// split view, our own sidebar), so watch the scroller directly.
		const resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => this.onResize()));
		resizeObserver.observe(this.scroller);
		this.register(() => resizeObserver.disconnect());
		this.pagesEl = this.scroller.createDiv({ cls: "goodnodes-pdf-pages" });
		this.historyToolbar = this.contentEl.createDiv({ cls: "goodnodes-pdf-history" });
		this.toolbar = this.contentEl.createDiv({ cls: "goodnodes-pdf-toolbar" });
		this.indicator = this.contentEl.createDiv({ cls: "goodnodes-pdf-indicator", text: "— / —" });
		this.scrubber = this.contentEl.createDiv({ cls: "goodnodes-pdf-scrubber" });
		this.scrubberThumb = this.scrubber.createDiv({ cls: "goodnodes-pdf-scrubber-thumb" });
		this.scrubberBubble = this.scrubber.createDiv({ cls: "goodnodes-pdf-scrubber-bubble" });
		this.buildToolbar();
		this.registerDomEvent(this.scroller, "scroll", () => {
			this.scheduleUpdate();
			this.showScrubber();
		});
		this.registerDomEvent(this.indicator, "click", () => this.openPageModal());
		this.registerDomEvent(this.scrubber, "pointerdown", (e) => this.scrubberDown(e));
		this.registerDomEvent(this.scrubber, "pointermove", (e) => this.scrubberMove(e));
		this.registerDomEvent(this.scrubber, "pointerup", (e) => this.scrubberUp(e));
		this.registerDomEvent(this.scrubber, "pointercancel", (e) => this.scrubberUp(e));
		this.registerDomEvent(this.pagesEl, "pointerdown", (e) => this.pointerDown(e));
		this.registerDomEvent(this.pagesEl, "pointermove", (e) => this.pointerMove(e));
		this.registerDomEvent(this.pagesEl, "pointerup", (e) => this.pointerUp(e));
		this.registerDomEvent(this.pagesEl, "pointercancel", (event) => {
			debug.log("pdf pointercancel (device diagnostic)", "warn");
			this.pointerUp(event);
		});
		this.registerDomEvent(
			this.pagesEl,
			"wheel",
			(e) => {
				if ((e.ctrlKey || e.metaKey) && e.deltaY) {
					e.preventDefault();
					this.setZoom(this.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX, e.clientY);
				}
			},
			{ passive: false },
		);
		this.registerDomEvent(this.contentEl, "keydown", (e) => this.handleKeydown(e));
		this.contentEl.tabIndex = 0;
		this.scroller.addEventListener("touchstart", this.touchStart, { passive: false });
		this.scroller.addEventListener("touchmove", this.touchMove, { passive: false });
		// Obsidian mobile opens sidebars on horizontal swipes; writing or panning a page must not.
		for (const type of ["touchstart", "touchmove", "touchend"] as const) {
			this.registerDomEvent(this.scroller, type, (e: TouchEvent) => e.stopPropagation(), { passive: true });
		}
		this.registerEvent(
			(this.app.vault as any).on("raw", (path: string) => {
				if (path === this.sidecarPath) void this.readExternalSidecar();
			}),
		);
	}

	getViewType(): string {
		return PDF_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.basename ?? "PDF Notebook";
	}

	getIcon(): string {
		return "book-open";
	}

	canAcceptExtension(ext: string): boolean {
		return ext === "pdf";
	}

	async onLoadFile(file: TFile): Promise<void> {
		const load = ++this.loadGeneration;
		// A newer onLoadFile (user switched PDFs mid-load) makes this one obsolete.
		const stale = () => load !== this.loadGeneration || this.file !== file;
		await this.flushSave();
		if (stale()) return;
		this.clearDocument();
		this.disposed = false;
		this.sidecarPath = `${file.path}.goodnodes.json`;
		this.loadStartedAt = performance.now();
		try {
			this.pdfjs = await loadPdfJs();
			debug.log(`pdf.js ${this.pdfjs?.version ?? "version unavailable"}`);
			const data = await this.app.vault.readBinary(file);
			if (stale()) return;
			const doc = await this.pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
			if (stale()) {
				void doc.destroy();
				return;
			}
			this.doc = doc;
			const first = await this.doc.getPage(1);
			if (stale()) return;
			const viewport = first.getViewport({ scale: 1 });
			this.baseWidth = viewport.width;
			this.baseHeight = viewport.height;
			this.pageScale = this.fitScale();
			// pdf.js transfers (detaches) `data` to its worker, so take the size from the file.
			await this.loadSidecar(file, file.stat.size);
			if (stale()) return;
			this.buildSlots();
			if (this.restoredSidebar) {
				const tab = this.restoredSidebar;
				this.restoredSidebar = null;
				this.toggleSidebar(tab);
			}
			// Refit once the page list exists: a vertical scrollbar may have taken some width.
			requestAnimationFrame(() => this.onResize());
			this.observe();
			this.restorePage(this.currentPage);
			this.scheduleUpdate();
		} catch (err) {
			debug.error("PDF load failed", err);
		}
	}

	async onUnloadFile(_file: TFile): Promise<void> {
		await this.flushSave();
		this.clearDocument();
	}

	async onClose(): Promise<void> {
		await this.flushSave();
	}

	private buildToolbar(): void {
		this.iconButton(this.historyToolbar, "undo-2", "Undo", () => this.undo());
		this.iconButton(this.historyToolbar, "redo-2", "Redo", () => this.redo());
		this.iconButton(this.toolbar, "panel-left", "Pages sidebar", () => this.toggleSidebar());
		this.toolbar.createDiv({ cls: "goodnodes-pdf-toolbar-separator" });
		this.toolButton("pen", "pen-line", "Pen");
		this.toolButton("highlighter", "highlighter", "Highlighter");
		this.toolButton("eraser", "eraser", "Eraser");
		this.toolbar.createDiv({ cls: "goodnodes-pdf-toolbar-separator" });
		const bookmark = this.iconButton(this.toolbar, "bookmark", "Bookmark page", () =>
			this.toggleBookmark(this.currentPage),
		);
		bookmark.dataset.action = "bookmark";
		this.iconButton(this.toolbar, "more-horizontal", "More", (event?: MouseEvent) => this.showMore(event));
		this.updateToolbar();
	}

	private toolButton(tool: Tool, icon: string, label: string): void {
		const button = this.toolbar.createEl("button", {
			cls: "goodnodes-pdf-tool",
			attr: { "aria-label": label, title: label },
		});
		setIcon(button, icon);
		button.dataset.tool = tool;
		button.onclick = () => {
			if (this.toolState.tool === tool) this.openToolPopover(button, tool);
			else {
				this.closePopover();
				this.selectTool(tool);
			}
		};
	}

	private iconButton(
		parent: HTMLElement,
		icon: string,
		title: string,
		action: (event?: MouseEvent) => void,
		cls?: string,
	): HTMLButtonElement {
		const button = parent.createEl("button", { cls, attr: { title, "aria-label": title } });
		setIcon(button, icon);
		button.onclick = (event) => action(event);
		return button;
	}

	private updateToolbar(): void {
		this.toolbar
			.querySelectorAll<HTMLElement>("[data-tool]")
			.forEach((button) => button.toggleClass("is-active", button.dataset.tool === this.toolState.tool));
		for (const tool of ["pen", "highlighter"] as const) {
			const button = this.toolbar.querySelector<HTMLElement>(`[data-tool="${tool}"]`);
			if (!button) continue;
			const color = tool === "pen" ? this.plugin.settings.penColor : this.plugin.settings.highlighterColor;
			button.style.setProperty("--goodnodes-tool-color", color);
			button.toggleClass("has-color", true);
		}
		const bookmark = this.toolbar.querySelector<HTMLElement>('[data-action="bookmark"]');
		if (bookmark) {
			const active = this.bookmarks.has(this.currentPage);
			bookmark.toggleClass("is-bookmarked", active);
			bookmark.setAttribute("aria-label", active ? "Remove bookmark" : "Bookmark page");
			bookmark.setAttribute("title", active ? "Remove bookmark" : "Bookmark page");
			setIcon(bookmark, active ? "bookmark-check" : "bookmark");
		}
	}

	private selectTool(tool: Tool): void {
		sessionTool = tool;
		this.toolState.tool = tool;
		this.toolState.color =
			tool === "highlighter" ? this.plugin.settings.highlighterColor : this.plugin.settings.penColor;
		this.toolState.width =
			tool === "highlighter" ? this.plugin.settings.highlighterWidth : this.plugin.settings.penWidth;
		this.updateToolbar();
	}

	private showMore(event?: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Zoom in")
				.setIcon("zoom-in")
				.onClick(() => this.setZoom(this.zoom * 1.2)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Zoom out")
				.setIcon("zoom-out")
				.onClick(() => this.setZoom(this.zoom / 1.2)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Fit width")
				.setIcon("maximize")
				.onClick(() => this.setZoom(1)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Go to page…")
				.setIcon("file-search")
				.onClick(() => this.openPageModal()),
		);
		menu.addItem((item) =>
			item
				.setTitle("Export PDF with notes")
				.setIcon("file-down")
				.onClick(() => void this.exportAnnotated()),
		);
		if (event) menu.showAtMouseEvent(event);
		else
			menu.showAtPosition({
				x: this.toolbar.getBoundingClientRect().right,
				y: this.toolbar.getBoundingClientRect().bottom,
			});
	}

	private openToolPopover(anchor: HTMLElement, tool: Tool): void {
		this.closePopover();
		const popover = this.contentEl.createDiv({ cls: `goodnodes-pdf-popover goodnodes-pdf-popover-${tool}` });
		this.popover = popover;
		const settings = this.plugin.settings;
		const colors = tool === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS;
		if (tool !== "eraser") {
			const row = popover.createDiv({ cls: "goodnodes-pdf-popover-colors" });
			for (const color of [...colors, "custom"]) {
				const current = tool === "highlighter" ? settings.highlighterColor : settings.penColor;
				const swatch = row.createEl("button", {
					cls: "goodnodes-pdf-swatch",
					attr: { title: color === "custom" ? "Custom color" : color },
				});
				if (color === "custom") {
					swatch.addClass("is-custom");
					const input = swatch.createEl("input", { attr: { type: "color", value: current } });
					input.oninput = () => this.applyToolColor(tool, input.value);
				} else swatch.style.setProperty("--goodnodes-swatch", color);
				swatch.toggleClass("is-active", color === current.toLowerCase());
				if (color !== "custom") swatch.onclick = () => this.applyToolColor(tool, color);
			}
		}
		const widths =
			tool === "highlighter" ? [1.6, 2.4, 3.6] : tool === "eraser" ? [6, 10, 16] : [0.8, 1.4, 2, 3, 4.5];
		const widthRow = popover.createDiv({ cls: "goodnodes-pdf-popover-widths" });
		const currentWidth =
			tool === "eraser"
				? settings.eraserSize
				: tool === "highlighter"
					? settings.highlighterWidth
					: settings.penWidth;
		for (const width of widths) {
			const button = widthRow.createEl("button", {
				attr: { title: tool === "eraser" ? `${width}px radius` : `${width} pt` },
			});
			button.toggleClass("is-active", width === currentWidth);
			const sample = button.createSpan({ cls: "goodnodes-pdf-width-sample" });
			sample.style.setProperty(
				"--goodnodes-sample-width",
				`${Math.min(18, tool === "eraser" ? width : width * 2)}px`,
			);
			sample.style.setProperty(
				"--goodnodes-tool-color",
				tool === "highlighter" ? settings.highlighterColor : settings.penColor,
			);
			button.onclick = () => this.applyToolWidth(tool, width);
		}
		const rect = anchor.getBoundingClientRect();
		popover.style.left = `${Math.max(8, Math.min(window.innerWidth - popover.offsetWidth - 8, rect.left + rect.width / 2 - popover.offsetWidth / 2))}px`;
		popover.style.top = `${Math.max(8, Math.min(window.innerHeight - popover.offsetHeight - 8, rect.bottom + 8))}px`;
		const outside = (event: PointerEvent) => {
			if (!popover.contains(event.target as Node) && !anchor.contains(event.target as Node)) this.closePopover();
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") this.closePopover();
		};
		window.addEventListener("pointerup", outside, true);
		window.addEventListener("keydown", escape, true);
		(popover as any).__cleanup = () => {
			window.removeEventListener("pointerup", outside, true);
			window.removeEventListener("keydown", escape, true);
		};
	}

	private closePopover(): void {
		if (!this.popover) return;
		(this.popover as any).__cleanup?.();
		this.popover.remove();
		this.popover = null;
	}

	private applyToolColor(tool: InkTool, color: string): void {
		if (tool === "highlighter") {
			this.plugin.settings.highlighterColor = color;
			this.toolState.color = color;
		} else {
			this.plugin.settings.penColor = color;
			this.toolState.color = color;
		}
		this.updateToolbar();
		this.scheduleSettingsSave();
	}

	private applyToolWidth(tool: Tool, width: number): void {
		if (tool === "eraser") this.plugin.settings.eraserSize = width;
		else if (tool === "highlighter") {
			this.plugin.settings.highlighterWidth = width;
			this.toolState.width = width;
		} else {
			this.plugin.settings.penWidth = width;
			this.toolState.width = width;
		}
		this.scheduleSettingsSave();
		const anchor = this.toolbar.querySelector<HTMLElement>(`[data-tool="${tool}"]`);
		if (anchor) this.openToolPopover(anchor, tool);
	}

	private scheduleSettingsSave(): void {
		if (this.settingsTimer !== null) window.clearTimeout(this.settingsTimer);
		this.settingsTimer = window.setTimeout(async () => {
			this.settingsTimer = null;
			await this.plugin.saveSettings();
		}, 300);
	}

	private fitScale(): number {
		// 16px page margins on each side plus a little slack so no horizontal scrollbar appears at zoom 1.
		const availableWidth = Math.min(1100, Math.max(100, this.scroller.clientWidth - 40));
		return Math.max(0.1, availableWidth / this.baseWidth);
	}

	private buildSlots(): void {
		this.observer?.disconnect();
		this.slots = [];
		this.pagesEl.empty();
		for (let i = 0; i < this.doc.numPages; i++) {
			const el = this.pagesEl.createDiv({ cls: "goodnodes-pdf-page" });
			el.dataset.page = String(i);
			el.style.width = `${this.baseWidth * this.pageScale * this.zoom}px`;
			el.style.height = `${this.baseHeight * this.pageScale * this.zoom}px`;
			this.slots.push({
				el,
				width: this.baseWidth,
				height: this.baseHeight,
				unrotatedWidth: this.baseWidth,
				unrotatedHeight: this.baseHeight,
				rotation: 0,
			});
		}
	}

	private observe(): void {
		this.observer?.disconnect();
		this.observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const page = Number((entry.target as HTMLElement).dataset.page);
					if (entry.isIntersecting) this.visible.add(page);
					else this.visible.delete(page);
				}
				this.scheduleUpdate();
			},
			{ root: this.scroller, rootMargin: `${Math.max(500, this.scroller.clientHeight)}px 0px` },
		);
		for (const slot of this.slots) this.observer.observe(slot.el);
	}

	private scheduleUpdate(): void {
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			this.updateVisible();
		});
	}

	private updateVisible(): void {
		if (!this.doc || !this.slots.length) return;
		// Hidden, detached or not yet laid out: positions are meaningless (would "jump" to a
		// wrong page and save it), and a pending restore must win.
		if (!this.scroller.isConnected || this.scroller.clientHeight === 0 || this.pendingRestore !== null) return;
		const center = this.scroller.scrollTop + this.scroller.clientHeight / 2;
		let current = 0,
			best = Infinity;
		this.slots.forEach((slot, i) => {
			const distance = Math.abs(slot.el.offsetTop + slot.el.offsetHeight / 2 - center);
			if (distance < best) {
				best = distance;
				current = i;
			}
		});
		const pageChanged = this.currentPage !== current;
		if (pageChanged) this.markDirty();
		this.currentPage = current;
		this.indicator.setText(`${current + 1} / ${this.slots.length}`);
		this.updateSidebarSelection();
		if (pageChanged && this.sidebarTab === "pages") this.scrollSidebarToCurrent();
		this.updateScrubber();
		const selected = new Set<number>();
		for (let i = Math.max(0, current - 2); i <= Math.min(this.slots.length - 1, current + 2); i++) selected.add(i);
		this.visible = selected;
		for (const i of selected) if (!this.slots[i].canvas && !this.slots[i].busy) this.queue.push(i);
		this.queue = [...new Set(this.queue)].sort((a, b) => Math.abs(a - current) - Math.abs(b - current));
		for (let i = 0; i < this.slots.length; i++) {
			if (Math.abs(i - current) > 4) this.release(i);
			else if (!selected.has(i)) this.slots[i].task?.cancel?.();
		}
		this.pump();
		this.scheduleSave();
	}

	private pump(): void {
		while (this.running < 2 && this.queue.length) {
			const index = this.queue.shift()!;
			if (!this.visible.has(index) || this.slots[index].canvas || this.slots[index].busy) continue;
			this.running++;
			this.slots[index].busy = true;
			void this.renderPage(index).finally(() => {
				this.running--;
				this.slots[index].busy = false;
				this.pump();
			});
		}
	}

	private async renderPage(index: number): Promise<void> {
		if (!this.doc || this.disposed) return;
		const started = performance.now();
		let canvas: HTMLCanvasElement | undefined;
		try {
			const page = this.loaded.get(index) ?? (await this.doc.getPage(index + 1));
			this.loaded.set(index, page);
			const raw = page.getViewport({ scale: 1 });
			const unrotated = page.getViewport({ scale: 1, rotation: 0 });
			this.slots[index].rotation = raw.rotation ?? page.rotate ?? 0;
			this.slots[index].unrotatedWidth = unrotated.width;
			this.slots[index].unrotatedHeight = unrotated.height;
			if (Math.abs(raw.width - this.baseWidth) > 1 || Math.abs(raw.height - this.baseHeight) > 1) {
				const anchor = this.topAnchor();
				const slot = this.slots[index];
				slot.width = raw.width;
				slot.height = raw.height;
				slot.el.style.width = `${raw.width * this.pageScale * this.zoom}px`;
				slot.el.style.height = `${raw.height * this.pageScale * this.zoom}px`;
				this.restoreAnchor(anchor);
			}
			const scale = this.pageScale * this.zoom;
			const viewport = page.getViewport({ scale });
			const dpr = Math.max(1, window.devicePixelRatio || 1);
			const pixelScale = Math.min(dpr, Math.sqrt(4_000_000 / (viewport.width * viewport.height)));
			canvas = document.createElement("canvas");
			canvas.className = "goodnodes-pdf-canvas";
			canvas.width = Math.max(1, Math.floor(viewport.width * pixelScale));
			canvas.height = Math.max(1, Math.floor(viewport.height * pixelScale));
			canvas.style.width = `${viewport.width}px`;
			canvas.style.height = `${viewport.height}px`;
			const ctx = canvas.getContext("2d", { alpha: false })!;
			const task = page.render({
				canvasContext: ctx,
				viewport: pixelScale === 1 ? viewport : page.getViewport({ scale: scale * pixelScale }),
			});
			this.slots[index].task = task;
			this.slots[index].el.appendChild(canvas);
			await task.promise;
			if (this.disposed || !this.visible.has(index)) {
				canvas.width = canvas.height = 0;
				canvas.remove();
				return;
			}
			const ink = this.makeOverlay(canvas, "goodnodes-pdf-ink");
			const live = this.makeOverlay(canvas, "goodnodes-pdf-live");
			live.width = live.height = 0;
			this.slots[index].el.append(ink, live);
			this.slots[index].canvas = canvas;
			this.slots[index].ink = ink;
			this.slots[index].live = live;
			this.slots[index].page = page;
			this.slots[index].task = undefined;
			this.drawCommittedInk(index);
			this.logCanvasStats();
			const jump = this.jumpStarted.get(index);
			if (jump) {
				debug.log(`Jump page ${index + 1} to first render ${(performance.now() - jump).toFixed(1)} ms`);
				this.jumpStarted.delete(index);
			}
			if (index === 0)
				debug.log(
					`First PDF page rendered ${(performance.now() - this.loadStartedAt).toFixed(1)} ms total (${(performance.now() - started).toFixed(1)} ms render)`,
				);
		} catch (err) {
			if (canvas) {
				canvas.width = canvas.height = 0;
				canvas.remove();
			}
			if ((err as Error)?.name !== "RenderingCancelledException")
				debug.error(`PDF page ${index + 1} render failed`, err);
		}
	}

	private makeOverlay(base: HTMLCanvasElement, className: string): HTMLCanvasElement {
		const canvas = document.createElement("canvas");
		canvas.className = className;
		// Ink is as sharp as the page itself (≤ 4 MP, see renderPage); the live layer is
		// sized lazily in drawLive and freed after each stroke.
		const scale = 1;
		canvas.width = Math.max(1, Math.floor(base.width * scale));
		canvas.height = Math.max(1, Math.floor(base.height * scale));
		canvas.style.width = base.style.width;
		canvas.style.height = base.style.height;
		return canvas;
	}

	private release(index: number): void {
		const slot = this.slots[index];
		if (!slot) return;
		slot.task?.cancel?.();
		slot.task = undefined;
		for (const key of ["canvas", "ink", "live"] as const) {
			const canvas = slot[key];
			if (canvas) {
				canvas.width = canvas.height = 0;
				canvas.remove();
				slot[key] = undefined;
			}
		}
		(slot.page ?? this.loaded.get(index))?.cleanup?.();
		this.loaded.delete(index);
		slot.page = undefined;
		this.logCanvasStats();
	}

	private logCanvasStats(): void {
		let count = 0,
			pixels = 0;
		for (const slot of this.slots)
			if (slot.canvas) {
				count++;
				pixels += slot.canvas.width * slot.canvas.height;
			}
		debug.live.pdf = `${count} live page canvases · ${(pixels / 1_000_000).toFixed(1)} MP`;
	}

	private topAnchor(): { index: number; offset: number } {
		const y = this.scroller.scrollTop;
		let index = this.slots.findIndex((slot) => slot.el.offsetTop + slot.el.offsetHeight >= y);
		if (index < 0) index = 0;
		return { index, offset: y - this.slots[index].el.offsetTop };
	}

	private restoreAnchor(anchor: { index: number; offset: number }): void {
		const slot = this.slots[anchor.index];
		if (slot) this.scroller.scrollTop = slot.el.offsetTop + anchor.offset;
	}

	private setZoom(value: number, clientX?: number, clientY?: number): void {
		const next = Math.max(0.5, Math.min(4, value));
		if (Math.abs(next - this.zoom) < 0.001) return;
		this.relayout(() => (this.zoom = next), clientX, clientY);
		this.markDirty();
	}

	private updateScrubber(): void {
		const max = Math.max(1, this.scroller.scrollHeight - this.scroller.clientHeight);
		const fraction = this.scroller.scrollTop / max;
		const available = Math.max(0, this.scrubber.clientHeight - this.scrubberThumb.offsetHeight);
		const offset = fraction * available;
		this.scrubberThumb.style.transform = `translateY(${offset}px)`;
		this.scrubberBubble.style.transform = `translateY(${offset}px)`;
		const page = this.currentPage + 1;
		this.scrubberBubble.setText(`Page ${page} / ${this.slots.length}`);
	}

	private showScrubber(): void {
		this.scrubber.addClass("is-visible");
		if (this.scrubberTimer !== null) window.clearTimeout(this.scrubberTimer);
		if (!this.scrubberDragging)
			this.scrubberTimer = window.setTimeout(() => this.scrubber.removeClass("is-visible"), 1500);
	}

	private scrubberDown(event: PointerEvent): void {
		if (!this.slots.length) return;
		event.preventDefault();
		event.stopPropagation();
		this.scrubberPointer = event.pointerId;
		this.scrubber.setPointerCapture(event.pointerId);
		this.scrubberDragging = true;
		this.scrubber.addClass("is-visible");
		this.scrubberPendingY = event.clientY;
		this.applyScrubberPosition(event.clientY);
	}

	private scrubberMove(event: PointerEvent): void {
		if (!this.scrubberDragging || event.pointerId !== this.scrubberPointer) return;
		event.preventDefault();
		this.scrubberPendingY = event.clientY;
		if (this.scrubberRaf) return;
		this.scrubberRaf = requestAnimationFrame(() => {
			this.scrubberRaf = 0;
			this.applyScrubberPosition(this.scrubberPendingY);
		});
	}

	private applyScrubberPosition(clientY: number): void {
		const rect = this.scrubber.getBoundingClientRect();
		const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
		this.scroller.scrollTop = ratio * (this.scroller.scrollHeight - this.scroller.clientHeight);
		this.scrubberBubble.setText(`Page ${this.currentPage + 1} / ${this.slots.length}`);
	}

	private scrubberUp(event: PointerEvent): void {
		if (!this.scrubberDragging || event.pointerId !== this.scrubberPointer) return;
		this.scrubberDragging = false;
		this.scrubberPointer = 0;
		this.showScrubber();
	}

	/** Pages fit the view width at zoom 1; refit when the view is resized (rotation, sidebars). */
	onResize(): void {
		if (!this.doc || !this.slots.length || this.scroller.clientWidth === 0) return;
		const next = this.fitScale();
		if (Math.abs(next - this.pageScale) >= 0.001) {
			if (this.pendingRestore !== null) {
				// Nothing on screen to anchor yet: just rescale, the restore scrolls afterwards.
				this.pageScale = next;
				for (const slot of this.slots) {
					slot.el.style.width = `${slot.width * this.pageScale * this.zoom}px`;
					slot.el.style.height = `${slot.height * this.pageScale * this.zoom}px`;
				}
			} else {
				this.relayout(() => (this.pageScale = next));
			}
		}
		this.applyPendingRestore();
	}

	/** Change page scale/zoom while keeping the content under (clientX, clientY) in place. */
	private relayout(change: () => void, clientX?: number, clientY?: number): void {
		const rect = this.scroller.getBoundingClientRect();
		const screenX = clientX ?? rect.left + this.scroller.clientWidth / 2;
		const screenY = clientY ?? rect.top + this.scroller.clientHeight / 2;
		const anchor = this.zoomAnchor(screenX, screenY);
		change();
		this.releaseAll();
		for (const slot of this.slots) {
			slot.el.style.width = `${slot.width * this.pageScale * this.zoom}px`;
			slot.el.style.height = `${slot.height * this.pageScale * this.zoom}px`;
		}
		this.applyZoomAnchor(anchor, screenX, screenY);
		this.scheduleUpdate();
	}

	private zoomAnchor(clientX: number, clientY: number): ZoomAnchor {
		const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>(".goodnodes-pdf-page");
		const page = target ? Number(target.dataset.page) : this.currentPage;
		const slot = this.slots[page];
		if (!slot) return { page: 0, x: 0, y: 0 };
		const rect = slot.el.getBoundingClientRect();
		const scale = this.pageScale * this.zoom;
		return { page, x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
	}

	private applyZoomAnchor(anchor: ZoomAnchor, clientX: number, clientY: number): void {
		const slot = this.slots[anchor.page];
		if (!slot) return;
		const rect = slot.el.getBoundingClientRect();
		this.scroller.scrollLeft += rect.left + anchor.x * this.pageScale * this.zoom - clientX;
		this.scroller.scrollTop += rect.top + anchor.y * this.pageScale * this.zoom - clientY;
	}

	private releaseAll(): void {
		for (const index of this.slots.keys()) this.release(index);
	}

	private pointerDown(event: PointerEvent): void {
		debug.pointer("pdf", event);
		if (event.pointerType === "pen") this.penUntil = Date.now() + 250;
		if (event.pointerType === "touch") {
			if (this.penDown || Date.now() < this.penUntil) {
				this.ignoredTouches.add(event.pointerId);
				return;
			}
			const maxTouchSize = this.plugin.settings.palmMaxTouchSize;
			if (maxTouchSize > 0 && Math.max(event.width, event.height) > maxTouchSize) {
				this.ignoredTouches.add(event.pointerId);
				return;
			}
			this.pointers.set(event.pointerId, event);
			if (this.touchPointerCount() >= 2) this.startPinch();
			return;
		}
		this.pointers.set(event.pointerId, event);
		if (event.pointerType !== "pen" && event.pointerType !== "mouse") return;
		if (event.pointerType === "pen") this.penDown = true;
		const hit = this.pageAt(event);
		if (!hit) return;
		this.activeStroke = { pointerId: event.pointerId, page: hit[0], points: [hit[1]], tool: this.toolState.tool };
		try {
			(event.target as HTMLElement).setPointerCapture(event.pointerId);
		} catch {
			/* The page may unload mid-gesture. */
		}
		event.preventDefault();
		this.drawLive(this.activeStroke.page);
	}

	private pointerMove(event: PointerEvent): void {
		debug.pointer("pdf", event);
		if (event.pointerType === "touch" && this.pointers.has(event.pointerId)) {
			this.pointers.set(event.pointerId, event);
			if (this.touchPointerCount() >= 2 && Date.now() >= this.penUntil) this.updatePinch();
			return;
		}
		if (event.pointerType === "touch" && this.ignoredTouches.has(event.pointerId)) return;
		if (!this.activeStroke || event.pointerId !== this.activeStroke.pointerId) return;
		const events = event.getCoalescedEvents?.() ?? [event];
		for (const item of events) {
			const hit = this.pageAt(item);
			if (hit && hit[0] === this.activeStroke.page) this.activeStroke.points.push(hit[1]);
		}
		this.drawLive(this.activeStroke.page);
		event.preventDefault();
	}

	private pointerUp(event: PointerEvent): void {
		debug.pointer("pdf", event);
		if (event.pointerType === "pen") this.penUntil = Date.now() + 250;
		if (event.pointerType === "pen") this.penDown = false;
		this.ignoredTouches.delete(event.pointerId);
		this.pointers.delete(event.pointerId);
		if (this.pinch && this.touchPointerCount() < 2) this.endPinch();
		if (!this.activeStroke || event.pointerId !== this.activeStroke.pointerId) return;
		const { page, points, tool } = this.activeStroke;
		this.activeStroke = null;
		if (tool === "eraser") this.commitEraser(page, points);
		else this.commitInk(page, points, tool);
		// The live layer only exists while a stroke is in progress (saves a full-page canvas per page).
		const live = this.slots[page]?.live;
		if (live) live.width = live.height = 0;
	}

	private pageAt(event: PointerEvent): [number, InkPoint] | null {
		const pageEl = (event.target as HTMLElement).closest<HTMLElement>(".goodnodes-pdf-page");
		if (!pageEl) return null;
		const page = Number(pageEl.dataset.page),
			rect = pageEl.getBoundingClientRect();
		const scale = this.pageScale * this.zoom;
		const slot = this.slots[page];
		const screenX = (event.clientX - rect.left) / scale,
			screenY = (event.clientY - rect.top) / scale;
		const [x, y] = displayedToUnrotated(screenX, screenY, {
			width: slot.unrotatedWidth,
			height: slot.unrotatedHeight,
			rotation: slot.rotation,
		});
		return [page, [round(x), round(y), round(event.pressure || 0.5)]];
	}

	private commitInk(page: number, points: InkPoint[], tool: InkTool): void {
		if (!points.length) return;
		const stroke: InkStroke = {
			id: newStrokeId(),
			tool,
			color: this.toolState.color,
			width: this.toolState.width,
			points,
		};
		const existing = this.strokes.get(page) ?? [];
		if (tool === "pen" && this.plugin.settings.scratchEnabled) {
			const candidates = existing.map((item) => ({
				id: item.id,
				points: item.points.map(([x, y]) => ({ x, y })),
			}));
			const ids = findScratchedStrokes(
				points.map(([x, y]) => ({ x, y })),
				candidates,
				{
					minReversals: this.plugin.settings.scratchMinReversals,
					coverage: this.plugin.settings.scratchCoverage,
				},
			);
			debug.log(
				`PDF scratch page ${page + 1}: candidates=${candidates.length} removed=${ids.join(",") || "none"}`,
			);
			if (ids.length) {
				const removed = existing.filter((item) => ids.includes(item.id));
				this.strokes.set(
					page,
					existing.filter((item) => !ids.includes(item.id)),
				);
				this.history.push({ page, added: [], removed });
				this.changed(page);
				return;
			}
		}
		this.strokes.set(page, [...existing, stroke]);
		this.history.push({ page, added: [stroke], removed: [] });
		this.changed(page);
	}

	private commitEraser(page: number, points: InkPoint[]): void {
		const existing = this.strokes.get(page) ?? [];
		const ids = new Set(
			findEraserHits(points, existing, this.plugin.settings.eraserSize / (this.pageScale * this.zoom)),
		);
		if (!ids.size) return;
		const removed = existing.filter((stroke) => ids.has(stroke.id));
		this.strokes.set(
			page,
			existing.filter((stroke) => !ids.has(stroke.id)),
		);
		this.history.push({ page, added: [], removed });
		this.changed(page);
	}

	private changed(page: number): void {
		this.markDirty();
		this.drawCommittedInk(page);
		this.updateHistoryButtons();
		this.scheduleSave();
	}

	private drawCommittedInk(page: number): void {
		const canvas = this.slots[page]?.ink;
		if (!canvas) return;
		const ctx = canvas.getContext("2d")!;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		for (const stroke of this.strokes.get(page) ?? []) this.paintStroke(ctx, stroke, canvas);
	}

	private drawLive(page: number): void {
		const slot = this.slots[page];
		const canvas = slot?.live;
		if (!canvas) return;
		if (canvas.width === 0 && slot.ink) {
			canvas.width = slot.ink.width;
			canvas.height = slot.ink.height;
		}
		const ctx = canvas.getContext("2d")!;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		if (this.activeStroke?.page !== page) return;
		if (this.activeStroke.tool === "eraser") {
			const last = this.activeStroke.points[this.activeStroke.points.length - 1];
			const slot = this.slots[page];
			const scale = this.pageScale * this.zoom;
			// canvas pixels per CSS pixel; page units → CSS pixels is `scale`.
			const factor = canvas.width / (slot.width * scale);
			const [displayX, displayY] = unrotatedToDisplayed(last[0], last[1], rotationInfo(slot));
			ctx.beginPath();
			ctx.arc(
				displayX * scale * factor,
				displayY * scale * factor,
				this.plugin.settings.eraserSize * factor,
				0,
				Math.PI * 2,
			);
			ctx.strokeStyle = "rgba(30,30,30,.65)";
			ctx.lineWidth = 1.5 * factor;
			ctx.stroke();
			return;
		}
		const stroke: InkStroke = {
			id: "live",
			tool: this.activeStroke.tool,
			color: this.toolState.color,
			width: this.toolState.width,
			points: this.activeStroke.points,
		};
		this.paintStroke(ctx, stroke, canvas);
	}

	private paintStroke(ctx: CanvasRenderingContext2D, stroke: InkStroke, canvas: HTMLCanvasElement): void {
		const slot = this.slots[Number(canvas.parentElement?.dataset.page)];
		const scale = this.pageScale * this.zoom;
		const factor = canvas.width / ((slot?.width ?? this.baseWidth) * scale);
		const smooth = this.plugin.settings.smoothing;
		const points = stroke.points.map(([x, y, pressure]) => {
			const [displayX, displayY] = slot ? unrotatedToDisplayed(x, y, rotationInfo(slot)) : [x, y];
			return [displayX * scale * factor, displayY * scale * factor, pressure];
		});
		const width = stroke.width * scale * factor;
		if (stroke.tool === "highlighter") {
			ctx.save();
			ctx.globalCompositeOperation = "multiply";
			ctx.globalAlpha = 0.35;
			ctx.strokeStyle = stroke.color;
			ctx.lineWidth = Math.max(1, width * 5);
			ctx.lineCap = "butt";
			ctx.lineJoin = "bevel";
			ctx.beginPath();
			points.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
			ctx.stroke();
			ctx.restore();
			return;
		}
		const outline = getStroke(points, {
			size: width,
			thinning: 0.6,
			smoothing: smooth ? 0.5 : 0,
			streamline: smooth ? 0.5 : 0,
		});
		if (!outline.length) return;
		ctx.beginPath();
		ctx.moveTo(outline[0][0], outline[0][1]);
		for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]);
		ctx.closePath();
		ctx.fillStyle = stroke.color;
		ctx.fill();
	}

	private touchPointerCount(): number {
		return [...this.pointers.values()].filter((pointer) => pointer.pointerType === "touch").length;
	}

	private blockStylusTouch(event: TouchEvent): void {
		if ([...event.changedTouches].some((touch) => (touch as any).touchType === "stylus")) event.preventDefault();
	}

	private startPinch(): void {
		const points = [...this.pointers.values()].filter((pointer) => pointer.pointerType === "touch").slice(-2);
		if (points.length < 2) return;
		const dx = points[1].clientX - points[0].clientX,
			dy = points[1].clientY - points[0].clientY;
		const centerX = (points[0].clientX + points[1].clientX) / 2,
			centerY = (points[0].clientY + points[1].clientY) / 2;
		const anchor = this.zoomAnchor(centerX, centerY);
		const pagesRect = this.pagesEl.getBoundingClientRect();
		this.pinch = {
			distance: Math.hypot(dx, dy),
			zoom: this.zoom,
			originX: centerX,
			originY: centerY,
			centerX,
			centerY,
			anchor,
			visualScale: 1,
		};
		this.pagesEl.style.transformOrigin = `${centerX - pagesRect.left}px ${centerY - pagesRect.top}px`;
	}

	private updatePinch(): void {
		if (!this.pinch) this.startPinch();
		if (!this.pinch) return;
		const points = [...this.pointers.values()].filter((pointer) => pointer.pointerType === "touch").slice(-2);
		if (points.length < 2) return;
		const dx = points[1].clientX - points[0].clientX,
			dy = points[1].clientY - points[0].clientY;
		this.pinch.centerX = (points[0].clientX + points[1].clientX) / 2;
		this.pinch.centerY = (points[0].clientY + points[1].clientY) / 2;
		this.pinch.visualScale = Math.max(
			0.5 / this.pinch.zoom,
			Math.min(4 / this.pinch.zoom, Math.hypot(dx, dy) / this.pinch.distance),
		);
		this.pagesEl.style.transform = `translate(${this.pinch.centerX - this.pinch.originX}px, ${this.pinch.centerY - this.pinch.originY}px) scale(${this.pinch.visualScale})`;
	}

	private endPinch(): void {
		if (!this.pinch) return;
		const gesture = this.pinch;
		this.pagesEl.style.transform = "";
		this.pagesEl.style.transformOrigin = "";
		this.zoom = Math.max(0.5, Math.min(4, gesture.zoom * gesture.visualScale));
		this.markDirty();
		this.releaseAll();
		for (const slot of this.slots) {
			slot.el.style.width = `${slot.width * this.pageScale * this.zoom}px`;
			slot.el.style.height = `${slot.height * this.pageScale * this.zoom}px`;
		}
		this.applyZoomAnchor(gesture.anchor, gesture.centerX, gesture.centerY);
		this.pinch = null;
		this.markDirty();
		this.scheduleUpdate();
	}

	private undo(): void {
		const entry = this.history.undo(this.strokes);
		if (entry) {
			this.jumpTo(entry.page);
			this.changed(entry.page);
		}
		this.updateHistoryButtons();
	}

	private redo(): void {
		const entry = this.history.redo(this.strokes);
		if (entry) {
			this.jumpTo(entry.page);
			this.changed(entry.page);
		}
		this.updateHistoryButtons();
	}

	private updateHistoryButtons(): void {
		const buttons = this.historyToolbar.querySelectorAll("button");
		if (buttons[0]) (buttons[0] as HTMLButtonElement).disabled = !this.history.canUndo;
		if (buttons[1]) (buttons[1] as HTMLButtonElement).disabled = !this.history.canRedo;
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
		event.preventDefault();
		if (event.shiftKey) this.redo();
		else this.undo();
	}

	private openPageModal(): void {
		const modal = new PageModal(this.app, this.slots.length, (page) => this.jumpTo(page - 1), this.currentPage + 1);
		modal.open();
	}

	private jumpTo(index: number): void {
		if (index < 0 || index >= this.slots.length) return;
		if (this.slots[index].canvas) debug.log(`Jump page ${index + 1} to first render 0.0 ms (already rendered)`);
		else this.jumpStarted.set(index, performance.now());
		this.scroller.scrollTop = this.slots[index].el.offsetTop;
		this.visible.add(index);
		this.scheduleUpdate();
	}

	private async loadOutline(): Promise<void> {
		if (!this.doc || !this.sidebarContent) return;
		try {
			const outline = await this.doc.getOutline();
			if (!this.sidebarContent || this.sidebarTab !== "outline") return;
			this.sidebarContent.empty();
			this.outlineItems = [];
			if (!outline?.length) {
				this.sidebarContent.createDiv({ cls: "goodnodes-pdf-empty", text: "This PDF has no outline" });
				return;
			}
			const add = (item: any, depth: number) => {
				const row = this.sidebarContent!.createDiv({ cls: "goodnodes-pdf-outline-item" });
				row.createSpan({ text: item.title });
				const pageLabel = row.createSpan({ cls: "goodnodes-pdf-outline-page" });
				row.style.paddingLeft = `${12 + depth * 14}px`;
				row.onclick = () => void this.outlineJump(item);
				const record = { row, page: null as number | null };
				this.outlineItems.push(record);
				void this.outlinePage(item).then((page) => {
					if (page !== null) {
						pageLabel.setText(String(page + 1));
						record.page = page;
						this.updateSidebarSelection();
					}
				});
				for (const child of item.items ?? []) add(child, depth + 1);
			};
			for (const item of outline) add(item, 0);
		} catch (err) {
			debug.log(`PDF outline unavailable: ${String(err)}`, "warn");
			this.sidebarContent?.createDiv({ cls: "goodnodes-pdf-empty", text: "This PDF has no outline" });
		}
	}

	private async outlinePage(item: any): Promise<number | null> {
		try {
			let destination = item.dest;
			if (typeof destination === "string") destination = await this.doc.getDestination(destination);
			if (!destination) return null;
			const reference = destination[0];
			return typeof reference === "number" ? reference : await this.doc.getPageIndex(reference);
		} catch {
			return null;
		}
	}

	private async outlineJump(item: any): Promise<void> {
		try {
			let destination = item.dest;
			if (typeof destination === "string") destination = await this.doc.getDestination(destination);
			if (!destination) return;
			const ref = destination[0];
			const index = typeof ref === "number" ? ref : await this.doc.getPageIndex(ref);
			this.jumpTo(index);
			if (this.contentEl.clientWidth < 900) this.closeSidebar();
		} catch (err) {
			debug.error("PDF outline jump failed", err);
		}
	}

	private toggleSidebar(tab: SidebarTab = this.sidebar ? this.sidebarTab : "pages"): void {
		if (this.sidebar && tab === this.sidebarTab) {
			this.closeSidebar();
			return;
		}
		this.sidebarTab = tab;
		if (!this.sidebar) {
			this.contentEl.addClass("has-sidebar");
			const panel = this.contentEl.createDiv({ cls: "goodnodes-pdf-sidebar" });
			this.sidebar = panel;
			const header = panel.createDiv({ cls: "goodnodes-pdf-sidebar-header" });
			this.sidebarContent = panel.createDiv({ cls: "goodnodes-pdf-sidebar-content" });
			header.createDiv({ cls: "goodnodes-pdf-sidebar-title" });
			this.iconButton(header, "x", "Close sidebar", () => this.closeSidebar());
			const tabs = panel.createDiv({ cls: "goodnodes-pdf-sidebar-tabs" });
			for (const [name, icon] of [
				["pages", "file"],
				["outline", "list"],
				["bookmarks", "bookmark"],
			] as const) {
				const button = tabs.createEl("button", { attr: { title: name[0].toUpperCase() + name.slice(1) } });
				setIcon(button, icon);
				button.dataset.sidebarTab = name;
				button.onclick = () => {
					this.sidebarTab = name;
					this.renderSidebarTab();
					this.scheduleSave();
				};
			}
			this.thumbObserver = new IntersectionObserver((entries) => this.onThumbnailsIntersect(entries), {
				root: this.sidebarContent,
				rootMargin: "300px 0px",
			});
			requestAnimationFrame(() => this.onResize());
		}
		this.renderSidebarTab();
		this.scheduleSave();
	}

	private closeSidebar(): void {
		this.thumbObserver?.disconnect();
		this.nearThumbnails.clear();
		this.thumbObserver = null;
		this.sidebar?.remove();
		this.sidebar = null;
		this.sidebarContent = null;
		this.contentEl.removeClass("has-sidebar");
		requestAnimationFrame(() => this.onResize());
		this.scheduleSave();
	}

	private renderSidebarTab(): void {
		if (!this.sidebar || !this.sidebarContent) return;
		this.sidebar
			.querySelector(".goodnodes-pdf-sidebar-title")
			?.setText(this.sidebarTab[0].toUpperCase() + this.sidebarTab.slice(1));
		this.sidebar
			.querySelectorAll<HTMLElement>("[data-sidebar-tab]")
			.forEach((button) => button.toggleClass("is-active", button.dataset.sidebarTab === this.sidebarTab));
		this.sidebarContent.empty();
		this.outlineItems = [];
		this.thumbObserver?.disconnect();
		this.nearThumbnails.clear();
		if (this.sidebarTab === "outline") {
			void this.loadOutline();
			return;
		}
		const pages =
			this.sidebarTab === "bookmarks"
				? [...this.bookmarks].sort((a, b) => a - b)
				: this.slots.map((_, index) => index);
		if (!pages.length) {
			this.sidebarContent.createDiv({
				cls: "goodnodes-pdf-empty",
				text: "No bookmarks yet – tap the bookmark icon to mark a page",
			});
			return;
		}
		this.thumbObserver = new IntersectionObserver((entries) => this.onThumbnailsIntersect(entries), {
			root: this.sidebarContent,
			rootMargin: "300px 0px",
		});
		for (const page of pages) {
			const item = this.sidebarContent.createDiv({
				cls: "goodnodes-pdf-thumbnail",
				attr: { "data-page": String(page) },
			});
			item.createDiv({ cls: "goodnodes-pdf-thumbnail-sheet" });
			const ribbon = item.createEl("button", {
				cls: "goodnodes-pdf-thumbnail-bookmark",
				attr: { title: this.bookmarks.has(page) ? "Remove bookmark" : "Bookmark page" },
			});
			setIcon(ribbon, this.bookmarks.has(page) ? "bookmark-check" : "bookmark");
			ribbon.toggleClass("is-bookmarked", this.bookmarks.has(page));
			ribbon.onclick = (event) => {
				event.stopPropagation();
				this.toggleBookmark(page);
			};
			item.createDiv({ cls: "goodnodes-pdf-thumbnail-label", text: String(page + 1) });
			item.onclick = () => {
				this.jumpTo(page);
				if (this.contentEl.clientWidth < 900) this.closeSidebar();
			};
			this.thumbObserver.observe(item);
		}
		this.updateSidebarSelection();
		if (this.sidebarTab === "pages") requestAnimationFrame(() => this.scrollSidebarToCurrent());
	}

	private async renderThumbnail(index: number): Promise<void> {
		const item = this.sidebarContent?.querySelector<HTMLElement>(`.goodnodes-pdf-thumbnail[data-page="${index}"]`);
		const sheet = item?.querySelector<HTMLElement>(".goodnodes-pdf-thumbnail-sheet");
		if (!sheet || sheet.querySelector("canvas") || !this.doc) return;
		try {
			const page = this.loaded.get(index) ?? (await this.doc.getPage(index + 1));
			this.loaded.set(index, page);
			const displayViewport = page.getViewport({ scale: 1 });
			const unrotatedViewport = page.getViewport({ scale: 1, rotation: 0 });
			const slot = this.slots[index];
			slot.width = displayViewport.width;
			slot.height = displayViewport.height;
			slot.rotation = displayViewport.rotation ?? page.rotate ?? 0;
			slot.unrotatedWidth = unrotatedViewport.width;
			slot.unrotatedHeight = unrotatedViewport.height;
			const viewport = page.getViewport({ scale: 150 / displayViewport.width });
			const canvas = document.createElement("canvas");
			canvas.width = Math.ceil(viewport.width);
			canvas.height = Math.ceil(viewport.height);
			canvas.style.width = "100%";
			canvas.style.height = "auto";
			sheet.appendChild(canvas);
			await page.render({ canvasContext: canvas.getContext("2d", { alpha: false })!, viewport }).promise;
			this.drawThumbnailInk(index, canvas);
			this.releaseFarThumbnails(index);
			if (!this.slots[index].busy && this.slots[index].page !== page) {
				page.cleanup?.();
				this.loaded.delete(index);
			}
		} catch (err) {
			debug.log(`PDF thumbnail ${index + 1} failed: ${String(err)}`, "warn");
		}
	}

	private drawThumbnailInk(index: number, canvas: HTMLCanvasElement): void {
		const ctx = canvas.getContext("2d")!;
		const scale = canvas.width / this.slots[index].width;
		for (const stroke of this.strokes.get(index) ?? []) {
			const slot = this.slots[index];
			const points = stroke.points.map(([x, y, pressure]) => {
				const [screenX, screenY] = unrotatedToDisplayed(x, y, rotationInfo(slot));
				return [screenX * scale, screenY * scale, pressure];
			});
			const outline = getStroke(points, {
				size: stroke.width * scale * (stroke.tool === "highlighter" ? 5 : 1),
				thinning: stroke.tool === "highlighter" ? 0 : 0.6,
			});
			if (!outline.length) continue;
			ctx.globalAlpha = stroke.tool === "highlighter" ? 0.35 : 1;
			ctx.fillStyle = stroke.color;
			ctx.beginPath();
			ctx.moveTo(outline[0][0], outline[0][1]);
			for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]);
			ctx.closePath();
			ctx.fill();
		}
		ctx.globalAlpha = 1;
	}

	/** Thumbnails within the observer margin; these are never released. */
	private nearThumbnails = new Set<number>();

	private onThumbnailsIntersect(entries: IntersectionObserverEntry[]): void {
		for (const entry of entries) {
			const page = Number((entry.target as HTMLElement).dataset.page);
			if (entry.isIntersecting) {
				this.nearThumbnails.add(page);
				void this.renderThumbnail(page);
			} else {
				this.nearThumbnails.delete(page);
			}
		}
	}

	/** Keep at most ~40 thumbnail canvases: drop off-screen ones, farthest from `current` first. */
	private releaseFarThumbnails(current: number): void {
		if (!this.sidebarContent) return;
		const alive = [...this.sidebarContent.querySelectorAll<HTMLElement>(".goodnodes-pdf-thumbnail")].filter(
			(item) => item.querySelector("canvas") && !this.nearThumbnails.has(Number(item.dataset.page)),
		);
		const excess = alive.length + this.nearThumbnails.size - 40;
		if (excess <= 0) return;
		alive.sort((a, b) => Math.abs(Number(b.dataset.page) - current) - Math.abs(Number(a.dataset.page) - current));
		for (const item of alive.slice(0, excess)) {
			const canvas = item.querySelector("canvas");
			if (canvas) {
				canvas.width = canvas.height = 0;
				canvas.remove();
			}
		}
	}

	private updateSidebarSelection(): void {
		this.sidebarContent
			?.querySelectorAll<HTMLElement>(".goodnodes-pdf-thumbnail")
			.forEach((item) => item.toggleClass("is-current", Number(item.dataset.page) === this.currentPage));
		for (const item of this.outlineItems) item.row.toggleClass("is-current", item.page === this.currentPage);
		this.updateToolbar();
	}

	private scrollSidebarToCurrent(): void {
		const item = this.sidebarContent?.querySelector<HTMLElement>(
			`.goodnodes-pdf-thumbnail[data-page="${this.currentPage}"]`,
		);
		if (!item || !this.sidebarContent) return;
		const box = item.getBoundingClientRect();
		const panel = this.sidebarContent.getBoundingClientRect();
		if (box.top < panel.top || box.bottom > panel.bottom) item.scrollIntoView({ block: "nearest" });
	}

	private toggleBookmark(page: number): void {
		if (this.bookmarks.has(page)) this.bookmarks.delete(page);
		else this.bookmarks.add(page);
		const ribbon = this.sidebarContent?.querySelector<HTMLElement>(
			`.goodnodes-pdf-thumbnail[data-page="${page}"] .goodnodes-pdf-thumbnail-bookmark`,
		);
		if (ribbon) {
			const active = this.bookmarks.has(page);
			setIcon(ribbon, active ? "bookmark-check" : "bookmark");
			ribbon.toggleClass("is-bookmarked", active);
			ribbon.setAttribute("title", active ? "Remove bookmark" : "Bookmark page");
		}
		this.updateSidebarSelection();
		if (this.sidebarTab === "bookmarks") this.renderSidebarTab();
		this.markDirty();
		this.scheduleSave();
	}

	private async loadSidecar(file: TFile, pdfSize: number): Promise<void> {
		this.loadingSidecar = true;
		try {
			if (!(await this.app.vault.adapter.exists(this.sidecarPath))) {
				this.strokes.clear();
				this.bookmarks.clear();
				this.currentPage = 0;
				this.zoom = 1;
				this.restoredSidebar = null;
				this.lastSerialized = "";
				this.dirty = false;
				return;
			}
			const text = await this.app.vault.adapter.read(this.sidecarPath);
			const parsed = parseSidecar(text, this.doc.numPages);
			if (!parsed) {
				debug.log(`Ignoring invalid or unsupported PDF sidecar: ${this.sidecarPath}`, "warn");
				return;
			}
			if (parsed.pdf.size !== pdfSize)
				debug.log(
					`PDF sidecar size differs from current PDF (${parsed.pdf.size} vs ${pdfSize} bytes); loading anyway`,
					"warn",
				);
			this.strokes = new Map(Object.entries(parsed.pages).map(([index, strokes]) => [Number(index), strokes]));
			this.bookmarks = new Set(parsed.bookmarks);
			this.currentPage = parsed.view.page;
			this.zoom = parsed.view.zoom;
			this.restoredSidebar = parsed.view.sidebar ?? null;
			this.lastSerialized = text;
			this.dirty = false;
		} catch (err) {
			debug.log(`PDF sidecar read failed: ${String(err)}`, "warn");
		} finally {
			this.loadingSidecar = false;
		}
		void file;
	}

	private makeSidecar(): PdfSidecar {
		const file = this.file as TFile;
		const pages: PdfSidecar["pages"] = {};
		for (const [index, strokes] of this.strokes) if (strokes.length) pages[String(index)] = strokes;
		return {
			type: "goodnodes-pdf",
			version: 1,
			pdf: { size: file?.stat.size ?? 0, pages: this.slots.length },
			view: { page: this.currentPage, zoom: this.zoom, sidebar: this.sidebar ? this.sidebarTab : null },
			bookmarks: [...this.bookmarks].sort((a, b) => a - b),
			pages,
		};
	}

	private markDirty(): void {
		this.dirty = true;
		this.revision++;
	}

	private scheduleSave(): void {
		if (this.loadingSidecar || this.disposed || !this.sidecarPath || !this.file) return;
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.writeSidecar();
		}, 1000);
	}

	private async writeSidecar(): Promise<void> {
		if (this.loadingSidecar || !this.sidecarPath || !this.file) return;
		const revision = this.revision;
		const serialized = serializeSidecar(this.makeSidecar());
		if (serialized === this.lastSerialized) {
			if (revision === this.revision) this.dirty = false;
			return;
		}
		try {
			await this.app.vault.adapter.write(this.sidecarPath, serialized);
			this.lastSerialized = serialized;
			if (revision === this.revision) this.dirty = false;
			else this.scheduleSave();
		} catch (err) {
			debug.error("PDF sidecar save failed", err);
		}
	}

	private async flushSave(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (this.dirty) await this.writeSidecar();
	}

	private async readExternalSidecar(): Promise<void> {
		if (this.disposed) return;
		try {
			const text = await this.app.vault.adapter.read(this.sidecarPath);
			if (text === this.lastSerialized) return;
			if (this.dirty) {
				debug.log("External PDF sidecar changed while local edits are pending; keeping local strokes", "warn");
				return;
			}
			const parsed = parseSidecar(text, this.slots.length);
			if (!parsed) {
				debug.log("External PDF sidecar update was invalid; keeping current strokes", "warn");
				return;
			}
			this.strokes = new Map(Object.entries(parsed.pages).map(([index, strokes]) => [Number(index), strokes]));
			this.bookmarks = new Set(parsed.bookmarks);
			this.currentPage = parsed.view.page;
			this.zoom = parsed.view.zoom;
			this.restoredSidebar = parsed.view.sidebar ?? null;
			this.lastSerialized = text;
			this.history.clear();
			this.releaseAll();
			for (const slot of this.slots) {
				slot.el.style.width = `${slot.width * this.pageScale * this.zoom}px`;
				slot.el.style.height = `${slot.height * this.pageScale * this.zoom}px`;
			}
			for (const [index] of this.strokes) this.drawCommittedInk(index);
			this.restorePage(this.currentPage);
			if (this.restoredSidebar) {
				const tab = this.restoredSidebar;
				this.restoredSidebar = null;
				if (!this.sidebar) this.toggleSidebar(tab);
				else {
					this.sidebarTab = tab;
					this.renderSidebarTab();
				}
			} else if (this.sidebar) this.closeSidebar();
			this.updateSidebarSelection();
			this.dirty = false;
		} catch (err) {
			debug.log(`External PDF sidecar reload failed: ${String(err)}`, "warn");
		}
	}

	/** Page to scroll to as soon as the scroller has a size (it may not on open). */
	private pendingRestore: number | null = null;

	private restorePage(page: number): void {
		if (!this.slots.length) return;
		this.pendingRestore = Math.max(0, Math.min(this.slots.length - 1, page));
		this.applyPendingRestore();
	}

	private applyPendingRestore(): void {
		if (this.pendingRestore === null || this.scroller.clientHeight === 0 || !this.slots.length) return;
		const index = this.pendingRestore;
		this.pendingRestore = null;
		this.scroller.scrollTop = this.slots[index].el.offsetTop;
		this.currentPage = index;
		this.scheduleUpdate();
	}

	private async exportAnnotated(): Promise<void> {
		const file = this.file as TFile;
		if (!file) return;
		try {
			const source = await this.app.vault.readBinary(file);
			const bytes = await createAnnotatedPdf(source, this.strokes);
			const stem = `${file.parent?.path ? `${file.parent.path}/` : ""}${file.basename} (annotated)`;
			let path = `${stem}.pdf`,
				suffix = 2;
			while (await this.app.vault.adapter.exists(path)) path = `${stem} ${suffix++}.pdf`;
			const copy = new Uint8Array(bytes.length);
			copy.set(bytes);
			await this.app.vault.createBinary(path, copy.buffer);
			new Notice(`Saved ${path}`);
		} catch (err) {
			debug.error("PDF annotation export failed", err);
			new Notice("Could not export annotated PDF. See GoodNodes debug log.");
		}
	}

	private clearDocument(): void {
		this.disposed = true;
		this.pendingRestore = null;
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.observer?.disconnect();
		this.observer = null;
		this.thumbObserver?.disconnect();
		this.nearThumbnails.clear();
		this.thumbObserver = null;
		this.queue = [];
		for (const index of this.slots.keys()) this.release(index);
		this.slots = [];
		this.loaded.clear();
		this.visible.clear();
		this.strokes.clear();
		this.bookmarks.clear();
		this.history.clear();
		this.doc?.destroy?.();
		this.doc = null;
		this.pagesEl.empty();
		this.closePopover();
		this.sidebar?.remove();
		this.sidebar = null;
		this.sidebarContent = null;
		this.contentEl.removeClass("has-sidebar");
		if (this.settingsTimer !== null) {
			window.clearTimeout(this.settingsTimer);
			this.settingsTimer = null;
			void this.plugin.saveSettings();
		}
		if (this.scrubberTimer !== null) {
			window.clearTimeout(this.scrubberTimer);
			this.scrubberTimer = null;
		}
		cancelAnimationFrame(this.scrubberRaf);
		this.scrubberRaf = 0;
		this.activeStroke = null;
		this.pointers.clear();
		this.pinch = null;
		delete debug.live.pdf;
	}
}

class PageModal extends Modal {
	constructor(app: App, max: number, jump: (page: number) => void, current: number) {
		super(app);
		this.titleEl.setText("Go to page");
		const input = this.contentEl.createEl("input", {
			attr: { type: "number", min: "1", max: String(max), value: String(current) },
		});
		input.focus();
		input.select();
		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			const page = Number(input.value);
			if (page >= 1 && page <= max) {
				jump(page);
				this.close();
			}
		});
	}
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}
