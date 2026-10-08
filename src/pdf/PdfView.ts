import { App, FileView, loadPdfJs, Modal, Notice, setIcon, TFile, WorkspaceLeaf } from "obsidian";
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

type PageSlot = { el: HTMLElement; width: number; height: number; unrotatedWidth: number; unrotatedHeight: number; rotation: number; canvas?: HTMLCanvasElement; ink?: HTMLCanvasElement; live?: HTMLCanvasElement; task?: any; page?: PdfPage; busy?: boolean };
type Tool = InkTool | "eraser";
type ZoomAnchor = { page: number; x: number; y: number };
type Gesture = { distance: number; zoom: number; originX: number; originY: number; centerX: number; centerY: number; anchor: ZoomAnchor; visualScale: number };
type SessionTool = { tool: Tool; color: string; width: number };
const PRESET_COLORS = ["#1e1e1e", "#1971c2", "#e03131", "#2f9e44", "#f08c00", "#9c36b5"];
let sessionTool: SessionTool | null = null;

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
	private outlineEl: HTMLElement | null = null;
	private thumbPanel: HTMLElement | null = null;
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
	private activeStroke: { page: number; points: InkPoint[]; tool: Tool } | null = null;
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
	private dirty = false;
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
		this.toolState = sessionTool ?? { tool: "pen", color: plugin.settings.penColor, width: plugin.settings.penWidth };
		this.contentEl.addClass("goodnodes-pdf-root");
		this.scroller = this.contentEl.createDiv({ cls: "goodnodes-pdf-scroll" });
		this.pagesEl = this.scroller.createDiv({ cls: "goodnodes-pdf-pages" });
		this.historyToolbar = this.contentEl.createDiv({ cls: "goodnodes-pdf-history" });
		this.toolbar = this.contentEl.createDiv({ cls: "goodnodes-pdf-toolbar" });
		this.indicator = this.contentEl.createDiv({ cls: "goodnodes-pdf-indicator", text: "— / —" });
		this.buildToolbar();
		this.registerDomEvent(this.scroller, "scroll", () => this.scheduleUpdate());
		this.registerDomEvent(this.indicator, "click", () => this.openPageModal());
		this.registerDomEvent(this.pagesEl, "pointerdown", (e) => this.pointerDown(e));
		this.registerDomEvent(this.pagesEl, "pointermove", (e) => this.pointerMove(e));
		this.registerDomEvent(this.pagesEl, "pointerup", (e) => this.pointerUp(e));
		this.registerDomEvent(this.pagesEl, "pointercancel", (event) => {
			debug.log("pdf pointercancel (device diagnostic)", "warn");
			this.pointerUp(event);
		});
		this.registerDomEvent(this.pagesEl, "wheel", (e) => {
			if ((e.ctrlKey || e.metaKey) && e.deltaY) {
				e.preventDefault();
				this.setZoom(this.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientX, e.clientY);
			}
		}, { passive: false });
		this.registerDomEvent(this.contentEl, "keydown", (e) => this.handleKeydown(e));
		this.contentEl.tabIndex = 0;
		this.scroller.addEventListener("touchstart", this.touchStart, { passive: false });
		this.scroller.addEventListener("touchmove", this.touchMove, { passive: false });
		// Obsidian mobile opens sidebars on horizontal swipes; writing or panning a page must not.
		for (const type of ["touchstart", "touchmove", "touchend"] as const) {
			this.registerDomEvent(this.scroller, type, (e: TouchEvent) => e.stopPropagation(), { passive: true });
		}
		this.registerEvent((this.app.vault as any).on("raw", (path: string) => {
			if (path === this.sidecarPath) void this.readExternalSidecar();
		}));
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
		await this.flushSave();
		this.clearDocument();
		this.disposed = false;
		this.sidecarPath = `${file.path}.goodnodes.json`;
		this.loadStartedAt = performance.now();
		try {
			this.pdfjs = await loadPdfJs();
			debug.log(`pdf.js ${this.pdfjs?.version ?? "version unavailable"}`);
			const data = await this.app.vault.readBinary(file);
			this.doc = await this.pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
			const first = await this.doc.getPage(1);
			const viewport = first.getViewport({ scale: 1 });
			this.baseWidth = viewport.width;
			this.baseHeight = viewport.height;
			this.pageScale = this.fitScale();
			// pdf.js transfers (detaches) `data` to its worker, so take the size from the file.
			await this.loadSidecar(file, file.stat.size);
			this.buildSlots();
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
		this.toolButton("pen", "pen-line", "Pen");
		this.toolButton("highlighter", "highlighter", "Highlighter");
		this.toolButton("eraser", "eraser", "Eraser");
		this.toolbar.createDiv({ cls: "goodnodes-pdf-toolbar-separator" });
		this.renderColorSwatches();
		for (const width of [1, this.plugin.settings.penWidth, this.plugin.settings.penWidth * 2.5]) {
			const button = this.toolbar.createEl("button", { cls: "goodnodes-pdf-width", attr: { title: `Width ${width}` } });
			button.dataset.width = String(width);
			button.createSpan({ cls: "goodnodes-pdf-width-dot" }).style.width = `${Math.min(18, 4 + width * 2)}px`;
			button.createSpan({ cls: "goodnodes-pdf-width-dot" }).style.height = `${Math.min(18, 4 + width * 2)}px`;
			button.onclick = () => { this.toolState.width = width; this.updateToolbar(); this.rememberTool(); };
		}
		this.toolbar.createDiv({ cls: "goodnodes-pdf-toolbar-separator" });
		// Zoom buttons are for mouse users; on narrow (touch) layouts CSS hides them, pinch is there.
		this.iconButton(this.toolbar, "zoom-out", "Zoom out", () => this.setZoom(this.zoom / 1.2), "goodnodes-pdf-zoom");
		this.iconButton(this.toolbar, "zoom-in", "Zoom in", () => this.setZoom(this.zoom * 1.2), "goodnodes-pdf-zoom");
		this.iconButton(this.toolbar, "maximize", "Fit width", () => this.setZoom(1));
		this.iconButton(this.toolbar, "list", "Outline", () => this.toggleOutline());
		this.iconButton(this.toolbar, "layout-grid", "Thumbnails", () => this.toggleThumbnails());
		this.iconButton(this.toolbar, "file-down", "Export PDF with notes", () => void this.exportAnnotated());
		this.updateToolbar();
	}

	private renderColorSwatches(): void {
		const settingColor = this.toolState.tool === "highlighter" ? this.plugin.settings.highlighterColor : this.plugin.settings.penColor;
		const colors = [...new Set([settingColor.toLowerCase(), ...PRESET_COLORS])];
		for (const color of colors) {
			const button = this.toolbar.createEl("button", { cls: "goodnodes-pdf-swatch", attr: { title: color } });
			button.style.setProperty("--goodnodes-swatch", color);
			button.onclick = () => { this.toolState.color = color; this.updateToolbar(); this.rememberTool(); };
		}
	}

	private toolButton(tool: Tool, icon: string, label: string): void {
		const button = this.toolbar.createEl("button", { cls: "goodnodes-pdf-tool", attr: { "aria-label": label, title: label } });
		setIcon(button, icon);
		button.dataset.tool = tool;
		button.onclick = () => { this.toolState.tool = tool; if (tool === "highlighter") this.toolState.color = this.plugin.settings.highlighterColor; this.updateToolbar(); this.rememberTool(); };
	}

	private iconButton(parent: HTMLElement, icon: string, title: string, action: () => void, cls?: string): void {
		const button = parent.createEl("button", { cls, attr: { title, "aria-label": title } });
		setIcon(button, icon);
		button.onclick = action;
	}

	private updateToolbar(): void {
		this.toolbar.querySelectorAll<HTMLElement>("[data-tool]").forEach((button) => button.toggleClass("is-active", button.dataset.tool === this.toolState.tool));
		this.toolbar.querySelectorAll<HTMLElement>(".goodnodes-pdf-swatch").forEach((button) => button.toggleClass("is-active", button.title.toLowerCase() === this.toolState.color.toLowerCase()));
		this.toolbar.querySelectorAll<HTMLElement>(".goodnodes-pdf-width").forEach((button) => button.toggleClass("is-active", Number(button.dataset.width) === this.toolState.width));
	}

	private rememberTool(): void {
		sessionTool = { ...this.toolState };
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
			this.slots.push({ el, width: this.baseWidth, height: this.baseHeight, unrotatedWidth: this.baseWidth, unrotatedHeight: this.baseHeight, rotation: 0 });
		}
	}

	private observe(): void {
		this.observer?.disconnect();
		this.observer = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				const page = Number((entry.target as HTMLElement).dataset.page);
				if (entry.isIntersecting) this.visible.add(page);
				else this.visible.delete(page);
			}
			this.scheduleUpdate();
		}, { root: this.scroller, rootMargin: `${Math.max(500, this.scroller.clientHeight)}px 0px` });
		for (const slot of this.slots) this.observer.observe(slot.el);
	}

	private scheduleUpdate(): void {
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => { this.raf = 0; this.updateVisible(); });
	}

	private updateVisible(): void {
		if (!this.doc || !this.slots.length) return;
		const center = this.scroller.scrollTop + this.scroller.clientHeight / 2;
		let current = 0, best = Infinity;
		this.slots.forEach((slot, i) => {
			const distance = Math.abs(slot.el.offsetTop + slot.el.offsetHeight / 2 - center);
			if (distance < best) { best = distance; current = i; }
		});
		if (this.currentPage !== current) this.dirty = true;
		this.currentPage = current;
		this.indicator.setText(`${current + 1} / ${this.slots.length}`);
		this.updateThumbnailSelection();
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
			void this.renderPage(index).finally(() => { this.running--; this.slots[index].busy = false; this.pump(); });
		}
	}

	private async renderPage(index: number): Promise<void> {
		if (!this.doc || this.disposed) return;
		const started = performance.now();
		let canvas: HTMLCanvasElement | undefined;
		try {
			const page = this.loaded.get(index) ?? await this.doc.getPage(index + 1);
			this.loaded.set(index, page);
			const raw = page.getViewport({ scale: 1 });
			const unrotated = page.getViewport({ scale: 1, rotation: 0 });
			this.slots[index].rotation = raw.rotation ?? page.rotate ?? 0;
			this.slots[index].unrotatedWidth = unrotated.width;
			this.slots[index].unrotatedHeight = unrotated.height;
			if (Math.abs(raw.width - this.baseWidth) > 1 || Math.abs(raw.height - this.baseHeight) > 1) {
				const anchor = this.topAnchor();
				const slot = this.slots[index];
				slot.width = raw.width; slot.height = raw.height;
				slot.el.style.width = `${raw.width * this.pageScale * this.zoom}px`;
				slot.el.style.height = `${raw.height * this.pageScale * this.zoom}px`;
				this.restoreAnchor(anchor);
			}
			const scale = this.pageScale * this.zoom;
			const viewport = page.getViewport({ scale });
			const dpr = Math.max(1, window.devicePixelRatio || 1);
			const pixelScale = Math.min(dpr, Math.sqrt(4_000_000 / (viewport.width * viewport.height)));
			canvas = document.createElement("canvas"); canvas.className = "goodnodes-pdf-canvas";
			canvas.width = Math.max(1, Math.floor(viewport.width * pixelScale)); canvas.height = Math.max(1, Math.floor(viewport.height * pixelScale));
			canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
			const ctx = canvas.getContext("2d", { alpha: false })!;
			const task = page.render({ canvasContext: ctx, viewport: pixelScale === 1 ? viewport : page.getViewport({ scale: scale * pixelScale }) });
			this.slots[index].task = task;
			this.slots[index].el.appendChild(canvas);
			await task.promise;
			if (this.disposed || !this.visible.has(index)) { canvas.width = canvas.height = 0; canvas.remove(); return; }
			const ink = this.makeOverlay(canvas, "goodnodes-pdf-ink");
			const live = this.makeOverlay(canvas, "goodnodes-pdf-live");
			live.width = live.height = 0;
			this.slots[index].el.append(ink, live);
			this.slots[index].canvas = canvas; this.slots[index].ink = ink; this.slots[index].live = live;
			this.slots[index].page = page; this.slots[index].task = undefined;
			this.drawCommittedInk(index);
			this.logCanvasStats();
			const jump = this.jumpStarted.get(index);
			if (jump) { debug.log(`Jump page ${index + 1} to first render ${(performance.now() - jump).toFixed(1)} ms`); this.jumpStarted.delete(index); }
			if (index === 0) debug.log(`First PDF page rendered ${(performance.now() - this.loadStartedAt).toFixed(1)} ms total (${(performance.now() - started).toFixed(1)} ms render)`);
		} catch (err) {
			if (canvas) { canvas.width = canvas.height = 0; canvas.remove(); }
			if ((err as Error)?.name !== "RenderingCancelledException") debug.error(`PDF page ${index + 1} render failed`, err);
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
		canvas.style.width = base.style.width; canvas.style.height = base.style.height;
		return canvas;
	}

	private release(index: number): void {
		const slot = this.slots[index];
		if (!slot) return;
		slot.task?.cancel?.(); slot.task = undefined;
		for (const key of ["canvas", "ink", "live"] as const) {
			const canvas = slot[key];
			if (canvas) { canvas.width = canvas.height = 0; canvas.remove(); slot[key] = undefined; }
		}
		(slot.page ?? this.loaded.get(index))?.cleanup?.();
		this.loaded.delete(index);
		slot.page = undefined;
		this.logCanvasStats();
	}

	private logCanvasStats(): void {
		let count = 0, pixels = 0;
		for (const slot of this.slots) if (slot.canvas) { count++; pixels += slot.canvas.width * slot.canvas.height; }
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
		this.dirty = true;
	}

	/** Pages fit the view width at zoom 1; refit when the view is resized (rotation, sidebars). */
	onResize(): void {
		if (!this.doc || !this.slots.length) return;
		const next = this.fitScale();
		if (Math.abs(next - this.pageScale) < 0.001) return;
		this.relayout(() => (this.pageScale = next));
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
			if (this.penDown || Date.now() < this.penUntil) { this.ignoredTouches.add(event.pointerId); return; }
			const maxTouchSize = this.plugin.settings.palmMaxTouchSize;
			if (maxTouchSize > 0 && Math.max(event.width, event.height) > maxTouchSize) { this.ignoredTouches.add(event.pointerId); return; }
			this.pointers.set(event.pointerId, event);
			if (this.touchPointerCount() >= 2) this.startPinch();
			return;
		}
		this.pointers.set(event.pointerId, event);
		if (event.pointerType !== "pen" && event.pointerType !== "mouse") return;
		if (event.pointerType === "pen") this.penDown = true;
		const hit = this.pageAt(event);
		if (!hit) return;
		this.activeStroke = { page: hit[0], points: [hit[1]], tool: this.toolState.tool };
		try { (event.target as HTMLElement).setPointerCapture(event.pointerId); } catch { /* The page may unload mid-gesture. */ }
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
		if (!this.activeStroke) return;
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
		if (!this.activeStroke) return;
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
		const page = Number(pageEl.dataset.page), rect = pageEl.getBoundingClientRect();
		const scale = this.pageScale * this.zoom;
		const slot = this.slots[page];
		const screenX = (event.clientX - rect.left) / scale, screenY = (event.clientY - rect.top) / scale;
		const [x, y] = displayedToUnrotated(screenX, screenY, { width: slot.unrotatedWidth, height: slot.unrotatedHeight, rotation: slot.rotation });
		return [page, [round(x), round(y), round(event.pressure || 0.5)]];
	}

	private commitInk(page: number, points: InkPoint[], tool: InkTool): void {
		if (!points.length) return;
		const stroke: InkStroke = { id: newStrokeId(), tool, color: this.toolState.color, width: this.toolState.width, points };
		const existing = this.strokes.get(page) ?? [];
		if (tool === "pen" && this.plugin.settings.scratchEnabled) {
			const candidates = existing.map((item) => ({ id: item.id, points: item.points.map(([x, y]) => ({ x, y })) }));
			const ids = findScratchedStrokes(points.map(([x, y]) => ({ x, y })), candidates, {
				minReversals: this.plugin.settings.scratchMinReversals,
				coverage: this.plugin.settings.scratchCoverage,
			});
			debug.log(`PDF scratch page ${page + 1}: candidates=${candidates.length} removed=${ids.join(",") || "none"}`);
			if (ids.length) {
				const removed = existing.filter((item) => ids.includes(item.id));
				this.strokes.set(page, existing.filter((item) => !ids.includes(item.id)));
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
		const ids = new Set(findEraserHits(points, existing, 8 / (this.pageScale * this.zoom)));
		if (!ids.size) return;
		const removed = existing.filter((stroke) => ids.has(stroke.id));
		this.strokes.set(page, existing.filter((stroke) => !ids.has(stroke.id)));
		this.history.push({ page, added: [], removed });
		this.changed(page);
	}

	private changed(page: number): void {
		this.dirty = true;
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
			ctx.beginPath(); ctx.arc(displayX * scale * factor, displayY * scale * factor, 8 * factor, 0, Math.PI * 2);
			ctx.strokeStyle = "rgba(30,30,30,.65)"; ctx.lineWidth = 1.5 * factor; ctx.stroke();
			return;
		}
		const stroke: InkStroke = { id: "live", tool: this.activeStroke.tool, color: this.toolState.color, width: this.toolState.width, points: this.activeStroke.points };
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
			ctx.save(); ctx.globalCompositeOperation = "multiply"; ctx.globalAlpha = 0.35;
			ctx.strokeStyle = stroke.color; ctx.lineWidth = Math.max(1, width * 5); ctx.lineCap = "butt"; ctx.lineJoin = "bevel";
			ctx.beginPath(); points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke(); ctx.restore();
			return;
		}
		const outline = getStroke(points, { size: width, thinning: 0.6, smoothing: smooth ? 0.5 : 0, streamline: smooth ? 0.5 : 0 });
		if (!outline.length) return;
		ctx.beginPath(); ctx.moveTo(outline[0][0], outline[0][1]);
		for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]);
		ctx.closePath(); ctx.fillStyle = stroke.color; ctx.fill();
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
		const dx = points[1].clientX - points[0].clientX, dy = points[1].clientY - points[0].clientY;
		const centerX = (points[0].clientX + points[1].clientX) / 2, centerY = (points[0].clientY + points[1].clientY) / 2;
		const anchor = this.zoomAnchor(centerX, centerY);
		const pagesRect = this.pagesEl.getBoundingClientRect();
		this.pinch = { distance: Math.hypot(dx, dy), zoom: this.zoom, originX: centerX, originY: centerY, centerX, centerY, anchor, visualScale: 1 };
		this.pagesEl.style.transformOrigin = `${centerX - pagesRect.left}px ${centerY - pagesRect.top}px`;
	}

	private updatePinch(): void {
		if (!this.pinch) this.startPinch();
		if (!this.pinch) return;
		const points = [...this.pointers.values()].filter((pointer) => pointer.pointerType === "touch").slice(-2);
		if (points.length < 2) return;
		const dx = points[1].clientX - points[0].clientX, dy = points[1].clientY - points[0].clientY;
		this.pinch.centerX = (points[0].clientX + points[1].clientX) / 2;
		this.pinch.centerY = (points[0].clientY + points[1].clientY) / 2;
		this.pinch.visualScale = Math.max(0.5 / this.pinch.zoom, Math.min(4 / this.pinch.zoom, Math.hypot(dx, dy) / this.pinch.distance));
		this.pagesEl.style.transform = `translate(${this.pinch.centerX - this.pinch.originX}px, ${this.pinch.centerY - this.pinch.originY}px) scale(${this.pinch.visualScale})`;
	}

	private endPinch(): void {
		if (!this.pinch) return;
		const gesture = this.pinch;
		this.pagesEl.style.transform = "";
		this.pagesEl.style.transformOrigin = "";
		this.zoom = Math.max(0.5, Math.min(4, gesture.zoom * gesture.visualScale));
		this.dirty = true;
		this.releaseAll();
		for (const slot of this.slots) {
			slot.el.style.width = `${slot.width * this.pageScale * this.zoom}px`;
			slot.el.style.height = `${slot.height * this.pageScale * this.zoom}px`;
		}
		this.applyZoomAnchor(gesture.anchor, gesture.centerX, gesture.centerY);
		this.pinch = null;
		this.dirty = true;
		this.scheduleUpdate();
	}

	private undo(): void {
		const entry = this.history.undo(this.strokes);
		if (entry) { this.jumpTo(entry.page); this.changed(entry.page); }
		this.updateHistoryButtons();
	}

	private redo(): void {
		const entry = this.history.redo(this.strokes);
		if (entry) { this.jumpTo(entry.page); this.changed(entry.page); }
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
		if (event.shiftKey) this.redo(); else this.undo();
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
		if (!this.doc) return;
		try {
			const outline = await this.doc.getOutline();
			if (outline?.length) this.renderOutline(outline);
		} catch (err) { debug.log(`PDF outline unavailable: ${String(err)}`, "warn"); }
	}

	private renderOutline(items: any[]): void {
		this.outlineEl?.remove();
		const panel = this.contentEl.createDiv({ cls: "goodnodes-pdf-outline" });
		this.outlineEl = panel;
		const add = (item: any, depth: number) => {
			const row = panel.createDiv({ cls: "goodnodes-pdf-outline-item" });
			row.createSpan({ text: item.title });
			const pageLabel = row.createSpan({ cls: "goodnodes-pdf-outline-page" });
			row.style.paddingLeft = `${8 + depth * 14}px`;
			this.registerDomEvent(row, "click", () => void this.outlineJump(item));
			void this.outlinePage(item).then((page) => { if (page !== null) pageLabel.setText(String(page + 1)); });
			for (const child of item.items ?? []) add(child, depth + 1);
		};
		for (const item of items) add(item, 0);
	}

	private async outlinePage(item: any): Promise<number | null> {
		try {
			let destination = item.dest;
			if (typeof destination === "string") destination = await this.doc.getDestination(destination);
			if (!destination) return null;
			const reference = destination[0];
			return typeof reference === "number" ? reference : await this.doc.getPageIndex(reference);
		} catch { return null; }
	}

	private async outlineJump(item: any): Promise<void> {
		try {
			let destination = item.dest;
			if (typeof destination === "string") destination = await this.doc.getDestination(destination);
			if (!destination) return;
			const ref = destination[0];
			const index = typeof ref === "number" ? ref : await this.doc.getPageIndex(ref);
			this.jumpTo(index);
		} catch (err) { debug.error("PDF outline jump failed", err); }
	}

	private toggleOutline(): void {
		if (this.outlineEl) { this.outlineEl.remove(); this.outlineEl = null; }
		else void this.loadOutline();
	}

	private toggleThumbnails(): void {
		if (this.thumbPanel) {
			this.thumbObserver?.disconnect();
			this.thumbPanel.remove();
			this.thumbPanel = null;
			this.contentEl.removeClass("has-thumbnails");
			requestAnimationFrame(() => this.onResize());
			return;
		}
		this.contentEl.addClass("has-thumbnails");
		requestAnimationFrame(() => this.onResize());
		const panel = this.contentEl.createDiv({ cls: "goodnodes-pdf-thumbnails" });
		this.thumbPanel = panel;
		const list = panel.createDiv({ cls: "goodnodes-pdf-thumbnail-list" });
		this.thumbObserver = new IntersectionObserver((entries) => {
			for (const entry of entries) if (entry.isIntersecting) void this.renderThumbnail(Number((entry.target as HTMLElement).dataset.page));
		}, { root: list, rootMargin: "300px 0px" });
		for (let page = 0; page < this.slots.length; page++) {
			const item = list.createDiv({ cls: "goodnodes-pdf-thumbnail", attr: { "data-page": String(page) } });
			item.createDiv({ cls: "goodnodes-pdf-thumbnail-sheet" });
			item.createDiv({ cls: "goodnodes-pdf-thumbnail-label", text: String(page + 1) });
			item.onclick = () => this.jumpTo(page);
			this.thumbObserver.observe(item);
		}
		this.updateThumbnailSelection();
	}

	private async renderThumbnail(index: number): Promise<void> {
		const item = this.thumbPanel?.querySelector<HTMLElement>(`.goodnodes-pdf-thumbnail[data-page="${index}"]`);
		const sheet = item?.querySelector<HTMLElement>(".goodnodes-pdf-thumbnail-sheet");
		if (!sheet || sheet.querySelector("canvas") || !this.doc) return;
		try {
			const page = this.loaded.get(index) ?? await this.doc.getPage(index + 1);
			this.loaded.set(index, page);
			const displayViewport = page.getViewport({ scale: 1 });
			const unrotatedViewport = page.getViewport({ scale: 1, rotation: 0 });
			const slot = this.slots[index];
			slot.width = displayViewport.width; slot.height = displayViewport.height;
			slot.rotation = displayViewport.rotation ?? page.rotate ?? 0;
			slot.unrotatedWidth = unrotatedViewport.width; slot.unrotatedHeight = unrotatedViewport.height;
			const viewport = page.getViewport({ scale: 150 / displayViewport.width });
			const canvas = document.createElement("canvas");
			canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
			canvas.style.width = "100%"; canvas.style.height = "auto";
			sheet.appendChild(canvas);
			await page.render({ canvasContext: canvas.getContext("2d", { alpha: false })!, viewport }).promise;
			this.drawThumbnailInk(index, canvas);
			this.releaseFarThumbnails(index);
			if (!this.slots[index].busy && this.slots[index].page !== page) {
				page.cleanup?.();
				this.loaded.delete(index);
			}
		} catch (err) { debug.log(`PDF thumbnail ${index + 1} failed: ${String(err)}`, "warn"); }
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
			const outline = getStroke(points, { size: stroke.width * scale * (stroke.tool === "highlighter" ? 5 : 1), thinning: stroke.tool === "highlighter" ? 0 : 0.6 });
			if (!outline.length) continue;
			ctx.globalAlpha = stroke.tool === "highlighter" ? 0.35 : 1;
			ctx.fillStyle = stroke.color; ctx.beginPath(); ctx.moveTo(outline[0][0], outline[0][1]);
			for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]);
			ctx.closePath(); ctx.fill();
		}
		ctx.globalAlpha = 1;
	}

	private releaseFarThumbnails(current: number): void {
		if (!this.thumbPanel) return;
		this.thumbPanel.querySelectorAll<HTMLElement>(".goodnodes-pdf-thumbnail").forEach((item) => {
			const page = Number(item.dataset.page);
			if (Math.abs(page - current) > 14) item.querySelector("canvas")?.remove();
		});
	}

	private updateThumbnailSelection(): void {
		this.thumbPanel?.querySelectorAll<HTMLElement>(".goodnodes-pdf-thumbnail").forEach((item) => item.toggleClass("is-current", Number(item.dataset.page) === this.currentPage));
	}

	private async loadSidecar(file: TFile, pdfSize: number): Promise<void> {
		this.loadingSidecar = true;
		try {
			if (!(await this.app.vault.adapter.exists(this.sidecarPath))) {
				this.strokes.clear(); this.currentPage = 0; this.zoom = 1;
				this.lastSerialized = "";
				this.dirty = false;
				return;
			}
			const text = await this.app.vault.adapter.read(this.sidecarPath);
			const parsed = parseSidecar(text, this.doc.numPages);
			if (!parsed) { debug.log(`Ignoring invalid or unsupported PDF sidecar: ${this.sidecarPath}`, "warn"); return; }
			if (parsed.pdf.size !== pdfSize) debug.log(`PDF sidecar size differs from current PDF (${parsed.pdf.size} vs ${pdfSize} bytes); loading anyway`, "warn");
			this.strokes = new Map(Object.entries(parsed.pages).map(([index, strokes]) => [Number(index), strokes]));
			this.currentPage = parsed.view.page;
			this.zoom = parsed.view.zoom;
			this.lastSerialized = text;
			this.dirty = false;
		} catch (err) { debug.log(`PDF sidecar read failed: ${String(err)}`, "warn"); }
		finally { this.loadingSidecar = false; }
		void file;
	}

	private makeSidecar(): PdfSidecar {
		const file = this.file as TFile;
		const pages: PdfSidecar["pages"] = {};
		for (const [index, strokes] of this.strokes) if (strokes.length) pages[String(index)] = strokes;
		return {
			type: "goodnodes-pdf", version: 1,
			pdf: { size: file?.stat.size ?? 0, pages: this.slots.length },
			view: { page: this.currentPage, zoom: this.zoom },
			pages,
		};
	}

	private scheduleSave(): void {
		if (this.loadingSidecar || this.disposed || !this.sidecarPath || !this.file) return;
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => { this.saveTimer = null; void this.writeSidecar(); }, 1000);
	}

	private async writeSidecar(): Promise<void> {
		if (this.loadingSidecar || !this.sidecarPath || !this.file) return;
		const serialized = serializeSidecar(this.makeSidecar());
		if (serialized === this.lastSerialized) { this.dirty = false; return; }
		try {
			await this.app.vault.adapter.write(this.sidecarPath, serialized);
			this.lastSerialized = serialized;
			this.dirty = false;
		} catch (err) { debug.error("PDF sidecar save failed", err); }
	}

	private async flushSave(): Promise<void> {
		if (this.saveTimer !== null) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
		if (this.dirty) await this.writeSidecar();
	}

	private async readExternalSidecar(): Promise<void> {
		if (this.disposed) return;
		try {
			const text = await this.app.vault.adapter.read(this.sidecarPath);
			if (text === this.lastSerialized) return;
			if (this.dirty) { debug.log("External PDF sidecar changed while local edits are pending; keeping local strokes", "warn"); return; }
			const parsed = parseSidecar(text, this.slots.length);
			if (!parsed) { debug.log("External PDF sidecar update was invalid; keeping current strokes", "warn"); return; }
			this.strokes = new Map(Object.entries(parsed.pages).map(([index, strokes]) => [Number(index), strokes]));
			this.currentPage = parsed.view.page;
			this.zoom = parsed.view.zoom;
			this.lastSerialized = text;
			this.history.clear();
			this.releaseAll();
			for (const slot of this.slots) {
				slot.el.style.width = `${slot.width * this.pageScale * this.zoom}px`;
				slot.el.style.height = `${slot.height * this.pageScale * this.zoom}px`;
			}
			for (const [index] of this.strokes) this.drawCommittedInk(index);
			this.restorePage(this.currentPage);
			this.dirty = false;
		} catch (err) { debug.log(`External PDF sidecar reload failed: ${String(err)}`, "warn"); }
	}

	private restorePage(page: number): void {
		if (!this.slots.length) return;
		const index = Math.max(0, Math.min(this.slots.length - 1, page));
		this.scroller.scrollTop = this.slots[index].el.offsetTop;
	}

	private async exportAnnotated(): Promise<void> {
		const file = this.file as TFile;
		if (!file) return;
		try {
			const source = await this.app.vault.readBinary(file);
			const bytes = await createAnnotatedPdf(source, this.strokes);
			const stem = `${file.parent?.path ? `${file.parent.path}/` : ""}${file.basename} (annotated)`;
			let path = `${stem}.pdf`, suffix = 2;
			while (await this.app.vault.adapter.exists(path)) path = `${stem} ${suffix++}.pdf`;
			const copy = new Uint8Array(bytes.length); copy.set(bytes);
			await this.app.vault.createBinary(path, copy.buffer);
			new Notice(`Saved ${path}`);
		} catch (err) { debug.error("PDF annotation export failed", err); new Notice("Could not export annotated PDF. See GoodNodes debug log."); }
	}

	private clearDocument(): void {
		this.disposed = true;
		if (this.saveTimer !== null) { window.clearTimeout(this.saveTimer); this.saveTimer = null; }
		cancelAnimationFrame(this.raf); this.raf = 0;
		this.observer?.disconnect(); this.observer = null;
		this.thumbObserver?.disconnect(); this.thumbObserver = null;
		this.queue = [];
		for (const index of this.slots.keys()) this.release(index);
		this.slots = []; this.loaded.clear(); this.visible.clear(); this.strokes.clear(); this.history.clear();
		this.doc?.destroy?.(); this.doc = null;
		this.pagesEl.empty(); this.outlineEl?.remove(); this.outlineEl = null;
		this.thumbPanel?.remove(); this.thumbPanel = null;
		this.activeStroke = null; this.pointers.clear(); this.pinch = null;
		delete debug.live.pdf;
	}
}

class PageModal extends Modal {
	constructor(app: App, max: number, jump: (page: number) => void, current: number) {
		super(app);
		this.titleEl.setText("Go to page");
		const input = this.contentEl.createEl("input", { attr: { type: "number", min: "1", max: String(max), value: String(current) } });
		input.focus(); input.select();
		input.addEventListener("keydown", (event) => {
			if (event.key !== "Enter") return;
			const page = Number(input.value);
			if (page >= 1 && page <= max) { jump(page); this.close(); }
		});
	}
}

function round(value: number): number { return Math.round(value * 100) / 100; }
