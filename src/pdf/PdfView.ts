import {
	App,
	EventRef,
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
import type { PenType } from "../ink/penStyle";
import { recognizeShape, shapePoints } from "../ink/shapes";
import { strokesInLasso, transformStrokes } from "../ink/lasso";
import { findScratchedStrokes } from "../scratch/detect";
import type GoodNodesPlugin from "../main";
import { debug } from "../debug";
import { createAnnotatedPdf } from "./export";
import { openPdf } from "./pdfjs";
import type { PdfDocumentProxy, PdfJsLib, PdfPageProxy, PdfRenderTask } from "./pdfjs";
import { displayedToUnrotated, unrotatedToDisplayed } from "./coordinates";
import { findEraserHits, splitStrokesByEraser } from "./eraser";
import { PdfHistory } from "./history";
import type { InkPoint, InkStroke, InkTool, PdfSidecar } from "./model";
import { isBoxItem, itemBox, newStrokeId } from "./model";
import { ImageCache, fontFamily, layoutText, paintItem } from "./items";
import { parseSidecar, serializeSidecar } from "./sidecar";
import { deleteSidecarPage, insertSidecarPages } from "./page-ops";
import { drawPaperTemplate } from "../notebook/paper";
import type { NotebookMeta } from "../notebook";
import { pickFiles } from "../files";
import { GoodNodesToolbar, type ToolbarTool } from "../toolbar/GoodNodesToolbar";
import { rememberToolColor, toolColors } from "../settings";
import "./pdf.css";

export const PDF_VIEW_TYPE = "goodnodes-pdf";
type PdfDoc = PdfDocumentProxy;
type PdfPage = PdfPageProxy;
/**
 * The size most pages have, used for every placeholder before a page is loaded.
 * Taking page 1 alone breaks books whose cover differs: every later page then
 * resized while scrolling, and the view jumped.
 */
async function typicalPageSize(doc: PdfDoc): Promise<{ width: number; height: number }> {
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
	task?: PdfRenderTask;
	page?: PdfPage;
	busy?: boolean;
	/** Drawn at an old zoom: stays on screen (scaled) until the sharp render replaces it. */
	stale?: boolean;
};
type Tool = ToolbarTool;
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
type SessionTool = { tool: Tool; color: string; width: number; pen: PenType };
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
let sessionTool: Tool = "pen";

export class PdfNotebookView extends FileView {
	navigation = true;
	zoom = 1;
	private plugin: GoodNodesPlugin;
	private doc: PdfDoc | null = null;
	private pdfjs: PdfJsLib | null = null;
	private scroller: HTMLElement;
	private pagesEl: HTMLElement;
	private toolbar: HTMLElement;
	private goodnodesToolbar: GoodNodesToolbar | null = null;
	private indicator: HTMLElement;
	private sidebar: HTMLElement | null = null;
	private sidebarContent: HTMLElement | null = null;
	private sidebarTab: SidebarTab = "pages";
	/** Saved sidebar state: a tab, "closed" (the user closed it), or null (never set). */
	private restoredSidebar: SidebarTab | "closed" | null = null;
	private sidebarClosedByUser = false;
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
	private holdTimer: number | null = null;
	private snapped = false;
	/** Lasso selection; `display` is its box in displayed (rotated) page units. */
	private selected: {
		page: number;
		strokes: InkStroke[];
		box: HTMLElement;
		display: { x: number; y: number; width: number; height: number };
	} | null = null;
	/** Dragging the selection (move) or one of its corner handles (resize). */
	private movingSelection: {
		pointerId: number;
		page: number;
		mode: "move" | "resize";
		old: InkStroke[];
		/** The page's other strokes, unchanged during the drag. */
		rest: InkStroke[];
		start: [number, number];
		/** Resize: the opposite corner stays put (unrotated page units). */
		anchor: [number, number];
		current: InkStroke[];
	} | null = null;
	private static clipboard: InkStroke[] = [];
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
	private imageCache: ImageCache;
	private textEditor: HTMLTextAreaElement | null = null;
	private editingText: { page: number; old?: InkStroke; item: InkStroke } | null = null;
	private imageInput: HTMLInputElement;
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
		this.fingersDown = event.touches.length;
		// A new swipe: page turns are measured from the page it starts on.
		if (event.touches.length === 1) {
			this.turnAnchor = this.currentPage;
			this.autoTurning = false;
		}
	};
	private touchMove = (event: TouchEvent) => {
		this.blockStylusTouch(event);
		this.syncPinch(event);
	};
	private touchEnd = (event: TouchEvent) => {
		this.syncPinch(event);
		this.fingersDown = event.touches.length;
		if (event.touches.length === 0) this.settleZoomedPage(true);
	};
	/** Book mode, zoomed in: page the current swipe started on, fingers on the glass. */
	private turnAnchor: number | null = null;
	private fingersDown = 0;
	private autoTurning = false;
	private settleTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: GoodNodesPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.imageCache = new ImageCache(this.app, (src) => this.redrawImage(src));
		this.toolState = {
			tool: sessionTool,
			color: plugin.settings.penColor,
			width: plugin.settings.penWidth,
			pen: plugin.settings.penType ?? "fountain",
		};
		this.contentEl.toggleClass("tool-text", this.toolState.tool === "text");
		this.contentEl.toggleClass("tool-shapes", this.toolState.tool === "shapes");
		this.contentEl.addClass("goodnodes-pdf-root");
		this.contentEl.toggleClass("is-horizontal", this.horizontal);
		this.scroller = this.contentEl.createDiv({ cls: "goodnodes-pdf-scroll" });
		// Obsidian doesn't call onResize for every size change (window resize, iPad rotation,
		// split view, our own sidebar), so watch the scroller directly.
		const resizeObserver = new ResizeObserver(() => window.requestAnimationFrame(() => this.onResize()));
		resizeObserver.observe(this.scroller);
		this.register(() => resizeObserver.disconnect());
		this.pagesEl = this.scroller.createDiv({ cls: "goodnodes-pdf-pages" });
		this.toolbar = this.contentEl.createDiv({ cls: "goodnodes-pdf-toolbar" });
		// Tapping the toolbar must not blur the text being edited: size, font and color apply to it.
		this.toolbar.addEventListener("mousedown", (event) => {
			if (this.textEditor && !(event.target as Element).closest("input")) event.preventDefault();
		});
		this.imageInput = createEl("input");
		this.imageInput.type = "file";
		this.imageInput.accept = "image/*";
		this.imageInput.hidden = true;
		this.contentEl.appendChild(this.imageInput);
		this.imageInput.onchange = () => void this.insertChosenImage(this.imageInput.files?.[0]);
		this.indicator = this.contentEl.createDiv({ cls: "goodnodes-pdf-indicator", text: "— / —" });
		this.scrubber = this.contentEl.createDiv({ cls: "goodnodes-pdf-scrubber" });
		this.scrubberThumb = this.scrubber.createDiv({ cls: "goodnodes-pdf-scrubber-thumb" });
		this.scrubberBubble = this.scrubber.createDiv({ cls: "goodnodes-pdf-scrubber-bubble" });
		this.buildToolbar();
		this.registerDomEvent(this.scroller, "scroll", () => {
			this.scheduleUpdate();
			this.showScrubber();
			if (this.turnAnchor === null) this.turnAnchor = this.currentPage;
			// Momentum or trackpad scrolling: check once the scrolling has stopped.
			if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
			this.settleTimer = window.setTimeout(() => {
				this.settleTimer = null;
				if (this.fingersDown === 0) this.settleZoomedPage(false);
			}, 140);
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
			(this.app.vault as unknown as { on(name: "raw", callback: (path: string) => void): EventRef }).on(
				"raw",
				(path: string) => {
					if (path === this.sidecarPath) void this.readExternalSidecar();
				},
			),
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
			this.pdfjs = (await loadPdfJs()) as PdfJsLib;
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
			window.requestAnimationFrame(() => this.onResize());
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
		this.commitTextEditor();
		await this.flushSave();
		this.goodnodesToolbar?.destroy();
		this.goodnodesToolbar = null;
	}

	private buildToolbar(): void {
		this.goodnodesToolbar = new GoodNodesToolbar(this.toolbar, {
			state: () => {
				const tool = this.toolState.tool;
				return {
					active: tool,
					color:
						tool === "text"
							? this.plugin.settings.canvasTextColor
							: tool === "shapes"
								? this.plugin.settings.shapeColor
								: this.toolState.color,
					colors: toolColors(this.plugin.settings, tool),
					width: this.toolState.width,
					widths:
						tool === "highlighter"
							? this.plugin.settings.highlighterWidths
							: this.plugin.settings.penWidths,
					penType: this.plugin.settings.penType,
					drawAndHold: this.plugin.settings.drawAndHold,
					eraserMode: this.plugin.settings.eraserMode,
					eraserSize: this.plugin.settings.eraserSize,
					eraserHighlighterOnly: this.plugin.settings.eraserHighlighterOnly,
					textSize: this.plugin.settings.canvasTextSize,
					textFont: this.plugin.settings.canvasTextFont,
					textAlign: this.plugin.settings.canvasTextAlign,
					shape: this.plugin.settings.shapeKind,
					canUndo: this.history.canUndo,
					canRedo: this.history.canRedo,
				};
			},
			supports: () => true,
			leading: (parent) => {
				const b = this.iconButton(
					parent,
					"panel-left",
					"Pages sidebar",
					() => this.toggleSidebar(),
					"goodnodes-toolbar-leading",
				);
				b.toggleClass("is-active", !!this.sidebar);
			},
			select: (tool) => {
				if (tool === "image") {
					this.imageInput.click();
					return;
				}
				this.selectTool(tool);
			},
			color: (tool, value, index) => {
				rememberToolColor(this.plugin.settings, tool, index, value);
				if (tool === "text") {
					this.plugin.settings.canvasTextColor = value;
					if (this.editingText) this.editingText.item.color = value;
					this.applyToolColor("text", value);
				} else if (tool === "shapes") {
					this.plugin.settings.shapeColor = value;
					this.applyToolColor("shapes", value);
				} else this.applyToolColor(tool === "highlighter" ? "highlighter" : "pen", value);
				this.scheduleSettingsSave();
			},
			width: (tool, value, index) => {
				if (tool === "highlighter") this.plugin.settings.highlighterWidths[index] = value;
				else this.plugin.settings.penWidths[index] = value;
				this.applyToolWidth(tool, value);
				this.goodnodesToolbar?.refresh();
			},
			setting: (key, value) => {
				if (key === "penType" && (value === "fountain" || value === "ball" || value === "brush")) {
					this.plugin.settings.penType = value;
					this.toolState.pen = value;
				}
				if (key === "drawAndHold") this.plugin.settings.drawAndHold = Boolean(value);
				if (key === "eraserMode" && (value === "precise" || value === "stroke"))
					this.plugin.settings.eraserMode = value;
				if (key === "eraserHighlighterOnly") this.plugin.settings.eraserHighlighterOnly = Boolean(value);
				if (key === "eraserSize") this.plugin.settings.eraserSize = Number(value);
				if (key === "textSize") {
					this.plugin.settings.canvasTextSize = Number(value);
					if (this.editingText) this.editingText.item.width = Number(value) * 0.6;
				}
				if (key === "textFont") {
					this.plugin.settings.canvasTextFont = Number(value);
					if (this.editingText) this.editingText.item.font = Number(value);
				}
				if (key === "textAlign" && (value === "left" || value === "center" || value === "right")) {
					this.plugin.settings.canvasTextAlign = value;
					if (this.editingText) this.editingText.item.align = value;
				}
				if (
					key === "shape" &&
					(value === "line" ||
						value === "arrow" ||
						value === "rectangle" ||
						value === "ellipse" ||
						value === "diamond")
				)
					this.plugin.settings.shapeKind = value;
				this.refreshEditorStyle();
				this.scheduleSettingsSave();
				this.goodnodesToolbar?.refresh();
			},
			undo: () => this.undo(),
			redo: () => this.redo(),
			more: (event) => this.showMore(event),
		});
		this.updateToolbar();
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
		this.goodnodesToolbar?.refresh();
	}

	private selectTool(tool: Tool): void {
		if (this.textEditor) this.commitTextEditor();
		this.clearSelection();
		sessionTool = tool;
		this.toolState.tool = tool;
		this.toolState.color =
			tool === "highlighter" ? this.plugin.settings.highlighterColor : this.plugin.settings.penColor;
		this.toolState.width =
			tool === "highlighter" ? this.plugin.settings.highlighterWidth : this.plugin.settings.penWidth;
		this.contentEl.toggleClass("tool-text", tool === "text");
		this.contentEl.toggleClass("tool-shapes", tool === "shapes");
		this.updateToolbar();
	}

	private showMore(event?: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(this.bookmarks.has(this.currentPage) ? "Remove bookmark" : "Bookmark page")
				.setIcon("bookmark")
				.onClick(() => this.toggleBookmark(this.currentPage)),
		);
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

	private applyToolColor(tool: InkTool | "text" | "shapes", color: string): void {
		if (tool === "highlighter") {
			this.plugin.settings.highlighterColor = color;
			this.toolState.color = color;
		} else if (tool === "text") {
			this.plugin.settings.canvasTextColor = color;
			this.toolState.color = color;
		} else if (tool === "shapes") {
			this.plugin.settings.shapeColor = color;
			this.toolState.color = color;
		} else {
			this.plugin.settings.penColor = color;
			this.toolState.color = color;
		}
		if (this.selected) {
			const { page, strokes } = this.selected,
				ids = new Set(strokes.map((s) => s.id));
			const updated = strokes.filter((s) => s.kind !== "image").map((s) => ({ ...s, color }));
			if (updated.length) {
				this.strokes.set(
					page,
					(this.strokes.get(page) ?? []).map((s) =>
						ids.has(s.id) ? (updated.find((item) => item.id === s.id) ?? s) : s,
					),
				);
				this.history.push({
					page,
					added: updated,
					removed: updated.map((item) => strokes.find((s) => s.id === item.id)!),
				});
				if (updated.length === strokes.length) this.clearSelection();
				else
					this.showSelection(
						page,
						strokes.map((s) => updated.find((item) => item.id === s.id) ?? s),
					);
				this.changed(page);
			}
		}
		this.updateToolbar();
		this.refreshEditorStyle();
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
		this.goodnodesToolbar?.refresh();
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
			this.pagesEl.setCssProps({
				"--goodnodes-page-padding-left": "16px",
				"--goodnodes-page-padding-right": "16px",
				"--goodnodes-page-gap": "12px",
			});
			return;
		}
		// Like a book: at fit zoom the neighbouring pages stay just off screen, so only
		// the current page shows; zoomed in, a normal gap.
		const pageWidth = this.baseWidth * this.pageScale * this.zoom;
		const gap = this.zoom <= 1.001 ? Math.max(24, (this.scroller.clientWidth - pageWidth) / 2 + 12) : 24;
		this.pagesEl.setCssProps({ "--goodnodes-page-gap": `${gap}px` });
		const firstPadding = Math.max(16, (this.scroller.clientWidth - this.slots[0].el.offsetWidth) / 2);
		const last = this.slots[this.slots.length - 1];
		const lastPadding = Math.max(16, (this.scroller.clientWidth - last.el.offsetWidth) / 2);
		this.pagesEl.setCssProps({
			"--goodnodes-page-padding-left": `${firstPadding}px`,
			"--goodnodes-page-padding-right": `${lastPadding}px`,
		});
	}

	private updateSnapping(): void {
		this.scroller.toggleClass(
			"is-snapping",
			this.horizontal && this.zoom <= 1.001 && !this.pinch && !this.scrubberDragging,
		);
	}

	/**
	 * Book mode while zoomed in: pulling a page further than a short distance past its
	 * edge turns to the neighbouring page (aligned at that edge, same zoom and height);
	 * a shorter pull springs back, so a page never rests half off screen.
	 * `released`: the finger just lifted (momentum may still follow).
	 */
	private settleZoomedPage(released: boolean): void {
		if (!this.horizontal || this.zoom <= 1.001 || this.pinch || this.scrubberDragging || !this.slots.length) return;
		if (this.autoTurning) {
			// Our own smooth scroll has finished.
			if (!released) {
				this.autoTurning = false;
				this.turnAnchor = null;
			}
			return;
		}
		const view = this.scroller.clientWidth;
		const viewLeft = this.scroller.scrollLeft;
		const viewRight = viewLeft + view;
		let anchor = Math.max(0, Math.min(this.slots.length - 1, this.turnAnchor ?? this.currentPage));
		const overlaps = (i: number) =>
			this.slots[i].el.offsetLeft < viewRight &&
			this.slots[i].el.offsetLeft + this.slots[i].el.offsetWidth > viewLeft;
		// A jump (thumbnail, outline, fling across pages) left the swipe's page entirely:
		// measure from the page now in the middle instead.
		if (!overlaps(anchor)) {
			const center = viewLeft + view / 2;
			anchor = this.slots.reduce(
				(best, slot, i) =>
					Math.abs(slot.el.offsetLeft + slot.el.offsetWidth / 2 - center) <
					Math.abs(this.slots[best].el.offsetLeft + this.slots[best].el.offsetWidth / 2 - center)
						? i
						: best,
				0,
			);
		}
		const slot = this.slots[anchor];
		const left = slot.el.offsetLeft;
		const right = left + slot.el.offsetWidth;
		const threshold = Math.min(120, view * 0.15);
		let target: number | null = null;
		if (slot.el.offsetWidth <= view) {
			const offset = viewLeft + view / 2 - (left + right) / 2;
			if (offset > threshold && anchor < this.slots.length - 1) target = this.edgeScroll(anchor + 1, "start");
			else if (offset < -threshold && anchor > 0) target = this.edgeScroll(anchor - 1, "end");
			else if (!released) target = left - (view - slot.el.offsetWidth) / 2;
		} else if (viewRight - right > threshold && anchor < this.slots.length - 1) {
			target = this.edgeScroll(anchor + 1, "start");
		} else if (left - viewLeft > threshold && anchor > 0) {
			target = this.edgeScroll(anchor - 1, "end");
		} else if (!released) {
			// Spring back once momentum is over (while it runs it may still turn the page).
			if (viewRight > right) target = right - view;
			else if (viewLeft < left) target = left;
		}
		if (target === null) {
			if (!released) this.turnAnchor = null;
			return;
		}
		this.autoTurning = true;
		this.scroller.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
	}

	/** scrollLeft that shows a zoomed page from its left ("start") or right ("end") edge. */
	private edgeScroll(index: number, edge: "start" | "end"): number {
		const el = this.slots[index].el;
		const view = this.scroller.clientWidth;
		if (el.offsetWidth <= view) return el.offsetLeft - (view - el.offsetWidth) / 2;
		return edge === "start" ? el.offsetLeft : el.offsetLeft + el.offsetWidth - view;
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
		if (!this.doc) return;
		const doc = this.doc;
		this.observer?.disconnect();
		this.slots = [];
		this.pagesEl.empty();
		for (let i = 0; i < doc.numPages; i++) {
			const el = this.pagesEl.createDiv({ cls: "goodnodes-pdf-page" });
			el.dataset.page = String(i);
			el.setCssProps({
				"--goodnodes-page-width": `${this.baseWidth * this.pageScale * this.zoom}px`,
				"--goodnodes-page-height": `${this.baseHeight * this.pageScale * this.zoom}px`,
			});
			this.slots.push({
				el,
				width: this.baseWidth,
				height: this.baseHeight,
				unrotatedWidth: this.baseWidth,
				unrotatedHeight: this.baseHeight,
				rotation: 0,
			});
		}
		const addTile = this.pagesEl.createEl("button", { cls: "goodnodes-pdf-add-page", text: "Add page" });
		addTile.setCssProps({
			"--goodnodes-page-width": `${this.baseWidth * this.pageScale * this.zoom * (this.horizontal ? 0.3 : 1)}px`,
			"--goodnodes-page-height": `${this.baseHeight * this.pageScale * this.zoom * (this.horizontal ? 1 : 0.3)}px`,
		});
		addTile.onclick = () => void this.insertBlankPage(this.slots.length);
		this.updatePagePadding();
		this.refreshEditorStyle();
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
		this.raf = window.requestAnimationFrame(() => {
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
		if (pageChanged) this.clearSelection();
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
				slot.el.setCssProps({
					"--goodnodes-page-width": `${raw.width * this.pageScale * this.zoom}px`,
					"--goodnodes-page-height": `${raw.height * this.pageScale * this.zoom}px`,
				});
				this.updatePagePadding();
				this.restoreAnchor(anchor);
			}
			const scale = this.pageScale * this.zoom;
			const viewport = page.getViewport({ scale });
			const dpr = Math.max(1, window.devicePixelRatio || 1);
			const pixelScale = Math.min(dpr, Math.sqrt(4_000_000 / (viewport.width * viewport.height)));
			canvas = createEl("canvas");
			canvas.className = "goodnodes-pdf-canvas";
			canvas.width = Math.max(1, Math.floor(viewport.width * pixelScale));
			canvas.height = Math.max(1, Math.floor(viewport.height * pixelScale));
			// Fill the page box: if zoom/fit changed while this page was rendering, it is
			// briefly blurry instead of drawn at the wrong size (the "broken first page").
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
		const canvas = createEl("canvas");
		canvas.className = className;
		// Ink is as sharp as the page itself (≤ 4 MP, see renderPage); the live layer is
		// sized lazily in drawLive and freed after each stroke.
		const scale = 1;
		canvas.width = Math.max(1, Math.floor(base.width * scale));
		canvas.height = Math.max(1, Math.floor(base.height * scale));
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
		// Book mode: the scrubber runs along the bottom, in the direction pages turn.
		const axis = this.horizontal ? "X" : "Y";
		const available = this.horizontal
			? Math.max(0, this.scrubber.clientWidth - this.scrubberThumb.offsetWidth)
			: Math.max(0, this.scrubber.clientHeight - this.scrubberThumb.offsetHeight);
		const offset = fraction * available;
		this.scrubberThumb.setCssProps({ "--goodnodes-scrubber-transform": `translate${axis}(${offset}px)` });
		this.scrubberBubble.setCssProps({ "--goodnodes-scrubber-transform": `translate${axis}(${offset}px)` });
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
		this.scrubberPendingY = this.horizontal ? event.clientX : event.clientY;
		this.applyScrubberPosition(this.scrubberPendingY);
	}

	private scrubberMove(event: PointerEvent): void {
		if (!this.scrubberDragging || event.pointerId !== this.scrubberPointer) return;
		event.preventDefault();
		this.scrubberPendingY = this.horizontal ? event.clientX : event.clientY;
		if (this.scrubberRaf) return;
		this.scrubberRaf = window.requestAnimationFrame(() => {
			this.scrubberRaf = 0;
			this.applyScrubberPosition(this.scrubberPendingY);
		});
	}

	/** `position`: clientX in book mode (scrubber along the bottom), clientY when scrolling vertically. */
	private applyScrubberPosition(position: number): void {
		const rect = this.scrubber.getBoundingClientRect();
		const ratio = this.horizontal
			? Math.max(0, Math.min(1, (position - rect.left) / rect.width))
			: Math.max(0, Math.min(1, (position - rect.top) / rect.height));
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
					slot.el.setCssProps({
						"--goodnodes-page-width": `${slot.width * this.pageScale * this.zoom}px`,
						"--goodnodes-page-height": `${slot.height * this.pageScale * this.zoom}px`,
					});
				}
			} else {
				this.relayout(() => (this.pageScale = next));
			}
			this.updateAddPageTile();
			this.updatePagePadding();
		}
		this.updatePagePadding();
		this.refreshEditorStyle();
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
			slot.el.setCssProps({
				"--goodnodes-page-width": `${slot.width * this.pageScale * this.zoom}px`,
				"--goodnodes-page-height": `${slot.height * this.pageScale * this.zoom}px`,
			});
		}
		this.updateAddPageTile();
		this.updatePagePadding();
		this.positionSelectionBox();
		this.refreshEditorStyle();
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
		tile.setCssProps({
			"--goodnodes-page-width": `${this.baseWidth * this.pageScale * this.zoom * (this.horizontal ? 0.3 : 1)}px`,
			"--goodnodes-page-height": `${this.baseHeight * this.pageScale * this.zoom * (this.horizontal ? 1 : 0.3)}px`,
		});
	}

	private pointerDown(event: PointerEvent): void {
		debug.pointer("pdf", event);
		if ((event.target as Element).closest(".goodnodes-pdf-text-editor")) return;
		if ((event.target as Element).closest(".goodnodes-pdf-selection-actions, .goodnodes-pdf-paste-bubble")) return;
		if (event.pointerType === "pen") this.penUntil = Date.now() + 250;
		// Fingers scroll natively and pinch via TouchEvents (syncPinch); they never draw.
		if (event.pointerType === "touch") {
			if (this.textEditor && event.target !== this.textEditor) this.commitTextEditor();
			return;
		}
		this.pointers.set(event.pointerId, event);
		if (event.pointerType !== "pen" && event.pointerType !== "mouse") return;
		if (event.pointerType === "pen") this.penDown = true;
		if (this.textEditor && event.target !== this.textEditor) this.commitTextEditor();
		const selectionBox = (event.target as Element).closest<HTMLElement>(".goodnodes-pdf-selection");
		if (selectionBox && this.toolState.tool === "lasso" && this.selected) {
			const point = this.pagePoint(event, this.selected.page);
			if (point) {
				const { page, strokes, display } = this.selected;
				const handle = (event.target as Element).closest<HTMLElement>(".goodnodes-pdf-selection-handle");
				const ids = new Set(strokes.map((stroke) => stroke.id));
				let anchor: [number, number] = point;
				if (handle) {
					// Handles are top-left, top-right, bottom-right, bottom-left; scale around the opposite one.
					const corners: [number, number][] = [
						[display.x, display.y],
						[display.x + display.width, display.y],
						[display.x + display.width, display.y + display.height],
						[display.x, display.y + display.height],
					];
					const [ox, oy] = corners[(Number(handle.dataset.corner) + 2) % 4];
					anchor = displayedToUnrotated(ox, oy, rotationInfo(this.slots[page]));
				}
				this.movingSelection = {
					pointerId: event.pointerId,
					page,
					mode: handle ? "resize" : "move",
					old: strokes,
					rest: (this.strokes.get(page) ?? []).filter((stroke) => !ids.has(stroke.id)),
					start: point,
					anchor,
					current: strokes,
				};
				try {
					selectionBox.setPointerCapture(event.pointerId);
				} catch {
					/* ignore */
				}
				event.preventDefault();
				event.stopPropagation();
			}
			return;
		}
		if (
			this.toolState.tool !== "lasso" &&
			this.selected &&
			!(event.target as Element).closest(".goodnodes-pdf-selection")
		)
			this.clearSelection();
		const hit = this.pageAt(event);
		if (!hit) return;
		this.activeStroke = { pointerId: event.pointerId, page: hit[0], points: [hit[1]], tool: this.toolState.tool };
		this.snapped = false;
		if (this.toolState.tool === "pen" && this.plugin.settings.drawAndHold) {
			this.holdTimer = window.setTimeout(() => {
				const active = this.activeStroke;
				if (!active || active.pointerId !== event.pointerId || active.points.length < 5) return;
				const shape = recognizeShape(active.points.map(([x, y]) => [x, y]));
				if (shape) {
					active.points = shape.points.map(([x, y]) => [x, y, 0.5]);
					this.snapped = true;
					this.drawLive(active.page);
				}
			}, 600);
		}
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
		if (this.movingSelection?.pointerId === event.pointerId) {
			const drag = this.movingSelection;
			const point = this.pagePoint(event, drag.page);
			if (!point || !this.selected) return;
			let transform = {
				dx: point[0] - drag.start[0],
				dy: point[1] - drag.start[1],
				scale: 1,
				originX: 0,
				originY: 0,
			};
			if (drag.mode === "resize") {
				const from = Math.hypot(drag.start[0] - drag.anchor[0], drag.start[1] - drag.anchor[1]);
				const to = Math.hypot(point[0] - drag.anchor[0], point[1] - drag.anchor[1]);
				const scale = Math.max(0.1, Math.min(10, from > 0 ? to / from : 1));
				transform = { dx: 0, dy: 0, scale, originX: drag.anchor[0], originY: drag.anchor[1] };
			}
			drag.current = transformStrokes(drag.old, transform);
			this.strokes.set(drag.page, [...drag.rest, ...drag.current]);
			this.selected.strokes = drag.current;
			this.positionSelectionBox();
			this.drawCommittedInk(drag.page);
			event.preventDefault();
			return;
		}
		if (!this.activeStroke || event.pointerId !== this.activeStroke.pointerId) return;
		if (this.snapped) {
			event.preventDefault();
			return;
		}
		const events = event.getCoalescedEvents?.() ?? [event];
		for (const item of events) {
			const hit = this.pageAt(item);
			if (hit && hit[0] === this.activeStroke.page) this.activeStroke.points.push(hit[1]);
		}
		if (this.activeStroke.tool === "pen" && this.plugin.settings.drawAndHold && !this.snapped) {
			if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
			const pointerId = this.activeStroke.pointerId,
				page = this.activeStroke.page;
			this.holdTimer = window.setTimeout(() => {
				const active = this.activeStroke;
				if (!active || active.pointerId !== pointerId || active.points.length < 5) return;
				const shape = recognizeShape(active.points.map(([x, y]) => [x, y]));
				if (shape) {
					active.points = shape.points.map(([x, y]) => [x, y, 0.5]);
					this.snapped = true;
					this.drawLive(page);
				}
			}, 600);
		}
		this.drawLive(this.activeStroke.page);
		event.preventDefault();
	}

	private pointerUp(event: PointerEvent): void {
		debug.pointer("pdf", event);
		if (event.pointerType === "pen") this.penUntil = Date.now() + 250;
		if (event.pointerType === "pen") this.penDown = false;
		this.pointers.delete(event.pointerId);
		if (this.movingSelection?.pointerId === event.pointerId) {
			const drag = this.movingSelection;
			this.movingSelection = null;
			if (drag.current !== drag.old) {
				this.history.push({ page: drag.page, added: drag.current, removed: drag.old });
				this.changed(drag.page);
			}
			return;
		}
		if (!this.activeStroke || event.pointerId !== this.activeStroke.pointerId) return;
		const { page, points, tool } = this.activeStroke;
		if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
		this.holdTimer = null;
		this.snapped = false;
		this.activeStroke = null;
		if (tool === "text") this.finishTextGesture(page, points);
		else if (tool === "shapes") this.commitShape(page, points);
		else if (tool === "eraser") this.commitEraser(page, points);
		else if (tool === "lasso") this.selectLasso(page, points);
		else if (tool === "pen" || tool === "highlighter") this.commitInk(page, points, tool);
		// The live layer only exists while a stroke is in progress (saves a full-page canvas per page).
		const live = this.slots[page]?.live;
		if (live) live.width = live.height = 0;
	}

	private finishTextGesture(page: number, points: InkPoint[]): void {
		const a = points[0],
			b = points[points.length - 1],
			slot = this.slots[page];
		const dragged = Math.hypot(b[0] - a[0], b[1] - a[1]) > 4;
		if (!dragged) {
			const existing = (this.strokes.get(page) ?? []).find((item) => {
				if (item.kind !== "text") return false;
				const box = itemBox(item);
				return a[0] >= box.x && a[0] <= box.x + box.width && a[1] >= box.y && a[1] <= box.y + box.height;
			});
			if (existing) {
				this.openTextEditor(page, existing);
				return;
			}
			const available = slot.unrotatedWidth - a[0] - 8;
			const width = Math.max(60, Math.min(260, available));
			const size = this.plugin.settings.canvasTextSize * 0.6;
			this.openTextEditor(page, {
				id: newStrokeId(),
				tool: "pen",
				color: this.plugin.settings.canvasTextColor,
				width: size,
				kind: "text",
				text: "",
				font: this.plugin.settings.canvasTextFont,
				align: this.plugin.settings.canvasTextAlign,
				points: [
					[a[0], a[1], 0.5],
					[a[0] + width, a[1] + size * 1.25, 0.5],
				],
			});
			return;
		}
		const x = Math.min(a[0], b[0]),
			y = Math.min(a[1], b[1]);
		const size = Math.max(6, Math.min(96, Math.abs(b[1] - a[1]) / 1.25));
		this.openTextEditor(page, {
			id: newStrokeId(),
			tool: "pen",
			color: this.plugin.settings.canvasTextColor,
			width: size,
			kind: "text",
			text: "",
			font: this.plugin.settings.canvasTextFont,
			align: this.plugin.settings.canvasTextAlign,
			points: [
				[x, y, 0.5],
				[x + Math.abs(b[0] - a[0]), y + Math.abs(b[1] - a[1]), 0.5],
			],
		});
	}

	private openTextEditor(page: number, item: InkStroke): void {
		const slot = this.slots[page];
		this.editingText = {
			page,
			old: (this.strokes.get(page) ?? []).find((s) => s.id === item.id),
			item: { ...item },
		};
		const editor = slot.el.createEl("textarea", { cls: "goodnodes-pdf-text-editor" });
		this.textEditor = editor;
		editor.value = item.text ?? "";
		editor.spellcheck = true;
		this.refreshEditorStyle();
		editor.addEventListener("input", () => this.refreshEditorStyle());
		editor.addEventListener("blur", () =>
			window.setTimeout(() => {
				if (this.textEditor !== editor) return;
				if (document.activeElement && this.toolbar.contains(document.activeElement)) return;
				this.commitTextEditor();
			}, 0),
		);
		editor.addEventListener("keydown", (event) => {
			if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
				event.preventDefault();
				this.commitTextEditor();
			}
		});
		this.drawCommittedInk(page);
		// Keep focus in the pointerup gesture for the iOS keyboard.
		editor.focus();
	}

	private refreshEditorStyle(): void {
		const editor = this.textEditor,
			active = this.editingText;
		if (!editor || !active) return;
		const { page, item } = active,
			slot = this.slots[page],
			box = itemBox(item),
			scale = this.pageScale * this.zoom;
		const a = unrotatedToDisplayed(box.x, box.y, rotationInfo(slot));
		const b = unrotatedToDisplayed(box.x + box.width, box.y + box.height, rotationInfo(slot));
		editor.setCssProps({
			"--goodnodes-editor-left": `${Math.min(a[0], b[0]) * scale}px`,
			"--goodnodes-editor-top": `${Math.min(a[1], b[1]) * scale}px`,
			"--goodnodes-editor-width": `${Math.abs(b[0] - a[0]) * scale}px`,
			"--goodnodes-editor-font": `${item.width * scale}px ${fontFamily(item.font)}`,
			"--goodnodes-editor-color": item.color,
			"--goodnodes-editor-align": item.align ?? "left",
		});
		// Grow with the content (the textarea's own wrapping decides the line count).
		editor.setCssProps({ "--goodnodes-editor-height": "0px" });
		editor.setCssProps({
			"--goodnodes-editor-height": `${Math.max(item.width * 1.25 * scale, editor.scrollHeight)}px`,
		});
	}

	private commitTextEditor(): void {
		const editor = this.textEditor,
			active = this.editingText;
		if (!editor || !active) return;
		this.textEditor = null;
		this.editingText = null;
		editor.remove();
		const text = editor.value,
			page = active.page;
		const old = active.old;
		if (!text.trim()) {
			if (old) {
				this.strokes.set(
					page,
					(this.strokes.get(page) ?? []).filter((s) => s.id !== old.id),
				);
				this.history.push({ page, added: [], removed: [old] });
				this.changed(page);
			} else this.drawCommittedInk(page);
			return;
		}
		const item = { ...active.item, id: newStrokeId(), text };
		const box = itemBox(item),
			measure = createEl("canvas").getContext("2d")!;
		measure.font = `${item.width}px ${fontFamily(item.font)}`;
		const lines = layoutText(text, box.width, (line) => measure.measureText(line).width);
		item.points[1][1] = box.y + lines.length * item.width * 1.25;
		const existing = this.strokes.get(page) ?? [];
		this.strokes.set(page, [...existing.filter((s) => s.id !== old?.id), item]);
		if (
			old &&
			old.text === item.text &&
			old.color === item.color &&
			old.width === item.width &&
			old.font === item.font &&
			old.align === item.align
		) {
			this.strokes.set(page, existing);
			this.drawCommittedInk(page);
			return;
		}
		this.history.push({ page, added: [item], removed: old ? [old] : [] });
		this.changed(page);
	}

	private commitShape(page: number, points: InkPoint[]): void {
		if (!points.length) return;
		const a = points[0],
			b = points[points.length - 1];
		if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 3) return;
		const shape = shapePoints(this.plugin.settings.shapeKind, [a[0], a[1]], [b[0], b[1]]).map(
			([x, y]) => [x, y, 0.5] as InkPoint,
		);
		const item: InkStroke = {
			id: newStrokeId(),
			tool: "pen",
			pen: "ball",
			color: this.plugin.settings.shapeColor,
			width: this.plugin.settings.penWidth,
			points: shape,
		};
		this.strokes.set(page, [...(this.strokes.get(page) ?? []), item]);
		this.history.push({ page, added: [item], removed: [] });
		this.changed(page);
	}

	private async insertChosenImage(file?: File): Promise<void> {
		if (!file || !(this.file instanceof TFile)) return;
		this.imageInput.value = "";
		try {
			const extension = file.name.split(".").pop()?.toLowerCase() || "png";
			const name = `GoodNodes image ${Date.now()}.${extension}`;
			let path: string;
			if (this.plugin.settings.imageFolder.trim()) {
				const folder = this.plugin.settings.imageFolder.replace(/\/$/, "");
				if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
				path = `${folder}/${name}`;
			} else path = await this.app.fileManager.getAvailablePathForAttachment(name, this.file.path);
			if (this.plugin.settings.imageFolder.trim()) {
				const stem = path.replace(/\.[^.]+$/, ""),
					suffix = path.match(/\.[^.]+$/)?.[0] ?? `.${extension}`;
				let index = 2;
				while (await this.app.vault.adapter.exists(path)) path = `${stem} ${index++}${suffix}`;
			}
			await this.app.vault.createBinary(path, await file.arrayBuffer());
			const url = URL.createObjectURL(file),
				image = new Image();
			await new Promise<void>((resolve, reject) => {
				image.onload = () => resolve();
				image.onerror = () => reject(new Error("Could not read image"));
				image.src = url;
			});
			URL.revokeObjectURL(url);
			const page = this.currentPage,
				slot = this.slots[page];
			const width = Math.min(
				slot.unrotatedWidth * 0.6,
				(slot.unrotatedHeight * 0.6 * image.naturalWidth) / image.naturalHeight,
			);
			const height = (width * image.naturalHeight) / image.naturalWidth;
			const x = (slot.unrotatedWidth - width) / 2,
				y = (slot.unrotatedHeight - height) / 2;
			const item: InkStroke = {
				id: newStrokeId(),
				tool: "pen",
				color: "#ffffff",
				width: 1,
				kind: "image",
				src: path,
				points: [
					[x, y, 0.5],
					[x + width, y + height, 0.5],
				],
			};
			this.strokes.set(page, [...(this.strokes.get(page) ?? []), item]);
			this.history.push({ page, added: [item], removed: [] });
			this.changed(page);
			this.selectTool("lasso");
			this.showSelection(page, [item]);
			this.drawCommittedInk(page);
		} catch (error) {
			new Notice(`Could not insert image: ${String(error)}`);
		}
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
			pen: tool === "pen" ? this.toolState.pen : undefined,
			points,
		};
		const existing = this.strokes.get(page) ?? [];
		if (tool === "pen" && this.plugin.settings.scratchEnabled) {
			const candidates = existing
				.filter((item) => !isBoxItem(item))
				.map((item) => ({
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
		const ink = existing.filter((s) => !isBoxItem(s));
		const candidates = this.plugin.settings.eraserHighlighterOnly
			? ink.filter((s) => s.tool === "highlighter")
			: ink;
		if (this.plugin.settings.eraserMode === "precise") {
			const result = splitStrokesByEraser(
				points,
				candidates,
				this.plugin.settings.eraserSize / (this.pageScale * this.zoom),
			);
			if (!result.removed.length) return;
			const removedIds = new Set(result.removed.map((s) => s.id));
			const unaffected = existing.filter((s) => !removedIds.has(s.id));
			this.strokes.set(page, [...unaffected, ...result.added]);
			this.history.push({ page, added: result.added, removed: result.removed });
			this.changed(page);
			return;
		}
		const ids = new Set(
			findEraserHits(points, candidates, this.plugin.settings.eraserSize / (this.pageScale * this.zoom)),
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

	private selectLasso(page: number, points: InkPoint[]): void {
		this.clearSelection();
		if (points.length < 3) {
			if (PdfNotebookView.clipboard.length) {
				const slot = this.slots[page],
					origin = points[0],
					[x, y] = unrotatedToDisplayed(origin[0], origin[1], rotationInfo(slot));
				slot.el.querySelector(".goodnodes-pdf-paste-bubble")?.remove();
				const bubble = slot.el.createEl("button", { cls: "goodnodes-pdf-paste-bubble", text: "Paste" });
				bubble.setCssProps({
					"--goodnodes-item-left": `${x * this.pageScale * this.zoom}px`,
					"--goodnodes-item-top": `${y * this.pageScale * this.zoom}px`,
				});
				bubble.onpointerdown = (event) => event.stopPropagation();
				bubble.onclick = (event) => {
					event.stopPropagation();
					bubble.remove();
					this.pasteClipboard(page, origin);
				};
			}
			return;
		}
		const selected = strokesInLasso(
			points.map(([x, y]) => [x, y]),
			this.strokes.get(page) ?? [],
		);
		if (!selected.length) return;
		this.showSelection(page, selected);
	}

	/** GoodNotes-style selection: dashed box, corner handles, action bar above it. */
	private showSelection(page: number, strokes: InkStroke[]): void {
		this.clearSelection();
		const slot = this.slots[page];
		if (!slot || !strokes.length) return;
		const box = slot.el.createDiv({ cls: "goodnodes-pdf-selection" });
		for (let corner = 0; corner < 4; corner++)
			box.createSpan({ cls: "goodnodes-pdf-selection-handle" }).dataset.corner = String(corner);
		const bar = box.createDiv({ cls: "goodnodes-pdf-selection-actions" });
		const action = (icon: string, title: string, fn: () => void) =>
			this.iconButton(bar, icon, title, fn, "goodnodes-pdf-selection-action");
		const current = () => this.selected?.strokes ?? [];
		const copy = () =>
			(PdfNotebookView.clipboard = current().map((stroke) => ({
				...stroke,
				points: stroke.points.map((point) => [...point] as InkPoint),
			})));
		action("scissors", "Cut", () => {
			copy();
			this.deleteSelection();
		});
		action("copy", "Copy", copy);
		action("trash-2", "Delete", () => this.deleteSelection());
		const colorButton = action("palette", "Color", () => {
			const open = bar.querySelector(".goodnodes-pdf-selection-colors");
			if (open) {
				open.remove();
				return;
			}
			const row = bar.createDiv({ cls: "goodnodes-pdf-selection-colors" });
			for (const color of PEN_COLORS) {
				const swatch = row.createEl("button", { cls: "goodnodes-pdf-swatch", attr: { title: color } });
				swatch.style.setProperty("--goodnodes-swatch", color);
				swatch.onclick = () => this.recolorSelection(color);
			}
		});
		colorButton.addClass("goodnodes-pdf-selection-color-toggle");
		action("copy-plus", "Duplicate", () => this.duplicateSelection());
		this.selected = { page, strokes, box, display: { x: 0, y: 0, width: 0, height: 0 } };
		this.positionSelectionBox();
	}

	/** Fit the box to the selected strokes at the current zoom (after moves, resizes and zooms). */
	private positionSelectionBox(): void {
		const selection = this.selected;
		if (!selection) return;
		const slot = this.slots[selection.page];
		const points = selection.strokes.flatMap((stroke) => {
			const margin = isBoxItem(stroke) ? 4 : stroke.width / 2 + 4;
			return stroke.points.flatMap((p) => {
				const [x, y] = unrotatedToDisplayed(p[0], p[1], rotationInfo(slot));
				return [
					[x - margin, y - margin],
					[x + margin, y + margin],
				];
			});
		});
		if (!points.length) return;
		const xs = points.map((p) => p[0]),
			ys = points.map((p) => p[1]);
		const display = {
			x: Math.min(...xs),
			y: Math.min(...ys),
			width: Math.max(...xs) - Math.min(...xs),
			height: Math.max(...ys) - Math.min(...ys),
		};
		selection.display = display;
		const scale = this.pageScale * this.zoom;
		selection.box.setCssProps({
			"--goodnodes-selection-left": `${display.x * scale}px`,
			"--goodnodes-selection-top": `${display.y * scale}px`,
			"--goodnodes-selection-width": `${Math.max(24, display.width * scale)}px`,
			"--goodnodes-selection-height": `${Math.max(24, display.height * scale)}px`,
		});
		// No room above the box (top of the page): the action bar goes below it.
		selection.box.toggleClass("is-bar-below", display.y * scale < 52);
	}

	private recolorSelection(color: string): void {
		const selection = this.selected;
		if (!selection) return;
		const recolorable = selection.strokes.filter((stroke) => stroke.kind !== "image");
		if (!recolorable.length) return;
		const ids = new Set(recolorable.map((stroke) => stroke.id));
		const recolored = recolorable.map((stroke) => ({ ...stroke, id: newStrokeId(), color }));
		this.strokes.set(selection.page, [
			...(this.strokes.get(selection.page) ?? []).filter((stroke) => !ids.has(stroke.id)),
			...recolored,
		]);
		this.history.push({ page: selection.page, added: recolored, removed: recolorable });
		selection.strokes = [...selection.strokes.filter((stroke) => stroke.kind === "image"), ...recolored];
		this.changed(selection.page);
	}

	/** Pointer position in unrotated page units of `page`, even outside the page element. */
	private pagePoint(event: PointerEvent, page: number): [number, number] | null {
		const slot = this.slots[page];
		if (!slot) return null;
		const rect = slot.el.getBoundingClientRect(),
			scale = this.pageScale * this.zoom;
		return displayedToUnrotated(
			(event.clientX - rect.left) / scale,
			(event.clientY - rect.top) / scale,
			rotationInfo(slot),
		);
	}

	private pasteClipboard(page: number, origin: InkPoint): void {
		const source = PdfNotebookView.clipboard.flatMap((s) => s.points);
		if (!source.length) return;
		const cx = source.reduce((n, p) => n + p[0], 0) / source.length,
			cy = source.reduce((n, p) => n + p[1], 0) / source.length;
		const pasted = PdfNotebookView.clipboard.map((s) => ({
			...s,
			id: newStrokeId(),
			points: s.points.map(([x, y, pressure]) => [x + origin[0] - cx, y + origin[1] - cy, pressure] as InkPoint),
		}));
		this.strokes.set(page, [...(this.strokes.get(page) ?? []), ...pasted]);
		this.history.push({ page, added: pasted, removed: [] });
		this.changed(page);
		this.showSelection(page, pasted);
	}

	private clearSelection(): void {
		this.selected?.box.remove();
		this.selected = null;
	}
	private deleteSelection(): void {
		if (!this.selected) return;
		const { page, strokes } = this.selected,
			ids = new Set(strokes.map((s) => s.id));
		this.strokes.set(
			page,
			(this.strokes.get(page) ?? []).filter((s) => !ids.has(s.id)),
		);
		this.history.push({ page, added: [], removed: strokes });
		this.clearSelection();
		this.changed(page);
	}
	private duplicateSelection(): void {
		if (!this.selected) return;
		const { page, strokes } = this.selected;
		const copies = strokes.map((s) => ({
			...s,
			id: newStrokeId(),
			points: s.points.map(([x, y, p]) => [x + 12, y + 12, p] as InkPoint),
		}));
		this.strokes.set(page, [...(this.strokes.get(page) ?? []), ...copies]);
		this.history.push({ page, added: copies, removed: [] });
		this.changed(page);
		this.showSelection(page, copies);
	}

	private drawCommittedInk(page: number): void {
		const canvas = this.slots[page]?.ink;
		if (!canvas) return;
		const ctx = canvas.getContext("2d")!;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		for (const stroke of this.strokes.get(page) ?? []) {
			if (stroke.id !== this.editingText?.item.id) this.paintStroke(ctx, stroke, canvas);
		}
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
		if (this.activeStroke.tool === "lasso") {
			const slot = this.slots[page],
				scale = this.pageScale * this.zoom,
				factor = canvas.width / (slot.width * scale);
			ctx.beginPath();
			ctx.setLineDash([5 * factor, 4 * factor]);
			ctx.lineWidth = 1.5 * factor;
			ctx.strokeStyle = "var(--interactive-accent)";
			this.activeStroke.points.forEach(([x, y], i) => {
				const [dx, dy] = unrotatedToDisplayed(x, y, rotationInfo(slot));
				if (i) ctx.lineTo(dx * scale * factor, dy * scale * factor);
				else ctx.moveTo(dx * scale * factor, dy * scale * factor);
			});
			ctx.strokeStyle =
				getComputedStyle(this.contentEl).getPropertyValue("--interactive-accent").trim() || "#7c5cff";
			ctx.stroke();
			ctx.setLineDash([]);
			return;
		}
		if (this.activeStroke.tool === "text") {
			const a = this.activeStroke.points[0],
				b = this.activeStroke.points[this.activeStroke.points.length - 1];
			const [ax, ay] = unrotatedToDisplayed(a[0], a[1], rotationInfo(slot));
			const [bx, by] = unrotatedToDisplayed(b[0], b[1], rotationInfo(slot));
			const scale = this.pageScale * this.zoom,
				factor = canvas.width / (slot.width * scale);
			ctx.setLineDash([5 * factor, 4 * factor]);
			ctx.strokeStyle =
				getComputedStyle(this.contentEl).getPropertyValue("--interactive-accent").trim() || "#7c5cff";
			ctx.lineWidth = 1.5 * factor;
			ctx.strokeRect(
				Math.min(ax, bx) * scale * factor,
				Math.min(ay, by) * scale * factor,
				Math.abs(bx - ax) * scale * factor,
				Math.abs(by - ay) * scale * factor,
			);
			ctx.setLineDash([]);
			return;
		}
		if (this.activeStroke.tool === "shapes") {
			const a = this.activeStroke.points[0],
				b = this.activeStroke.points[this.activeStroke.points.length - 1];
			const preview: InkStroke = {
				id: "shape-live",
				tool: "pen",
				pen: "ball",
				color: this.plugin.settings.shapeColor,
				width: this.plugin.settings.penWidth,
				points: shapePoints(this.plugin.settings.shapeKind, [a[0], a[1]], [b[0], b[1]]).map(([x, y]) => [
					x,
					y,
					0.5,
				]),
			};
			this.paintStroke(ctx, preview, canvas);
			return;
		}
		if (this.activeStroke.tool !== "pen" && this.activeStroke.tool !== "highlighter") return;
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
		const pixels = scale * (canvas.width / ((slot?.width ?? this.baseWidth) * scale));
		paintItem(
			ctx,
			stroke,
			(x, y) => {
				const [displayX, displayY] = slot ? unrotatedToDisplayed(x, y, rotationInfo(slot)) : [x, y];
				return [displayX * pixels, displayY * pixels];
			},
			pixels,
			this.imageCache,
		);
	}

	private blockStylusTouch(event: TouchEvent): void {
		if ([...event.changedTouches].some((touch) => (touch as Touch & { touchType?: string }).touchType === "stylus"))
			event.preventDefault();
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
		this.pagesEl.setCssProps({
			"--goodnodes-pinch-origin": `${centerX - pagesRect.left}px ${centerY - pagesRect.top}px`,
		});
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
		this.pagesEl.setCssProps({
			"--goodnodes-pinch-transform": `translate(${this.pinch.centerX - this.pinch.originX}px, ${this.pinch.centerY - this.pinch.originY}px) scale(${this.pinch.visualScale})`,
		});
	}

	private endPinch(): void {
		if (!this.pinch) return;
		const gesture = this.pinch;
		this.pagesEl.setCssProps({ "--goodnodes-pinch-transform": "none", "--goodnodes-pinch-origin": "50% 50%" });
		this.zoom = Math.max(this.minZoom, Math.min(4, gesture.zoom * gesture.visualScale));
		this.markDirty();
		this.markRenderedStale();
		for (const slot of this.slots) {
			slot.el.setCssProps({
				"--goodnodes-page-width": `${slot.width * this.pageScale * this.zoom}px`,
				"--goodnodes-page-height": `${slot.height * this.pageScale * this.zoom}px`,
			});
		}
		this.updateAddPageTile();
		this.pinch = null;
		this.updatePagePadding();
		this.positionSelectionBox();
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
		this.clearSelection();
		const entry = this.history.undo(this.strokes);
		if (entry) {
			this.jumpTo(entry.page);
			this.changed(entry.page);
		}
		this.updateHistoryButtons();
	}

	private redo(): void {
		this.clearSelection();
		const entry = this.history.redo(this.strokes);
		if (entry) {
			this.jumpTo(entry.page);
			this.changed(entry.page);
		}
		this.updateHistoryButtons();
	}

	private updateHistoryButtons(): void {
		this.goodnodesToolbar?.refresh();
	}

	private handleKeydown(event: KeyboardEvent): void {
		const target = event.target as HTMLElement | null;
		if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
		if (event.metaKey || event.ctrlKey || event.altKey) {
			if ((event.metaKey || event.ctrlKey) && this.selected && ["c", "x"].includes(event.key.toLowerCase())) {
				PdfNotebookView.clipboard = this.selected.strokes;
				if (event.key.toLowerCase() === "x") this.deleteSelection();
				event.preventDefault();
				return;
			}
			if (
				(event.metaKey || event.ctrlKey) &&
				event.key.toLowerCase() === "v" &&
				PdfNotebookView.clipboard.length
			) {
				const slot = this.slots[this.currentPage],
					rect = slot?.el.getBoundingClientRect();
				if (slot && rect) {
					const center = displayedToUnrotated(slot.width / 2, slot.height / 2, rotationInfo(slot));
					this.pasteClipboard(this.currentPage, [center[0], center[1], 0.5]);
				}
				event.preventDefault();
				return;
			}
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
				event.preventDefault();
				if (event.shiftKey) this.redo();
				else this.undo();
			}
			return;
		}
		if (event.shiftKey) return;
		if (event.key === "Delete" || event.key === "Backspace") {
			if (this.selected) {
				event.preventDefault();
				this.deleteSelection();
			}
			return;
		}
		if (event.key === "Delete" || event.key === "Backspace") {
			if (this.selected) {
				event.preventDefault();
				this.deleteSelection();
			}
			return;
		}
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
				slot.el.setCssProps({
					"--goodnodes-page-width": `${slot.width * this.pageScale * this.zoom}px`,
					"--goodnodes-page-height": `${slot.height * this.pageScale * this.zoom}px`,
				});
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
			const add = (item: import("./pdfjs").PdfOutlineItem, depth: number) => {
				const row = this.sidebarContent!.createDiv({ cls: "goodnodes-pdf-outline-item" });
				row.createSpan({ text: item.title });
				const pageLabel = row.createSpan({ cls: "goodnodes-pdf-outline-page" });
				row.setCssProps({ "--goodnodes-outline-indent": `${12 + depth * 14}px` });
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

	private async outlinePage(item: import("./pdfjs").PdfOutlineItem): Promise<number | null> {
		const doc = this.doc;
		if (!doc) return null;
		try {
			let destination = item.dest;
			if (typeof destination === "string") destination = await doc.getDestination(destination);
			if (!destination) return null;
			const reference = destination[0];
			return typeof reference === "number" ? reference : await doc.getPageIndex(reference);
		} catch {
			return null;
		}
	}

	private async outlineJump(item: import("./pdfjs").PdfOutlineItem): Promise<void> {
		const doc = this.doc;
		if (!doc) return;
		try {
			let destination = item.dest;
			if (typeof destination === "string") destination = await doc.getDestination(destination);
			if (!destination) return;
			const ref = destination[0];
			const index = typeof ref === "number" ? ref : await doc.getPageIndex(ref);
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
			window.requestAnimationFrame(() => this.onResize());
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
		window.requestAnimationFrame(() => this.onResize());
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
		if (this.sidebarTab === "pages") window.requestAnimationFrame(() => this.scrollSidebarToCurrent());
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
			const canvas = createEl("canvas");
			canvas.width = Math.ceil(viewport.width);
			canvas.height = Math.ceil(viewport.height);
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
		const slot = this.slots[index];
		for (const stroke of this.strokes.get(index) ?? [])
			paintItem(
				ctx,
				stroke,
				(x, y) => {
					const [displayX, displayY] = unrotatedToDisplayed(x, y, rotationInfo(slot));
					return [displayX * scale, displayY * scale];
				},
				scale,
				this.imageCache,
			);
	}

	private redrawImage(src: string): void {
		for (const [page, items] of this.strokes) {
			if (!items.some((item) => item.kind === "image" && item.src === src)) continue;
			this.drawCommittedInk(page);
			const canvas = this.sidebarContent?.querySelector<HTMLCanvasElement>(
				`.goodnodes-pdf-thumbnail[data-page="${page}"] canvas`,
			);
			if (canvas) {
				canvas.remove();
				void this.renderThumbnail(page);
			}
		}
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
		const doc = this.doc;
		if (!doc) return;
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
			const parsed = parseSidecar(text, doc.numPages);
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
		if (!(this.file instanceof TFile)) throw new Error("Cannot create a PDF sidecar without an open PDF");
		const file = this.file;
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
				slot.el.setCssProps({
					"--goodnodes-page-width": `${slot.width * this.pageScale * this.zoom}px`,
					"--goodnodes-page-height": `${slot.height * this.pageScale * this.zoom}px`,
				});
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
		new InsertPdfModal(this.app, files, (file) => {
			void (async () => {
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
			})();
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
		if (!this.pdfjs) this.pdfjs = (await loadPdfJs()) as PdfJsLib;
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
		if (!(this.file instanceof TFile)) return;
		const file = this.file;
		try {
			const source = await this.app.vault.readBinary(file);
			const bytes = await createAnnotatedPdf(source, this.strokes, {
				renderText: async (item, page) => {
					// Same orientation as on screen; export.ts turns it back for rotated pages.
					const box = itemBox(item),
						info = rotationInfo(this.slots[page]),
						a = unrotatedToDisplayed(box.x, box.y, info),
						b = unrotatedToDisplayed(box.x + box.width, box.y + box.height, info),
						left = Math.min(a[0], b[0]),
						top = Math.min(a[1], b[1]),
						canvas = createEl("canvas");
					canvas.width = Math.max(1, Math.ceil(Math.abs(b[0] - a[0]) * 4));
					canvas.height = Math.max(1, Math.ceil(Math.abs(b[1] - a[1]) * 4));
					paintItem(
						canvas.getContext("2d")!,
						item,
						(x, y) => {
							const [u, v] = unrotatedToDisplayed(x, y, info);
							return [(u - left) * 4, (v - top) * 4];
						},
						4,
						this.imageCache,
					);
					const blob = await new Promise<Blob>((resolve) =>
						canvas.toBlob((value) => resolve(value!), "image/png"),
					);
					return new Uint8Array(await blob.arrayBuffer());
				},
				readImage: async (src) => {
					const file = this.app.vault.getAbstractFileByPath(src);
					if (!(file instanceof TFile)) return null;
					const bytes = new Uint8Array(await this.app.vault.readBinary(file));
					const ext = src.split(".").pop()?.toLowerCase();
					if (ext === "png") return { bytes, mime: "image/png" };
					if (ext === "jpg" || ext === "jpeg") return { bytes, mime: "image/jpeg" };
					const image = new Image();
					const url = URL.createObjectURL(new Blob([bytes]));
					await new Promise<void>((resolve, reject) => {
						image.onload = () => resolve();
						image.onerror = () => reject(new Error("Image conversion failed"));
						image.src = url;
					});
					URL.revokeObjectURL(url);
					const canvas = createEl("canvas");
					canvas.width = image.naturalWidth;
					canvas.height = image.naturalHeight;
					canvas.getContext("2d")!.drawImage(image, 0, 0);
					const blob = await new Promise<Blob>((resolve) =>
						canvas.toBlob((value) => resolve(value!), "image/png"),
					);
					return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png" };
				},
			});
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
		this.commitTextEditor();
		this.clearSelection();
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
		void this.doc?.destroy();
		this.doc = null;
		this.pagesEl.empty();
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
