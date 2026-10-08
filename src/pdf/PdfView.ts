import { App, FileView, loadPdfJs, Modal, TFile, WorkspaceLeaf } from "obsidian";
import { getStroke } from "perfect-freehand";
import type GoodNodesPlugin from "../main";
import { debug } from "../debug";

export const PDF_VIEW_TYPE = "goodnodes-pdf";
type PdfDoc = any;
type PdfPage = any;
type PageSlot = { el: HTMLElement; width: number; height: number; canvas?: HTMLCanvasElement; ink?: HTMLCanvasElement; task?: any; page?: PdfPage; busy?: boolean };
type InkPoint = [number, number, number];

export class PdfNotebookView extends FileView {
	navigation = true;
	zoom = 1;
	private plugin: GoodNodesPlugin;
	private doc: PdfDoc | null = null;
	private pdfjs: any;
	private scroller: HTMLElement;
	private pagesEl: HTMLElement;
	private toolbar: HTMLElement;
	private indicator: HTMLElement;
	private outlineEl: HTMLElement | null = null;
	private observer: IntersectionObserver | null = null;
	private slots: PageSlot[] = [];
	private loaded = new Map<number, PdfPage>();
	private visible = new Set<number>();
	private queue: number[] = [];
	private running = 0;
	private raf = 0;
	private pageScale = 1;
	private baseWidth = 612;
	private baseHeight = 792;
	private strokes = new Map<number, InkPoint[][]>();
	private activeStroke: { index: number; points: InkPoint[] } | null = null;
	private pointers = new Map<number, PointerEvent>();
	private pinch: { distance: number; zoom: number; centerX: number; centerY: number; contentY: number } | null = null;
	private jumpStarted = new Map<number, number>();
	private disposed = false;
	private loadStartedAt = 0;
	private touchStart = (e: TouchEvent) => this.blockStylusTouch(e);
	private touchMove = (e: TouchEvent) => { this.blockStylusTouch(e); if (this.pointers.size >= 2) e.preventDefault(); };

