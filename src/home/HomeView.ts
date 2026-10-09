import { ItemView, loadPdfJs, Menu, Notice, normalizePath, setIcon, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { exportToCanvas, restoreElements } from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type GoodNodesPlugin from "../main";
import { CANVAS_EXTENSION } from "../canvas/CanvasView";
import {
	collisionSafePath,
	filterAndSortFiles,
	formatRelativeDate,
	sanitizePdfName,
	type LibraryFilter,
	type LibrarySort,
} from "./helpers";
import "./home.css";

export const HOME_VIEW_TYPE = "goodnodes-home";
const coverCache = new Map<string, string>();
const activeObjectUrls = new Set<string>();
const COVER_WIDTH = 220;

type CoverItem = { file: TFile; img: HTMLImageElement; key: string };

/** Opens the OS file picker (Files app on iPad) for PDFs, copies them into the vault, returns created files. */
export async function importPdfs(plugin: GoodNodesPlugin, folder?: TFolder): Promise<TFile[]> {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = "application/pdf,.pdf";
	input.multiple = true;
	input.style.display = "none";
	document.body.appendChild(input);
	const selected = await new Promise<File[]>((resolve) => {
		let settled = false;
		const finish = (files: File[]) => {
			if (settled) return;
			settled = true;
			input.remove();
			resolve(files);
		};
		input.addEventListener("change", () => finish(Array.from(input.files ?? [])), { once: true });
		input.addEventListener("cancel", () => finish([]), { once: true });
		input.click();
	});
	return importPickedFiles(plugin, selected, folder);
}

async function importPickedFiles(plugin: GoodNodesPlugin, selected: File[], folder?: TFolder): Promise<TFile[]> {
	if (!selected.length) return [];

	let target = folder;
	if (!target) {
		const configured = (plugin.settings as any).importFolder ?? "GoodNodes";
		const folderPath = normalizePath(String(configured).trim());
		if (!folderPath) target = plugin.app.vault.getRoot();
		else {
			const existing = plugin.app.vault.getAbstractFileByPath(folderPath);
			if (existing instanceof TFolder) target = existing;
			else if (existing) throw new Error(`Import folder path is a file: ${folderPath}`);
			else target = await plugin.app.vault.createFolder(folderPath);
		}
	}
	const created: TFile[] = [];
	for (const picked of selected) {
		const safeName = sanitizePdfName(picked.name);
		const path = collisionSafePath(
			target.isRoot() ? safeName : `${target.path}/${safeName}`,
			(candidate) => !!plugin.app.vault.getAbstractFileByPath(candidate),
		);
		created.push(await plugin.app.vault.createBinary(path, await picked.arrayBuffer()));
	}
	new Notice(`Imported ${created.length} PDF${created.length === 1 ? "" : "s"}`);
	return created;
}

export class HomeView extends ItemView {
	private plugin: GoodNodesPlugin;
	private observer: IntersectionObserver | null = null;
	private pendingCovers: CoverItem[] = [];
	private runningCovers = 0;
	private coverImgs = new Map<string, HTMLImageElement>();
	private search = "";
	private filter: LibraryFilter = "all";
	private sort: LibrarySort = "modified";
	private debounce = 0;
	private longPress: { x: number; y: number; timer: number; file: TFile; fired: boolean } | null = null;
	private suppressClick = false;
	private scrollTop = 0;

	constructor(leaf: WorkspaceLeaf, plugin: GoodNodesPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.contentEl.addClass("goodnodes-home");
	}

	getViewType(): string {
		return HOME_VIEW_TYPE;
	}
	getDisplayText(): string {
		return "GoodNodes";
	}
	getIcon(): string {
		return "library";
	}

	async onOpen(): Promise<void> {
		this.observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries)
					if (entry.isIntersecting) {
						// Observe the cover box: the <img> is display:none until loaded, and
						// hidden elements never intersect.
						const cover = entry.target as HTMLElement;
						this.observer?.unobserve(cover);
						const item = this.pendingCovers.find((candidate) => candidate.img.parentElement === cover);
						if (item) this.runCover(item);
					}
			},
			{ root: this.contentEl, rootMargin: "160px" },
		);
		this.registerEvent(this.app.vault.on("create", () => this.scheduleRender()));
		this.registerEvent(this.app.vault.on("delete", () => this.scheduleRender()));
		this.registerEvent(this.app.vault.on("rename", () => this.scheduleRender()));
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && this.isLibraryFile(file)) this.invalidateCover(file);
				this.scheduleRender();
			}),
		);
		this.registerDomEvent(this.contentEl, "dragover", (event) => {
			if (Array.from(event.dataTransfer?.items ?? []).some((item) => item.type === "application/pdf"))
				event.preventDefault();
		});
		this.registerDomEvent(this.contentEl, "drop", (event) => void this.handleDrop(event));
		this.render();
	}

	async onClose(): Promise<void> {
		window.clearTimeout(this.debounce);
		this.observer?.disconnect();
		this.observer = null;
		this.pendingCovers = [];
		for (const url of activeObjectUrls) URL.revokeObjectURL(url);
		activeObjectUrls.clear();
		coverCache.clear();
	}

	private isLibraryFile(file: TFile): boolean {
		return file.extension === CANVAS_EXTENSION || file.extension === "pdf";
	}
	private scheduleRender(): void {
		window.clearTimeout(this.debounce);
		this.debounce = window.setTimeout(() => this.render(), 300);
	}
	private invalidateCover(file: TFile): void {
		const prefix = `${file.path}\u0000`;
		for (const [key, url] of coverCache)
			if (key.startsWith(prefix)) {
				URL.revokeObjectURL(url);
				activeObjectUrls.delete(url);
				coverCache.delete(key);
			}
	}

	private render(): void {
		this.scrollTop = this.contentEl.scrollTop;
		this.observer?.disconnect();
		this.pendingCovers = [];
		this.coverImgs.clear();
		this.contentEl.empty();
		const header = this.contentEl.createDiv({ cls: "goodnodes-home-header" });
		header.createEl("h1", { text: "GoodNodes", cls: "goodnodes-home-title" });
		const search = header.createEl("input", {
			cls: "goodnodes-home-search",
			attr: {
				type: "search",
				placeholder: "Search notebooks and PDFs",
				"aria-label": "Search notebooks and PDFs",
			},
		});
		search.value = this.search;
		search.addEventListener("input", () => {
			this.search = search.value;
			const cursor = search.selectionStart;
			this.render();
			const replacement = this.contentEl.querySelector<HTMLInputElement>(".goodnodes-home-search");
			replacement?.focus();
			if (cursor !== null) replacement?.setSelectionRange(cursor, cursor);
		});
		const actions = header.createDiv({ cls: "goodnodes-home-actions" });
		this.button(actions, "+ New notebook", () => void this.plugin.createCanvas(), true);
		this.button(actions, "Import PDF", () => void this.importAndOpen(), false);

		const toolbar = this.contentEl.createDiv({ cls: "goodnodes-home-toolbar" });
		const chips = toolbar.createDiv({ cls: "goodnodes-home-chips" });
		for (const [value, label] of [
			["all", "All"],
			["notebooks", "Notebooks"],
			["pdfs", "PDFs"],
		] as const) {
			const chip = chips.createEl("button", {
				text: label,
				cls: `goodnodes-home-chip${this.filter === value ? " is-active" : ""}`,
			});
			chip.setAttribute("aria-pressed", String(this.filter === value));
			chip.addEventListener("click", () => {
				this.filter = value;
				this.render();
			});
		}
		const select = toolbar.createEl("select", {
			cls: "goodnodes-home-sort",
			attr: { "aria-label": "Sort notebooks" },
		});
		select.createEl("option", { value: "modified", text: "Last modified" });
		select.createEl("option", { value: "name", text: "Name" });
		select.value = this.sort;
		select.addEventListener("change", () => {
			this.sort = select.value as LibrarySort;
			this.render();
		});

		const files = filterAndSortFiles(
			this.app.vault.getFiles().map((file) => Object.assign(file, { mtime: file.stat.mtime })),
			this.search,
			this.filter,
			this.sort,
		);
		if (!files.length) {
			const empty = this.contentEl.createDiv({ cls: "goodnodes-home-empty" });
			empty.createEl("h2", {
				text: this.search || this.filter !== "all" ? "No matches" : "Your library is ready",
			});
			empty.createEl("p", {
				text:
					this.search || this.filter !== "all"
						? "Try a different search or filter."
						: "Create a handwriting notebook or bring in a PDF to get started.",
			});
			const emptyActions = empty.createDiv({ cls: "goodnodes-home-actions" });
			this.button(emptyActions, "+ New notebook", () => void this.plugin.createCanvas(), true);
			this.button(emptyActions, "Import PDF", () => void this.importAndOpen(), false);
			return;
		}
		const grid = this.contentEl.createDiv({ cls: "goodnodes-home-grid" });
		for (const file of files) this.renderCard(grid, file);
		this.contentEl.scrollTop = this.scrollTop;
	}

	private button(parent: HTMLElement, label: string, click: () => void, primary: boolean): void {
		const button = parent.createEl("button", { text: label });
		if (primary) button.addClass("goodnodes-home-primary");
		button.addEventListener("click", click);
	}
	private async importAndOpen(): Promise<void> {
		try {
			const files = await importPdfs(this.plugin);
			if (files[0]) await this.plugin.openPdf(files[0]);
		} catch (error) {
			console.error("GoodNodes PDF import failed", error);
			new Notice("Could not import PDF");
		}
	}
	private async handleDrop(event: DragEvent): Promise<void> {
		const files = Array.from(event.dataTransfer?.files ?? []).filter(
			(file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"),
		);
		if (!files.length) return;
		event.preventDefault();
		try {
			const imported = await importPickedFiles(this.plugin, files);
			if (imported[0]) await this.plugin.openPdf(imported[0]);
		} catch {
			new Notice("Could not import dropped PDF");
		}
	}

	private renderCard(grid: HTMLElement, file: TFile): void {
		// A div, not a <button>: Obsidian's global button styles would squash the card.
		const card = grid.createDiv({
			cls: "goodnodes-home-card",
			attr: { role: "button", tabindex: "0", "aria-label": `Open ${file.basename}` },
		});
		card.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				card.click();
			}
		});
		const cover = card.createDiv({ cls: "goodnodes-home-cover" });
		const key = `${file.path}\u0000${file.stat.mtime}`;
		const cached = coverCache.get(key);
		if (cached) {
			const img = cover.createEl("img", { attr: { src: cached, alt: "" } });
			this.coverImgs.set(file.path, img);
		} else {
			const icon = cover.createSpan({ cls: "goodnodes-home-cover-icon" });
			setIcon(icon, file.extension === "pdf" ? "file-text" : "pen-line");
			const img = cover.createEl("img", { attr: { alt: "", loading: "lazy" } });
			img.style.display = "none";
			this.coverImgs.set(file.path, img);
			this.pendingCovers.push({ file, img, key });
			if (this.observer) this.observer.observe(cover);
		}
		card.createSpan({ text: file.basename, cls: "goodnodes-home-title-text" });
		const pages = file.extension === "pdf" ? this.getKnownPages(file.path) : 0;
		const meta = `${formatRelativeDate(file.stat.mtime)}${pages ? ` · ${pages} pages` : ""}`;
		card.createSpan({ text: meta, cls: "goodnodes-home-meta" });
		const folder = file.parent?.path;
		if (folder && folder !== "/") card.createSpan({ text: folder, cls: "goodnodes-home-folder" });
		card.addEventListener("click", () => {
			if (this.suppressClick) {
				this.suppressClick = false;
				return;
			}
			if (file.extension === "pdf") void this.plugin.openPdf(file);
			else void this.app.workspace.getLeaf(false).openFile(file);
		});
		card.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.showMenu(file, event.clientX, event.clientY);
		});
		card.addEventListener("pointerdown", (event) => {
			if (event.pointerType === "mouse" && event.button !== 0) return;
			this.clearLongPress();
			const state = {
				x: event.clientX,
				y: event.clientY,
				file,
				fired: false,
				timer: window.setTimeout(() => {
					if (this.longPress !== state) return;
					state.fired = true;
					this.suppressClick = true;
					this.showMenu(file, state.x, state.y);
				}, 500),
			};
			this.longPress = state;
		});
		card.addEventListener("pointermove", (event) => {
			if (this.longPress && Math.hypot(event.clientX - this.longPress.x, event.clientY - this.longPress.y) > 8)
				this.clearLongPress();
		});
		card.addEventListener("pointerup", () => {
			if (!this.longPress?.fired) this.clearLongPress();
		});
		card.addEventListener("pointercancel", () => this.clearLongPress());
	}
	private clearLongPress(): void {
		if (this.longPress) window.clearTimeout(this.longPress.timer);
		this.longPress = null;
	}
	private showMenu(file: TFile, x: number, y: number): void {
		const menu = new Menu();
		this.app.workspace.trigger("file-menu", menu, file, "goodnodes-home");
		menu.showAtPosition({ x, y });
	}
	private getKnownPages(path: string): number {
		const pages = (this as any).pdfPages as Map<string, number> | undefined;
		return pages?.get(path) ?? 0;
	}
	private markPages(path: string, count: number): void {
		const pages = ((this as any).pdfPages ??= new Map<string, number>()) as Map<string, number>;
		if (pages.get(path) !== count) {
			pages.set(path, count);
			this.scheduleRender();
		}
	}
	private async runCover(item: CoverItem): Promise<void> {
		if (!this.pendingCovers.includes(item)) return;
		if (this.runningCovers >= 2) return;
		this.pendingCovers = this.pendingCovers.filter((candidate) => candidate !== item);
		this.runningCovers++;
		try {
			const blob =
				item.file.extension === "pdf"
					? await this.renderPdfCover(item.file)
					: await this.renderCanvasCover(item.file);
			if (!blob || !this.contentEl.isConnected) return;
			const url = URL.createObjectURL(blob);
			activeObjectUrls.add(url);
			coverCache.set(item.key, url);
			item.img.src = url;
			item.img.style.display = "block";
			item.img.previousElementSibling?.remove();
		} catch {
			/* Keep the icon placeholder on corrupt or unsupported files. */
		} finally {
			this.runningCovers--;
			const next = this.pendingCovers.find((candidate) => candidate.img.isConnected);
			if (next) void this.runCover(next);
		}
	}
	private async renderPdfCover(file: TFile): Promise<Blob | null> {
		const pdfjs = await loadPdfJs();
		const data = await this.app.vault.readBinary(file);
		const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
		try {
			this.markPages(file.path, doc.numPages);
			const page = await doc.getPage(1);
			const original = page.getViewport({ scale: 1 });
			const viewport = page.getViewport({ scale: COVER_WIDTH / original.width });
			const canvas = document.createElement("canvas");
			canvas.width = Math.ceil(viewport.width);
			canvas.height = Math.ceil(viewport.height);
			await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
			return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
		} finally {
			await doc.destroy();
		}
	}
	private async renderCanvasCover(file: TFile): Promise<Blob | null> {
		const parsed = JSON.parse(await this.app.vault.read(file)) as { scene?: { elements?: unknown[] } };
		const source = (parsed.scene?.elements ?? []).filter(
			(element) => (element as { type?: string }).type !== "image",
		);
		if (!source.length) return null;
		const elements = restoreElements(source as ExcalidrawElement[], null);
		const canvas = await exportToCanvas({
			elements,
			files: null,
			appState: { exportBackground: true, viewBackgroundColor: "#ffffff" },
			maxWidthOrHeight: 240,
		});
		return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
	}
}
