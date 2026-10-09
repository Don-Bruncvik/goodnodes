import {
	App,
	FileView,
	FuzzySuggestModal,
	loadPdfJs,
	Menu,
	Modal,
	Notice,
	setIcon,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import { PDFDocument } from "pdf-lib";
import { getStroke } from "perfect-freehand";
import { findScratchedStrokes } from "../scratch/detect";
import type GoodNodesPlugin from "../main";
import { debug } from "../debug";
import { createAnnotatedPdf } from "./export";
import { openPdf } from "./pdfjs";
import { displayedToUnrotated, unrotatedToDisplayed } from "./coordinates";
import { findEraserHits } from "./eraser";
import { PdfHistory } from "./history";
import type { InkPoint, InkStroke, InkTool, PdfSidecar } from "./model";
import { newStrokeId } from "./model";
import { parseSidecar, serializeSidecar } from "./sidecar";
import { deleteSidecarPage, insertSidecarPages } from "./page-ops";
import { drawPaperTemplate } from "../notebook/paper";
import type { NotebookMeta } from "../notebook";
import { pickFiles } from "../files";
import "./pdf.css";

export const PDF_VIEW_TYPE = "goodnodes-pdf";
type PdfDoc = any;
type PdfPage = any;
/**
 * The size most pages have, used for every placeholder before a page is loaded.
 * Taking page 1 alone breaks books whose cover differs: every later page then
 * resized while scrolling, and the view jumped.
 */
async function typicalPageSize(doc: any): Promise<{ width: number; height: number }> {
	const count: number = doc.numPages;
	const sample = [...new Set([1, 2, 3, 4, 5, 6, Math.ceil(count / 2), count])].filter((n) => n >= 1 && n <= count);
	const tally = new Map<string, { width: number; height: number; n: number }>();
	for (const n of sample) {
		const viewport = (await doc.getPage(n)).getViewport({ scale: 1 });
		const key = `${Math.round(viewport.width)}x${Math.round(viewport.height)}`;
		const entry = tally.get(key) ?? { width: viewport.width, height: viewport.height, n: 0 };
		entry.n++;
		tally.set(key, entry);
	}
	return [...tally.values()].sort((a, b) => b.n - a.n)[0];
}

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
	/** Drawn at an old zoom: stays on screen (scaled) until the sharp render replaces it. */
	stale?: boolean;
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
	private historyToolbar!: HTMLElement;
	private indicator: HTMLElement;
	private sidebar: HTMLElement | null = null;
	private sidebarContent: HTMLElement | null = null;
	private sidebarTab: SidebarTab = "pages";
	/** Saved sidebar state: a tab, "closed" (the user closed it), or null (never set). */
	private restoredSidebar: SidebarTab | "closed" | null = null;
	private sidebarClosedByUser = false;
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
	private lastWheelTurn = 0;
	private notebookMeta?: NotebookMeta;
	private ownPdfWrite = false;
	private pdfSignature = "";
	private pageOperation = false;
	// Fingers are handled with TouchEvents, not PointerEvents: when iOS starts native
	// scrolling it cancels the touch pointers, and pointer-based finger tracking went
	// out of sync (one finger then zoomed instead of scrolling). `touches` always lists
	// exactly the fingers on the glass.
	private touchStart = (event: TouchEvent) => {
		this.blockStylusTouch(event);
		this.syncPinch(event);
	};
	private touchMove = (event: TouchEvent) => {
		this.blockStylusTouch(event);
		this.syncPinch(event);
	};
	private touchEnd = (event: TouchEvent) => this.syncPinch(event);

	constructor(leaf: WorkspaceLeaf, plugin: GoodNodesPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.toolState = {
			tool: sessionTool,
			color: plugin.settings.penColor,
			width: plugin.settings.penWidth,
		};
		this.contentEl.addClass("goodnodes-pdf-root");
		this.contentEl.toggleClass("is-horizontal", this.horizontal);
		this.scroller = this.contentEl.createDiv({ cls: "goodnodes-pdf-scroll" });
		// Obsidian doesn't call onResize for every size change (window resize, iPad rotation,
		// split view, our own sidebar), so watch the scroller directly.
		const resizeObserver = new ResizeObserver(() => requestAnimationFrame(() => this.onResize()));
		resizeObserver.observe(this.scroller);
		this.register(() => resizeObserver.disconnect());
		this.pagesEl = this.scroller.createDiv({ cls: "goodnodes-pdf-pages" });
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
				} else if (this.horizontal && this.zoom <= 1 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
					e.preventDefault();
					if (Date.now() - this.lastWheelTurn >= 350) {
						this.lastWheelTurn = Date.now();
						this.jumpTo(this.currentPage + (e.deltaY > 0 ? 1 : -1));
					}
				}
			},
			{ passive: false },
		);
		this.registerDomEvent(this.contentEl, "keydown", (e) => this.handleKeydown(e));
		this.contentEl.tabIndex = 0;
		this.scroller.addEventListener("touchstart", this.touchStart, { passive: false });
		this.scroller.addEventListener("touchmove", this.touchMove, { passive: false });
		this.scroller.addEventListener("touchend", this.touchEnd, { passive: false });
		this.scroller.addEventListener("touchcancel", this.touchEnd, { passive: false });
		// Obsidian mobile opens sidebars on horizontal swipes; writing or panning a page must not.
		for (const type of ["touchstart", "touchmove", "touchend"] as const) {
			this.registerDomEvent(this.scroller, type, (e: TouchEvent) => e.stopPropagation(), { passive: true });
		}
		this.registerEvent(
			(this.app.vault as any).on("raw", (path: string) => {
				if (path === this.sidecarPath) void this.readExternalSidecar();
			}),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file === this.file && file instanceof TFile && file.extension === "pdf")
					void this.checkExternalPdf(file);
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
			this.pdfSignature = `${file.stat.size}:${file.stat.mtime}`;
			if (stale()) return;
			const doc = await openPdf(data, this.pdfjs);
			if (stale()) {
				void doc.destroy();
				return;
			}
			this.doc = doc;
			const base = await typicalPageSize(doc);
			if (stale()) return;
			this.baseWidth = base.width;
			this.baseHeight = base.height;
			this.pageScale = this.fitScale();
			// pdf.js transfers (detaches) `data` to its worker, so take the size from the file.
			await this.loadSidecar(file, file.stat.size);
			if (stale()) return;
			this.buildSlots();
			// Like GoodNotes: pages on the left on a wide screen, unless the user closed them.
			const saved = this.restoredSidebar;
			this.restoredSidebar = null;
			this.sidebarClosedByUser = saved === "closed";
			if (saved && saved !== "closed") this.toggleSidebar(saved);
			else if (saved === null && this.contentEl.clientWidth >= 900) this.toggleSidebar("pages");
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
		// Undo/redo live in the toolbar (like GoodNotes): a separate floating box covered the page.
		this.toolbar.createDiv({ cls: "goodnodes-pdf-toolbar-separator" });
		this.historyToolbar = this.toolbar.createDiv({ cls: "goodnodes-pdf-history-group" });
		this.iconButton(this.historyToolbar, "undo-2", "Undo", () => this.undo());
		this.iconButton(this.historyToolbar, "redo-2", "Redo", () => this.redo());
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
				.setTitle("Add page at the end")
				.setIcon("file-plus-2")
				.onClick(() => void this.insertBlankPage(this.slots.length)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Insert page after this one")
				.setIcon("file-plus")
				.onClick(() => void this.insertBlankPage(this.currentPage + 1)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Insert PDF pages…")
				.setIcon("files")
				.onClick(() => void this.choosePdfToInsert()),
		);
		menu.addItem((item) =>
			item
				.setTitle("Delete this page")
				.setIcon("file-minus-2")
				.onClick(() => this.confirmDeletePage()),
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
		const widthFit = availableWidth / this.baseWidth;
		if (!this.horizontal) return Math.max(0.1, widthFit);
		const heightFit = (this.scroller.clientHeight - 64 - 56) / this.baseHeight;
		return Math.max(0.1, Math.min(widthFit, heightFit));
	}

	private get horizontal(): boolean {
		return this.plugin.settings.pdfPageDirection === "horizontal";
	}

	/** Like a book, zooming out stops at the whole page; vertical scrolling may show several. */
	private get minZoom(): number {
		return this.horizontal ? 1 : 0.5;
	}

	private mainScroll(): number {
		return this.horizontal ? this.scroller.scrollLeft : this.scroller.scrollTop;
	}

	private setMainScroll(value: number): void {
		if (this.horizontal) this.scroller.scrollLeft = value;
		else this.scroller.scrollTop = value;
	}

	private pageStart(slot: PageSlot): number {
		return this.horizontal ? slot.el.offsetLeft : slot.el.offsetTop;
	}

	private pageLength(slot: PageSlot): number {
		return this.horizontal ? slot.el.offsetWidth : slot.el.offsetHeight;
	}

	private viewLength(): number {
		return this.horizontal ? this.scroller.clientWidth : this.scroller.clientHeight;
	}

	private maxMainScroll(): number {
		return Math.max(
			0,
			this.horizontal
				? this.scroller.scrollWidth - this.scroller.clientWidth
				: this.scroller.scrollHeight - this.scroller.clientHeight,
		);
	}

	private updatePagePadding(): void {
		if (!this.horizontal || !this.slots.length) {
			this.pagesEl.style.paddingLeft = "";
			this.pagesEl.style.paddingRight = "";
			this.pagesEl.style.columnGap = "";
			return;
		}
		// Like a book: at fit zoom the neighbouring pages stay just off screen, so only
		// the current page shows; zoomed in, a normal gap.
		const pageWidth = this.baseWidth * this.pageScale * this.zoom;
		const gap = this.zoom <= 1.001 ? Math.max(24, (this.scroller.clientWidth - pageWidth) / 2 + 12) : 24;
		this.pagesEl.style.columnGap = `${gap}px`;
		const firstPadding = Math.max(16, (this.scroller.clientWidth - this.slots[0].el.offsetWidth) / 2);
		const last = this.slots[this.slots.length - 1];
		const lastPadding = Math.max(16, (this.scroller.clientWidth - last.el.offsetWidth) / 2);
		this.pagesEl.style.paddingLeft = `${firstPadding}px`;
		this.pagesEl.style.paddingRight = `${lastPadding}px`;
	}

	private updateSnapping(): void {
		this.scroller.toggleClass(
			"is-snapping",
			this.horizontal && this.zoom <= 1.001 && !this.pinch && !this.scrubberDragging,
		);
	}

	private centerPage(index: number): void {
		const slot = this.slots[index];
		if (!slot) return;
		this.scroller.scrollLeft = Math.max(
			0,
			slot.el.offsetLeft - (this.scroller.clientWidth - slot.el.offsetWidth) / 2,
		);
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
		const addTile = this.pagesEl.createEl("button", { cls: "goodnodes-pdf-add-page", text: "+ Add page" });
		addTile.style.width = `${this.baseWidth * this.pageScale * this.zoom * (this.horizontal ? 0.3 : 1)}px`;
		addTile.style.height = `${this.baseHeight * this.pageScale * this.zoom * (this.horizontal ? 1 : 0.3)}px`;
		addTile.onclick = () => void this.insertBlankPage(this.slots.length);
		this.updatePagePadding();
		this.updateSnapping();
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
			{
				root: this.scroller,
				rootMargin: this.horizontal
					? `0px ${Math.max(500, this.scroller.clientWidth)}px`
					: `${Math.max(500, this.scroller.clientHeight)}px 0px`,
			},
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
		if (
			!this.scroller.isConnected ||
			this.scroller.clientWidth === 0 ||
			this.scroller.clientHeight === 0 ||
			this.pendingRestore !== null
		)
			return;
		const center = this.mainScroll() + this.viewLength() / 2;
		let current = 0,
			best = Infinity;
		this.slots.forEach((slot, i) => {
			const distance = Math.abs(this.pageStart(slot) + this.pageLength(slot) / 2 - center);
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
		for (const i of selected)
			if ((!this.slots[i].canvas || this.slots[i].stale) && !this.slots[i].busy) this.queue.push(i);
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
			const slot = this.slots[index];
			if (!this.visible.has(index) || (slot.canvas && !slot.stale) || slot.busy) continue;
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
				this.updatePagePadding();
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
			// Fill the page box: if zoom/fit changed while this page was rendering, it is
			// briefly blurry instead of drawn at the wrong size (the "broken first page").
			canvas.style.width = "100%";
			canvas.style.height = "100%";
			const ctx = canvas.getContext("2d", { alpha: false })!;
			const task = page.render({
				canvasContext: ctx,
				viewport: pixelScale === 1 ? viewport : page.getViewport({ scale: scale * pixelScale }),
			});
			this.slots[index].task = task;
			// A stale page keeps showing its old canvas; the new one goes in only when finished.
			const replacing = !!this.slots[index].canvas;
			if (!replacing) this.slots[index].el.appendChild(canvas);
			await task.promise;
			if (this.disposed || !this.visible.has(index)) {
				canvas.width = canvas.height = 0;
				canvas.remove();
				return;
			}
			const ink = this.makeOverlay(canvas, "goodnodes-pdf-ink");
			const live = this.makeOverlay(canvas, "goodnodes-pdf-live");
			live.width = live.height = 0;
			if (replacing) {
				const old = this.slots[index];
				for (const key of ["canvas", "ink", "live"] as const) {
					const previous = old[key];
					if (previous) {
						previous.width = previous.height = 0;
						previous.remove();
					}
				}
				this.slots[index].el.appendChild(canvas);
			}
			this.slots[index].stale = false;
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
		canvas.style.width = "100%";
		canvas.style.height = "100%";
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
		slot.stale = false;
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
		const position = this.mainScroll();
		let index = this.slots.findIndex((slot) => this.pageStart(slot) + this.pageLength(slot) >= position);
		if (index < 0) index = 0;
		return { index, offset: position - this.pageStart(this.slots[index]) };
	}

	private restoreAnchor(anchor: { index: number; offset: number }): void {
		const slot = this.slots[anchor.index];
		if (slot) this.setMainScroll(this.pageStart(slot) + anchor.offset);
	}

	private setZoom(value: number, clientX?: number, clientY?: number): void {
		const next = Math.max(this.minZoom, Math.min(4, value));
		if (Math.abs(next - this.zoom) < 0.001) return;
		this.relayout(() => (this.zoom = next), clientX, clientY);
		this.markDirty();
	}

	private updateScrubber(): void {
		const max = Math.max(1, this.maxMainScroll());
		const fraction = this.mainScroll() / max;
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
		this.updateSnapping();
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
		if (this.horizontal) {
			const index = Math.min(this.slots.length - 1, Math.floor(ratio * this.slots.length));
			this.centerPage(index);
		} else {
			this.setMainScroll(ratio * this.maxMainScroll());
		}
		this.scrubberBubble.setText(`Page ${this.currentPage + 1} / ${this.slots.length}`);
	}

	private scrubberUp(event: PointerEvent): void {
		if (!this.scrubberDragging || event.pointerId !== this.scrubberPointer) return;
		this.scrubberDragging = false;
		this.scrubberPointer = 0;
		this.updateSnapping();
		this.showScrubber();
	}

	/** Pages fit the view width at zoom 1; refit when the view is resized (rotation, sidebars). */
	onResize(): void {
		if (!this.doc || !this.slots.length || this.scroller.clientWidth === 0) return;
		this.updateSnapping();
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
			this.updateAddPageTile();
			this.updatePagePadding();
		}
		this.updatePagePadding();
		this.applyPendingRestore();
	}

	/** Change page scale/zoom while keeping the content under (clientX, clientY) in place. */
	private relayout(change: () => void, clientX?: number, clientY?: number): void {
		const rect = this.scroller.getBoundingClientRect();
		const screenX = clientX ?? rect.left + this.scroller.clientWidth / 2;
		const screenY = clientY ?? rect.top + this.scroller.clientHeight / 2;
		const anchor = this.zoomAnchor(screenX, screenY);
		change();
		this.updateSnapping();
		this.markRenderedStale();
		for (const slot of this.slots) {
			slot.el.style.width = `${slot.width * this.pageScale * this.zoom}px`;
			slot.el.style.height = `${slot.height * this.pageScale * this.zoom}px`;
		}
		this.updateAddPageTile();
		this.updatePagePadding();
		this.applyZoomAnchor(anchor, screenX, screenY);
		if (this.horizontal && this.zoom <= 1.001) {
			this.centerPage(anchor.page);
			this.scroller.scrollTop = 0;
		}
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

	/**
	 * After a zoom or resize, keep the pages near the current one on screen (the browser
	 * scales them) and re-render them sharp in the background. Releasing them showed
	 * blank white pages for a moment: the flicker after every pinch.
	 */
	private markRenderedStale(): void {
		for (const [index, slot] of this.slots.entries()) {
			if (!slot.canvas) continue;
			if (Math.abs(index - this.currentPage) > 2) this.release(index);
			else {
				slot.task?.cancel?.();
				slot.stale = true;
			}
		}
	}

	private updateAddPageTile(): void {
		const tile = this.pagesEl.querySelector<HTMLElement>(".goodnodes-pdf-add-page");
		if (!tile) return;
		tile.style.width = `${this.baseWidth * this.pageScale * this.zoom * (this.horizontal ? 0.3 : 1)}px`;
		tile.style.height = `${this.baseHeight * this.pageScale * this.zoom * (this.horizontal ? 1 : 0.3)}px`;
	}

	private pointerDown(event: PointerEvent): void {
		debug.pointer("pdf", event);
		if (event.pointerType === "pen") this.penUntil = Date.now() + 250;
		// Fingers scroll natively and pinch via TouchEvents (syncPinch); they never draw.
		if (event.pointerType === "touch") return;
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
		if (event.pointerType === "touch") return;
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
		this.pointers.delete(event.pointerId);
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

	private blockStylusTouch(event: TouchEvent): void {
		if ([...event.changedTouches].some((touch) => (touch as any).touchType === "stylus")) event.preventDefault();
	}

	/** Finger touches (not the pencil, not a resting palm) currently on the screen. */
	private fingers(event: TouchEvent): Touch[] {
		if (this.penDown || Date.now() < this.penUntil) return [];
		const max = this.plugin.settings.palmMaxTouchSize;
		return [...event.touches].filter((touch) => {
			if ((touch as Touch & { touchType?: string }).touchType === "stylus") return false;
			return !(max > 0 && Math.max(touch.radiusX, touch.radiusY) * 2 > max);
		});
	}

	/** Two fingers pinch-zoom; one finger is left to native scrolling. */
	private syncPinch(event: TouchEvent): void {
		const fingers = this.fingers(event);
		if (fingers.length >= 2) {
			if (event.cancelable) event.preventDefault();
			if (!this.pinch) this.startPinch(fingers[0], fingers[1]);
			else this.updatePinch(fingers[0], fingers[1]);
		} else if (this.pinch) {
			this.endPinch();
		}
	}

	private startPinch(a: Touch, b: Touch): void {
		const centerX = (a.clientX + b.clientX) / 2,
			centerY = (a.clientY + b.clientY) / 2;
		const anchor = this.zoomAnchor(centerX, centerY);
		const pagesRect = this.pagesEl.getBoundingClientRect();
		this.pinch = {
			distance: Math.max(1, Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)),
			zoom: this.zoom,
			originX: centerX,
			originY: centerY,
			centerX,
			centerY,
			anchor,
			visualScale: 1,
		};
		this.updateSnapping();
		this.pagesEl.style.transformOrigin = `${centerX - pagesRect.left}px ${centerY - pagesRect.top}px`;
	}

	private updatePinch(a: Touch, b: Touch): void {
		if (!this.pinch) return;
		this.pinch.centerX = (a.clientX + b.clientX) / 2;
		this.pinch.centerY = (a.clientY + b.clientY) / 2;
		this.pinch.visualScale = Math.max(
			this.minZoom / this.pinch.zoom,
			Math.min(
				4 / this.pinch.zoom,
				Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) / this.pinch.distance,
			),
		);
		this.pagesEl.style.transform = `translate(${this.pinch.centerX - this.pinch.originX}px, ${this.pinch.centerY - this.pinch.originY}px) scale(${this.pinch.visualScale})`;
	}

	private endPinch(): void {
		if (!this.pinch) return;
		const gesture = this.pinch;
		this.pagesEl.style.transform = "";
		this.pagesEl.style.transformOrigin = "";
		this.zoom = Math.max(this.minZoom, Math.min(4, gesture.zoom * gesture.visualScale));
		this.markDirty();
		this.markRenderedStale();
		for (const slot of this.slots) {
			slot.el.style.width = `${slot.width * this.pageScale * this.zoom}px`;
			slot.el.style.height = `${slot.height * this.pageScale * this.zoom}px`;
		}
		this.updateAddPageTile();
		this.pinch = null;
		this.updatePagePadding();
		this.updateSnapping();
		this.applyZoomAnchor(gesture.anchor, gesture.centerX, gesture.centerY);
		if (this.horizontal && this.zoom <= 1.001) {
			this.centerPage(gesture.anchor.page);
			this.scroller.scrollTop = 0;
		}
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
		const target = event.target as HTMLElement | null;
		if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
		if (event.metaKey || event.ctrlKey || event.altKey) {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
				event.preventDefault();
				if (event.shiftKey) this.redo();
				else this.undo();
			}
			return;
		}
		if (event.shiftKey) return;
		if (["ArrowRight", "PageDown", " "].includes(event.key)) {
			event.preventDefault();
			this.jumpTo(this.currentPage + 1);
		} else if (["ArrowLeft", "PageUp"].includes(event.key)) {
			event.preventDefault();
			this.jumpTo(this.currentPage - 1);
		}
	}

	private openPageModal(): void {
		const modal = new PageModal(this.app, this.slots.length, (page) => this.jumpTo(page - 1), this.currentPage + 1);
		modal.open();
	}

	private jumpTo(index: number): void {
		if (index < 0 || index >= this.slots.length) return;
		if (this.slots[index].canvas) debug.log(`Jump page ${index + 1} to first render 0.0 ms (already rendered)`);
		else this.jumpStarted.set(index, performance.now());
		if (this.horizontal) {
			this.centerPage(index);
			if (this.zoom <= 1.001) this.scroller.scrollTop = 0;
		} else this.scroller.scrollTop = this.slots[index].el.offsetTop;
		this.visible.add(index);
		this.scheduleUpdate();
	}

	/** Rebuild the page axis after the setting changes, keeping the selected page in view. */
	applyPageDirection(): void {
		const page = this.currentPage;
		this.contentEl.toggleClass("is-horizontal", this.horizontal);
		if (this.doc && this.slots.length) {
			this.observer?.disconnect();
			this.observe();
			this.pageScale = this.fitScale();
			// Canvases were drawn at the old scale; they re-render at the new one.
			this.markRenderedStale();
			for (const slot of this.slots) {
				slot.el.style.width = `${slot.width * this.pageScale * this.zoom}px`;
				slot.el.style.height = `${slot.height * this.pageScale * this.zoom}px`;
			}
			this.updateAddPageTile();
			this.updatePagePadding();
			this.updateSnapping();
			if (this.horizontal) {
				this.centerPage(page);
				if (this.zoom <= 1.001) this.scroller.scrollTop = 0;
			} else {
				this.scroller.scrollLeft = 0;
				this.scroller.scrollTop = this.slots[page]?.el.offsetTop ?? 0;
			}
			this.scheduleUpdate();
		}
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
			if (this.contentEl.clientWidth < 600) this.closeSidebar();
		} catch (err) {
			debug.error("PDF outline jump failed", err);
		}
	}

	private toggleSidebar(tab: SidebarTab = this.sidebar ? this.sidebarTab : "pages"): void {
		if (this.sidebar && tab === this.sidebarTab) {
			this.sidebarClosedByUser = true;
			this.closeSidebar();
			return;
		}
		this.sidebarClosedByUser = false;
		this.sidebarTab = tab;
		if (!this.sidebar) {
			this.contentEl.addClass("has-sidebar");
			const panel = this.contentEl.createDiv({ cls: "goodnodes-pdf-sidebar" });
			this.sidebar = panel;
			const header = panel.createDiv({ cls: "goodnodes-pdf-sidebar-header" });
			this.sidebarContent = panel.createDiv({ cls: "goodnodes-pdf-sidebar-content" });
			header.createDiv({ cls: "goodnodes-pdf-sidebar-title" });
			this.iconButton(header, "x", "Close sidebar", () => {
				this.sidebarClosedByUser = true;
				this.closeSidebar();
			});
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
				if (this.contentEl.clientWidth < 600) this.closeSidebar();
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
				this.notebookMeta = undefined;
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
			// Book mode always opens on the whole page, as tall as the screen allows.
			this.zoom = this.horizontal ? 1 : parsed.view.zoom;
			this.restoredSidebar = parsed.view.sidebar ?? null;
			this.notebookMeta = parsed.notebook;
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
			view: {
				page: this.currentPage,
				zoom: this.zoom,
				sidebar: this.sidebar ? this.sidebarTab : this.sidebarClosedByUser ? "closed" : null,
			},
			bookmarks: [...this.bookmarks].sort((a, b) => a - b),
			pages,
			...(this.notebookMeta ? { notebook: this.notebookMeta } : {}),
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
			this.zoom = Math.max(this.minZoom, parsed.view.zoom);
			this.restoredSidebar = parsed.view.sidebar ?? null;
			this.notebookMeta = parsed.notebook;
			this.lastSerialized = text;
			this.history.clear();
			this.releaseAll();
			for (const slot of this.slots) {
				slot.el.style.width = `${slot.width * this.pageScale * this.zoom}px`;
				slot.el.style.height = `${slot.height * this.pageScale * this.zoom}px`;
			}
			for (const [index] of this.strokes) this.drawCommittedInk(index);
			this.restorePage(this.currentPage);
			if (this.restoredSidebar && this.restoredSidebar !== "closed") {
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

	private async insertBlankPage(at: number): Promise<void> {
		await this.changePdfPages(async (pdf) => {
			const index = Math.max(0, Math.min(pdf.getPageCount(), at));
			const neighbor = pdf.getPages()[Math.min(index, pdf.getPageCount() - 1)];
			const size = this.notebookMeta ? notebookPageSize(this.notebookMeta) : neighbor.getSize();
			const page = pdf.insertPage(index, [size.width, size.height]);
			if (this.notebookMeta) drawPaperTemplate(page, this.notebookMeta.template);
			return { index, count: 1 };
		});
	}

	private async choosePdfToInsert(): Promise<void> {
		const files = this.app.vault
			.getFiles()
			.filter((file) => file.extension.toLowerCase() === "pdf" && file.path !== this.file?.path);
		new InsertPdfModal(this.app, files, async (file) => {
			let bytes: ArrayBuffer;
			let name: string;
			if (!file) {
				const picked = await pickFiles("application/pdf,.pdf", { multiple: false });
				if (!picked.length) return;
				bytes = await picked[0].arrayBuffer();
				name = picked[0].name;
			} else {
				bytes = await this.app.vault.readBinary(file);
				name = file.basename;
			}
			try {
				const count = await this.insertPdfBytes(bytes, this.currentPage + 1);
				if (count) new Notice(`Inserted ${count} pages`);
			} catch (err) {
				debug.error(`Could not insert PDF pages from ${name}`, err);
				new Notice("Could not insert PDF pages. See GoodNodes debug log.");
			}
		}).open();
	}

	private async insertPdfBytes(sourceBytes: ArrayBuffer, at: number): Promise<number> {
		return this.changePdfPages(async (pdf) => {
			const source = await PDFDocument.load(sourceBytes);
			const indexes = source.getPageIndices();
			const copies = await pdf.copyPages(source, indexes);
			const index = Math.max(0, Math.min(pdf.getPageCount(), at));
			copies.forEach((page, offset) => pdf.insertPage(index + offset, page));
			return { index, count: copies.length };
		});
	}

	private confirmDeletePage(): void {
		const page = this.currentPage + 1;
		new ConfirmDeletePageModal(this.app, this.file?.basename ?? "PDF", page, !this.notebookMeta, () => {
			if (this.slots.length <= 1) {
				new Notice("A PDF must contain at least one page.");
				return;
			}
			void this.changePdfPages(async (pdf) => {
				const index = this.currentPage;
				pdf.removePage(index);
				return { index, count: 0, deleted: true };
			});
		}).open();
	}

	private async changePdfPages(
		edit: (pdf: PDFDocument) => Promise<{ index: number; count: number; deleted?: boolean }>,
	): Promise<number> {
		const file = this.file;
		if (!file || this.pageOperation) return 0;
		this.pageOperation = true;
		try {
			await this.flushSave();
			const bytes = await this.app.vault.readBinary(file);
			const pdf = await PDFDocument.load(bytes);
			const result = await edit(pdf);
			const sidecar = result.deleted
				? deleteSidecarPage(this.makeSidecar(), result.index, this.slots.length)
				: insertSidecarPages(this.makeSidecar(), result.index, result.count);
			this.strokes = new Map(Object.entries(sidecar.pages).map(([key, strokes]) => [Number(key), strokes]));
			this.bookmarks = new Set(sidecar.bookmarks);
			this.currentPage = result.deleted ? sidecar.view.page : result.index;
			// Ink history is page-indexed, so page structure changes invalidate every undo entry.
			this.history.clear();
			this.updateHistoryButtons();
			this.dirty = true;
			this.revision++;
			this.ownPdfWrite = true;
			const output = new Uint8Array(await pdf.save());
			const copy = new Uint8Array(output.length);
			copy.set(output);
			await this.app.vault.modifyBinary(file, copy.buffer);
			this.pdfSignature = `${file.stat.size}:${file.stat.mtime}`;
			await this.reloadInPlace(copy.buffer, this.currentPage);
			this.updateToolbar();
			if (this.sidebar) this.renderSidebarTab();
			await this.writeSidecar();
			return result.count;
		} catch (err) {
			debug.error("PDF page operation failed", err);
			new Notice("Could not change PDF pages. See GoodNodes debug log.");
			return 0;
		} finally {
			this.ownPdfWrite = false;
			this.pageOperation = false;
		}
	}

	private async checkExternalPdf(file: TFile): Promise<void> {
		if (this.ownPdfWrite || this.pageOperation || this.disposed) return;
		const signature = `${file.stat.size}:${file.stat.mtime}`;
		if (signature === this.pdfSignature) return;
		this.pdfSignature = signature;
		try {
			const bytes = await this.app.vault.readBinary(file);
			await this.reloadInPlace(bytes, this.currentPage);
		} catch (err) {
			debug.error("External PDF reload failed", err);
		}
	}

	private async reloadInPlace(bytes: ArrayBuffer, page: number): Promise<void> {
		if (!this.pdfjs) this.pdfjs = await loadPdfJs();
		this.observer?.disconnect();
		this.observer = null;
		this.releaseAll();
		this.loaded.clear();
		this.visible.clear();
		this.queue = [];
		await this.doc?.destroy?.();
		this.doc = null;
		const data = bytes.slice(0);
		const doc = await openPdf(data, this.pdfjs);
		this.doc = doc;
		const base = await typicalPageSize(doc);
		this.baseWidth = base.width;
		this.baseHeight = base.height;
		this.pageScale = this.fitScale();
		this.buildSlots();
		this.observe();
		this.renderSidebarTab();
		this.restorePage(page);
		this.scheduleUpdate();
	}

	/** Page to scroll to as soon as the scroller has a size (it may not on open). */
	private pendingRestore: number | null = null;

	private restorePage(page: number): void {
		if (!this.slots.length) return;
		this.pendingRestore = Math.max(0, Math.min(this.slots.length - 1, page));
		this.applyPendingRestore();
	}

	private applyPendingRestore(): void {
		if (
			this.pendingRestore === null ||
			this.scroller.clientHeight === 0 ||
			this.scroller.clientWidth === 0 ||
			!this.slots.length
		)
			return;
		const index = this.pendingRestore;
		this.pendingRestore = null;
		if (this.horizontal) {
			this.centerPage(index);
			if (this.zoom <= 1.001) this.scroller.scrollTop = 0;
		} else this.scroller.scrollTop = this.slots[index].el.offsetTop;
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
		this.notebookMeta = undefined;
		this.pdfSignature = "";
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

class ConfirmDeletePageModal extends Modal {
	constructor(
		app: App,
		pdfName: string,
		page: number,
		importedPdf: boolean,
		private confirm: () => void,
	) {
		super(app);
		this.titleEl.setText(`Delete page ${page}?`);
		this.contentEl.createEl("p", {
			text: importedPdf
				? `Page ${page} and your notes on it are removed from “${pdfName}”. This changes the PDF file itself.`
				: `Page ${page} and your notes on it are removed from “${pdfName}”.`,
		});
		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		actions.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		actions.createEl("button", { text: "Delete", cls: "mod-warning" }).onclick = () => {
			this.close();
			this.confirm();
		};
	}
}

class InsertPdfModal extends FuzzySuggestModal<TFile | null> {
	constructor(
		app: App,
		private files: TFile[],
		private onChoose: (file: TFile | null) => void,
	) {
		super(app);
		this.setPlaceholder("Choose a PDF to insert");
	}
	getItems(): (TFile | null)[] {
		return [null, ...this.files];
	}
	getItemText(item: TFile | null): string {
		return item ? item.path : "From Files…";
	}
	onChooseItem(item: TFile | null): void {
		this.onChoose(item);
	}
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function notebookPageSize(meta: NotebookMeta): { width: number; height: number } {
	const [portraitWidth, portraitHeight] = meta.size === "a4" ? [595.28, 841.89] : [612, 792];
	return meta.orientation === "landscape"
		? { width: portraitHeight, height: portraitWidth }
		: { width: portraitWidth, height: portraitHeight };
}