	constructor(leaf: WorkspaceLeaf, plugin: GoodNodesPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.contentEl.addClass("goodnodes-pdf-root");
		this.scroller = this.contentEl.createDiv({ cls: "goodnodes-pdf-scroll" });
		this.pagesEl = this.scroller.createDiv({ cls: "goodnodes-pdf-pages" });
		this.toolbar = this.contentEl.createDiv({ cls: "goodnodes-pdf-toolbar" });
		this.indicator = this.contentEl.createDiv({ cls: "goodnodes-pdf-indicator", text: "— / —" });
		this.button("−", "Zoom out", () => this.setZoom(this.zoom / 1.2));
		this.button("+", "Zoom in", () => this.setZoom(this.zoom * 1.2));
		this.button("Fit", "Fit to width", () => this.setZoom(1));
		this.button("☰", "Outline", () => this.toggleOutline());
		this.registerDomEvent(this.scroller, "scroll", () => this.scheduleUpdate());
		this.registerDomEvent(this.indicator, "click", () => this.openPageModal());
		this.registerDomEvent(this.pagesEl, "pointerdown", (e) => this.pointerDown(e));
		this.registerDomEvent(this.pagesEl, "pointermove", (e) => this.pointerMove(e));
		this.registerDomEvent(this.pagesEl, "pointerup", (e) => this.pointerUp(e));
		this.registerDomEvent(this.pagesEl, "pointercancel", (e) => { debug.log("pdf pointercancel (device diagnostic)", "warn"); this.pointerUp(e); });
		this.registerDomEvent(this.pagesEl, "wheel", (e) => {
			if ((e.ctrlKey || e.metaKey) && Math.abs(e.deltaY) > 0) { e.preventDefault(); this.setZoom(this.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08), e.clientY); }
		}, { passive: false });
		this.scroller.addEventListener("touchstart", this.touchStart, { passive: false });
		this.scroller.addEventListener("touchmove", this.touchMove, { passive: false });
	}

	getViewType(): string { return PDF_VIEW_TYPE; }
	getDisplayText(): string { return this.file?.basename ?? "PDF Notebook"; }
	getIcon(): string { return "book-open"; }
	canAcceptExtension(ext: string): boolean { return ext === "pdf"; }

	async onLoadFile(file: TFile): Promise<void> {
		this.clearDocument();
		this.disposed = false;
		this.loadStartedAt = performance.now();
		try {
			this.pdfjs = await loadPdfJs();
			debug.log(`pdf.js ${this.pdfjs?.version ?? "version unavailable"}`);
			const readStart = performance.now();
			const data = await this.app.vault.readBinary(file);
			debug.log(`PDF read ${(performance.now() - readStart).toFixed(1)} ms`);
			const openStart = performance.now();
			this.doc = await this.pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
			debug.log(`PDF open ${(performance.now() - openStart).toFixed(1)} ms; ${this.doc.numPages} pages`);
			const first = await this.doc.getPage(1);
			const v = first.getViewport({ scale: 1 });
			this.baseWidth = v.width; this.baseHeight = v.height;
			this.pageScale = this.fitScale();
			this.buildSlots();
			this.observe();
			this.scheduleUpdate();
			void this.loadOutline();
		} catch (err) { debug.error("PDF load failed", err); }
	}

	async onUnloadFile(_file: TFile): Promise<void> { this.clearDocument(); }

	private button(label: string, title: string, action: () => void): void {
		const b = this.toolbar.createEl("button", { text: label, attr: { title } });
		this.registerDomEvent(b, "click", action);
	}
	private fitScale(): number {
		return Math.min(1, Math.max(0.1, (Math.min(1100, Math.max(100, this.scroller.clientWidth - 32))) / this.baseWidth));
	}
	private buildSlots(): void {
		this.observer?.disconnect(); this.slots = []; this.pagesEl.empty();
		for (let i = 0; i < this.doc.numPages; i++) {
			const el = this.pagesEl.createDiv({ cls: "goodnodes-pdf-page" });
			el.dataset.page = String(i + 1);
			el.style.width = `${this.baseWidth * this.pageScale * this.zoom}px`;
			el.style.height = `${this.baseHeight * this.pageScale * this.zoom}px`;
			this.slots.push({ el, width: this.baseWidth, height: this.baseHeight });
		}
	}
	private observe(): void {
		this.observer?.disconnect();
		this.observer = new IntersectionObserver((entries) => {
			for (const entry of entries) { const i = Number((entry.target as HTMLElement).dataset.page) - 1; if (entry.isIntersecting) this.visible.add(i); else this.visible.delete(i); }
			this.scheduleUpdate();
		}, { root: this.scroller, rootMargin: `${Math.max(500, this.scroller.clientHeight)}px 0px` });
		for (const p of this.slots) this.observer.observe(p.el);
	}
	private scheduleUpdate(): void {
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => { this.raf = 0; this.updateVisible(); });
	}
	private updateVisible(): void {
		if (!this.doc || !this.slots.length) return;
		const rect = this.scroller.getBoundingClientRect();
		const center = this.scroller.scrollTop + this.scroller.clientHeight / 2;
		let current = 0, best = Infinity;
		this.slots.forEach((slot, i) => {
			const top = slot.el.offsetTop, bottom = top + slot.el.offsetHeight;
			const d = Math.abs((top + bottom) / 2 - center);
			if (d < best) { best = d; current = i; }
		});
		this.indicator.setText(`${current + 1} / ${this.slots.length}`);
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
		void rect;
	}
	private pump(): void {
		while (this.running < 2 && this.queue.length) {
			const i = this.queue.shift()!;
			if (!this.visible.has(i) || this.slots[i].canvas || this.slots[i].busy) continue;
			this.running++; this.slots[i].busy = true;
			void this.renderPage(i).finally(() => { this.running--; this.slots[i].busy = false; this.pump(); });
		}
	}
	private async renderPage(i: number): Promise<void> {
		if (!this.doc || this.disposed) return;
		const started = performance.now();
		let canvas: HTMLCanvasElement | undefined;
		try {
			const page = this.loaded.get(i) ?? await this.doc.getPage(i + 1);
			this.loaded.set(i, page);
			const raw = page.getViewport({ scale: 1 });
			if (Math.abs(raw.width - this.baseWidth) > 1 || Math.abs(raw.height - this.baseHeight) > 1) {
				const anchor = this.topAnchor();
				const slot = this.slots[i]; slot.width = raw.width; slot.height = raw.height; slot.el.style.width = `${raw.width * this.pageScale * this.zoom}px`; slot.el.style.height = `${raw.height * this.pageScale * this.zoom}px`;
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
			const renderViewport = pixelScale === 1 ? viewport : page.getViewport({ scale: scale * pixelScale });
			const task = page.render({ canvasContext: ctx, viewport: renderViewport });
			this.slots[i].task = task;
			this.slots[i].el.appendChild(canvas);
			this.logCanvasStats();
			await task.promise;
			if (this.disposed || !this.visible.has(i)) { canvas.width = canvas.height = 0; canvas.remove(); this.logCanvasStats(); return; }
			const ink = document.createElement("canvas"); ink.className = "goodnodes-pdf-ink"; ink.width = canvas.width; ink.height = canvas.height; ink.style.width = `${viewport.width}px`; ink.style.height = `${viewport.height}px`;
			this.slots[i].el.appendChild(ink);
			this.slots[i].canvas = canvas; this.slots[i].ink = ink; this.slots[i].page = page; this.slots[i].task = undefined;
			this.drawInk(i);
			this.logCanvasStats();
			const jump = this.jumpStarted.get(i); if (jump) { debug.log(`Jump page ${i + 1} to first render ${(performance.now() - jump).toFixed(1)} ms`); this.jumpStarted.delete(i); }
			if (i === 0) debug.log(`First PDF page rendered ${(performance.now() - this.loadStartedAt).toFixed(1)} ms total (${(performance.now() - started).toFixed(1)} ms render)`);
		} catch (err) { if (canvas) { canvas.width = canvas.height = 0; canvas.remove(); this.logCanvasStats(); } if ((err as Error)?.name !== "RenderingCancelledException") debug.error(`PDF page ${i + 1} render failed`, err); }
	}
	private release(i: number): void {
		const s = this.slots[i]; if (!s) return;
		s.task?.cancel?.(); s.task = undefined;
		if (s.canvas) { s.canvas.width = s.canvas.height = 0; s.canvas.remove(); s.canvas = undefined; }
		if (s.ink) { s.ink.width = s.ink.height = 0; s.ink.remove(); s.ink = undefined; }
		s.page?.cleanup?.(); s.page = undefined;
		this.logCanvasStats();
	}
	private logCanvasStats(): void {
		let count = 0, pixels = 0;
		for (const s of this.slots) if (s.canvas) { count++; pixels += s.canvas.width * s.canvas.height; }
		debug.live.pdf = `${count} live canvases · ${(pixels / 1_000_000).toFixed(1)} MP`;
	}
	private topAnchor(): { index: number; offset: number } { const y = this.scroller.scrollTop; let i = this.slots.findIndex(s => s.el.offsetTop + s.el.offsetHeight >= y); if (i < 0) i = 0; return { index: i, offset: y - this.slots[i].el.offsetTop }; }
	private restoreAnchor(a: { index: number; offset: number }): void { const s = this.slots[a.index]; if (s) this.scroller.scrollTop = s.el.offsetTop + a.offset; }
	private setZoom(value: number, clientY?: number): void {
		const next = Math.max(0.5, Math.min(4, value)); if (Math.abs(next - this.zoom) < 0.001) return;
		const y = clientY ?? this.scroller.getBoundingClientRect().top + this.scroller.clientHeight / 2;
		const local = y - this.scroller.getBoundingClientRect().top;
		const contentY = this.scroller.scrollTop + local;
		const old = this.zoom; this.zoom = next;
		for (const i of this.slots.keys()) this.release(i);
		for (const s of this.slots) { s.el.style.width = `${s.width * this.pageScale * next}px`; s.el.style.height = `${s.height * this.pageScale * next}px`; }
		this.scroller.scrollTop = contentY * next / old - local;
		this.scheduleUpdate();
	}
	private pointerDown(e: PointerEvent): void {
		debug.pointer("pdf", e); this.pointers.set(e.pointerId, e);
		if (e.pointerType === "touch" && this.pointers.size >= 2) { this.startPinch(); return; }
		if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;
		const hit = this.pageAt(e); if (!hit) return;
		const [i, point] = hit; this.activeStroke = { index: i, points: [point] };
		try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* detached target */ }
		e.preventDefault();
	}
	private pointerMove(e: PointerEvent): void {
		debug.pointer("pdf", e);
		if (e.pointerType === "touch" && this.pointers.has(e.pointerId)) { this.pointers.set(e.pointerId, e); if (this.pointers.size >= 2) this.updatePinch(); return; }
		if (!this.activeStroke) return;
		const events = e.getCoalescedEvents?.() ?? [e];
		for (const item of events) { const hit = this.pageAt(item); if (hit && hit[0] === this.activeStroke.index) this.activeStroke.points.push(hit[1]); }
		this.drawInk(this.activeStroke.index, this.activeStroke.points);
		e.preventDefault();
	}
	private pointerUp(e: PointerEvent): void {
		debug.pointer("pdf", e); this.pointers.delete(e.pointerId);
		if (this.pointers.size < 2 && this.pinch) this.endPinch();
		if (this.activeStroke) { const { index, points } = this.activeStroke; if (points.length) { const arr = this.strokes.get(index) ?? []; arr.push(points); this.strokes.set(index, arr); this.drawInk(index); } this.activeStroke = null; }
	}
	private pageAt(e: PointerEvent): [number, InkPoint] | null {
		const el = (e.target as HTMLElement).closest<HTMLElement>(".goodnodes-pdf-page"); if (!el) return null;
		const i = Number(el.dataset.page) - 1, r = el.getBoundingClientRect(), scale = this.pageScale * this.zoom;
		return [i, [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale, e.pressure || 0.5]];
	}
	private drawInk(i: number, extra?: InkPoint[]): void {
		const c = this.slots[i]?.ink; if (!c) return;
		const ctx = c.getContext("2d")!; ctx.clearRect(0, 0, c.width, c.height);
		const factor = c.width / (this.slots[i].width * this.pageScale * this.zoom);
		for (const pts of [...(this.strokes.get(i) ?? []), ...(extra ? [extra] : [])]) {
			const outline = getStroke(pts.map(p => [p[0] * factor, p[1] * factor, p[2]]), { size: 3 * this.zoom * factor, thinning: 0.6, smoothing: 0.5, streamline: 0.5 });
			if (!outline.length) continue;
			ctx.beginPath(); ctx.moveTo(outline[0][0], outline[0][1]); for (let n = 1; n < outline.length; n++) ctx.lineTo(outline[n][0], outline[n][1]); ctx.closePath(); ctx.fillStyle = "#202020"; ctx.fill();
		}
	}
	private blockStylusTouch(e: TouchEvent): void { if ([...e.changedTouches].some(t => (t as any).touchType === "stylus")) e.preventDefault(); }
	private startPinch(): void {
		const pts = [...this.pointers.values()].slice(-2), dx = pts[1].clientX - pts[0].clientX, dy = pts[1].clientY - pts[0].clientY;
		const y = (pts[0].clientY + pts[1].clientY) / 2, rect = this.scroller.getBoundingClientRect();
		this.pinch = { distance: Math.hypot(dx, dy), zoom: this.zoom, centerX: (pts[0].clientX + pts[1].clientX) / 2, centerY: y, contentY: this.scroller.scrollTop + y - rect.top };
		this.pagesEl.style.transformOrigin = `${this.pinch.centerX - rect.left + this.scroller.scrollLeft}px ${this.pinch.centerY - rect.top + this.scroller.scrollTop}px`;
	}
	private updatePinch(): void { if (!this.pinch) this.startPinch(); if (!this.pinch) return; const pts = [...this.pointers.values()].slice(-2); const dx = pts[1].clientX - pts[0].clientX, dy = pts[1].clientY - pts[0].clientY; this.pagesEl.style.transform = `scale(${Math.hypot(dx, dy) / this.pinch.distance})`; }
	private endPinch(): void {
		if (!this.pinch) return;
		const pts = [...this.pointers.values()];
		let ratio = Number(this.pagesEl.style.transform.match(/scale\(([^)]+)\)/)?.[1] ?? 1);
		this.pagesEl.style.transform = ""; const old = this.zoom; this.zoom = Math.max(0.5, Math.min(4, this.pinch.zoom * ratio));
		for (const i of this.slots.keys()) this.release(i);
		for (const s of this.slots) { s.el.style.width = `${s.width * this.pageScale * this.zoom}px`; s.el.style.height = `${s.height * this.pageScale * this.zoom}px`; }
		const rect = this.scroller.getBoundingClientRect(), y = this.pinch.centerY - rect.top;
		this.scroller.scrollTop = this.pinch.contentY * this.zoom / old - y; this.pinch = null; this.scheduleUpdate(); void pts;
	}
	private openPageModal(): void {
		const modal = new PageModal(this.app, this.slots.length, n => this.jumpTo(n - 1)); modal.open();
	}
	private jumpTo(i: number): void { if (i < 0 || i >= this.slots.length) return; if (this.slots[i].canvas) debug.log(`Jump page ${i + 1} to first render 0.0 ms (already rendered)`); else this.jumpStarted.set(i, performance.now()); this.scroller.scrollTop = this.slots[i].el.offsetTop; this.visible.add(i); this.scheduleUpdate(); }
	private async loadOutline(): Promise<void> {
		if (!this.doc) return;
		try { const outline = await this.doc.getOutline(); if (outline?.length) this.renderOutline(outline); }
		catch (err) { debug.log(`PDF outline unavailable: ${String(err)}`, "warn"); }
	}
	private renderOutline(items: any[]): void {
		this.outlineEl?.remove(); const panel = this.contentEl.createDiv({ cls: "goodnodes-pdf-outline" }); this.outlineEl = panel;
		const add = (item: any, depth: number) => {
			const row = panel.createDiv({ cls: "goodnodes-pdf-outline-item", text: item.title }); row.style.paddingLeft = `${8 + depth * 14}px`;
			this.registerDomEvent(row, "click", () => void this.outlineJump(item));
			for (const child of item.items ?? []) add(child, depth + 1);
		};
		for (const item of items) add(item, 0);
	}
	private async outlineJump(item: any): Promise<void> {
		try { let dest = item.dest; if (typeof dest === "string") dest = await this.doc.getDestination(dest); if (!dest) return; const ref = dest[0]; const index = typeof ref === "number" ? ref : await this.doc.getPageIndex(ref); this.jumpTo(index); }
		catch (err) { debug.error("PDF outline jump failed", err); }
	}
	private toggleOutline(): void { if (this.outlineEl) { this.outlineEl.remove(); this.outlineEl = null; } else void this.loadOutline(); }
	private clearDocument(): void {
		this.disposed = true; cancelAnimationFrame(this.raf); this.raf = 0; this.observer?.disconnect(); this.observer = null;
		this.queue = []; for (const i of this.slots.keys()) this.release(i); this.slots = []; this.loaded.clear(); this.visible.clear(); this.strokes.clear(); this.doc?.destroy?.(); this.doc = null; this.pagesEl.empty(); this.outlineEl?.remove(); this.outlineEl = null; delete debug.live.pdf;
	}
}

class PageModal extends Modal {
	constructor(app: App, max: number, jump: (page: number) => void) {
		super(app); this.titleEl.setText("Go to page");
		const input = this.contentEl.createEl("input", { attr: { type: "number", min: "1", max: String(max), value: "1" } });
		input.focus(); input.select(); input.addEventListener("keydown", e => { if (e.key === "Enter") { const n = Number(input.value); if (n >= 1 && n <= max) { jump(n); this.close(); } } });
	}
}
