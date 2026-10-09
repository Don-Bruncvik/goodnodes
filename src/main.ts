import { FuzzySuggestModal, Notice, Platform, Plugin, TFile, TFolder, normalizePath, setIcon } from "obsidian";
import { debug, DebugPanel } from "./debug";
import { CANVAS_EXTENSION, CANVAS_VIEW_TYPE, CanvasView, emptyCanvasFile } from "./canvas/CanvasView";
import { PDF_VIEW_TYPE, PdfNotebookView } from "./pdf/PdfView";
import { askNotebookOptions, createNotebook, createNotebookFromImages } from "./notebook";
import { availablePath, isImage, isPdf, pickFiles } from "./files";
import { BASIC_COLORS, DEFAULT_SETTINGS, GoodNodesSettingTab, type ColorKey, type GoodNodesSettings } from "./settings";

export default class GoodNodesPlugin extends Plugin {
	debugPanel = new DebugPanel();
	settings: GoodNodesSettings = { ...DEFAULT_SETTINGS };
	private debugRibbon: HTMLElement | null = null;

	async onload(): Promise<void> {
		const saved = ((await this.loadData()) as Partial<GoodNodesSettings> | null) ?? {};
		this.settings = { ...DEFAULT_SETTINGS, ...saved };
		// Custom colors: saved ones, else the color in use (if it isn't a basic one), then defaults.
		const custom = (key: ColorKey, current: string | undefined) => {
			const own = current && !BASIC_COLORS[key].includes(current.toLowerCase()) ? [current.toLowerCase()] : [];
			return (saved.customColors?.[key] ?? [...own, ...DEFAULT_SETTINGS.customColors[key]]).slice(0, 2);
		};
		this.settings.customColors = {
			pen: custom("pen", saved.penColor),
			highlighter: custom("highlighter", saved.highlighterColor),
			text: custom("text", saved.canvasTextColor),
			shapes: custom("shapes", undefined),
		};
		// Three different thicknesses, thin to thick, keeping the one in use.
		const widths = (saved: number[] | undefined, current: number | undefined, defaults: number[]) => {
			if (saved?.length === 3) return saved;
			const set = [...new Set([...(current !== undefined ? [current] : []), ...defaults])];
			return set.slice(0, 3).sort((a, b) => a - b);
		};
		this.settings.penWidths = widths(saved.penWidths, saved.penWidth, [1, 2, 4]);
		this.settings.highlighterWidths = widths(saved.highlighterWidths, saved.highlighterWidth, [1.6, 2.4, 3.6]);
		this.addSettingTab(new GoodNodesSettingTab(this.app, this));
		debug.log(
			`GoodNodes ${this.manifest.version} loaded, platform: ${Platform.isIosApp ? "iOS" : Platform.isMacOS ? "macOS" : "desktop"}`,
		);
		window.addEventListener("error", this.onWindowError);
		window.addEventListener("unhandledrejection", this.onUnhandledRejection);

		this.registerView(CANVAS_VIEW_TYPE, (leaf) => new CanvasView(leaf, this));
		this.registerExtensions([CANVAS_EXTENSION], CANVAS_VIEW_TYPE);
		this.registerView(PDF_VIEW_TYPE, (leaf) => new PdfNotebookView(leaf, this));
		if (this.settings.openPdfByDefault) this.takeOverPdf();

		this.updateDebugRibbon();

		this.app.workspace.onLayoutReady(() => this.decorateEmptyTabs());
		this.registerEvent(this.app.workspace.on("layout-change", () => this.decorateEmptyTabs()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.decorateEmptyTabs()));

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) =>
						item
							.setTitle("New GoodNodes notebook")
							.setIcon("notebook")
							.onClick(() => void this.newNotebook(file)),
					);
					menu.addItem((item) =>
						item
							.setTitle("New GoodNodes whiteboard")
							.setIcon("presentation")
							.onClick(() => void this.newWhiteboard(file)),
					);
					menu.addItem((item) =>
						item
							.setTitle("Import into GoodNodes here")
							.setIcon("download")
							.onClick(() => void this.importDocuments(file)),
					);
				} else if (file instanceof TFile && file.extension === "pdf") {
					menu.addItem((item) =>
						item
							.setTitle("Open as GoodNodes notebook")
							.setIcon("book-open")
							.onClick(() => void this.openPdf(file)),
					);
					if (this.settings.openPdfByDefault) {
						menu.addItem((item) =>
							item
								.setTitle("Open in Obsidian's PDF viewer")
								.setIcon("file-text")
								.onClick(
									() =>
										void this.app.workspace
											.getLeaf(true)
											.setViewState({ type: "pdf", state: { file: file.path }, active: true }),
								),
						);
					}
				}
			}),
		);
	}

	/** Add GoodNodes actions to Obsidian's "New tab" screen (next to New note / New canvas). */
	private decorateEmptyTabs(): void {
		for (const leaf of this.app.workspace.getLeavesOfType("empty")) {
			const list = leaf.view.containerEl.querySelector<HTMLElement>(".empty-state-action-list");
			if (!list || list.querySelector(".goodnodes-empty-action")) continue;
			const add = (label: string, icon: string, action: () => void) => {
				const el = list.createDiv({
					cls: "text-icon-button tappable mod-pill empty-state-action goodnodes-empty-action",
					attr: { role: "button", tabindex: "0", "aria-label": label },
				});
				setIcon(el.createSpan({ cls: "text-button-icon" }), icon);
				el.createSpan({ cls: "text-button-label", text: label });
				el.addEventListener("click", action);
			};
			add("New GoodNodes notebook", "notebook", () => void this.newNotebook());
			add("New GoodNodes whiteboard", "presentation", () => void this.newWhiteboard());
			add("Import into GoodNodes", "download", () => void this.importDocuments());
			add("Open PDF in GoodNodes", "book-open", () => new PdfPicker(this).open());
		}
	}

	onunload(): void {
		document.querySelectorAll(".goodnodes-empty-action").forEach((el) => el.remove());
		this.debugPanel.close();
		window.removeEventListener("error", this.onWindowError);
		window.removeEventListener("unhandledrejection", this.onUnhandledRejection);
	}

	/**
	 * Make tapping a PDF open it in GoodNodes. Obsidian's own PDF view already owns the
	 * extension, so release it first (internal API) and hand it back on unload.
	 */
	private takeOverPdf(): void {
		const registry = (this.app as unknown as { viewRegistry?: ViewRegistry }).viewRegistry;
		if (!registry?.registerExtensions || !registry.unregisterExtensions) {
			debug.log("cannot take over .pdf files: view registry API not available", "warn");
			return;
		}
		const previous = registry.typeByExtension?.pdf;
		try {
			// Not this.registerExtensions: its automatic cleanup would also remove the
			// registration we restore for Obsidian below.
			if (previous) registry.unregisterExtensions(["pdf"]);
			registry.registerExtensions(["pdf"], PDF_VIEW_TYPE);
		} catch (e) {
			debug.error("could not take over .pdf files", e);
		}
		this.register(() => {
			try {
				if (registry.typeByExtension?.pdf === PDF_VIEW_TYPE) registry.unregisterExtensions?.(["pdf"]);
				if (previous && !registry.typeByExtension?.pdf) registry.registerExtensions?.(["pdf"], previous);
			} catch (e) {
				debug.error("could not give .pdf back to Obsidian", e);
			}
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	updateDebugRibbon(): void {
		if (this.settings.showDebugRibbon && !this.debugRibbon) {
			this.debugRibbon = this.addRibbonIcon("bug", "GoodNodes debug panel", () => this.debugPanel.toggle());
		} else if (!this.settings.showDebugRibbon && this.debugRibbon) {
			this.debugRibbon.remove();
			this.debugRibbon = null;
			this.debugPanel.close();
		}
	}

	private onWindowError = (e: ErrorEvent) => debug.error("window error", e.error ?? e.message);
	private onUnhandledRejection = (e: PromiseRejectionEvent) => debug.error("unhandled rejection", e.reason);

	// ---- "New …" actions (folder context menu) ----

	private target(folder?: TFolder): TFolder {
		return folder ?? this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
	}

	/** Paged notebook: asks for cover/paper, creates the PDF and opens it. */
	async newNotebook(folder?: TFolder): Promise<void> {
		const options = await askNotebookOptions(this.app);
		if (!options) return;
		await this.run("create the notebook", async () => {
			const file = await createNotebook(this, this.target(folder), options);
			await this.openPdf(file);
		});
	}

	async newWhiteboard(folder?: TFolder): Promise<void> {
		await this.run("create the whiteboard", async () => this.createCanvas(this.target(folder)));
	}

	/** PDFs are copied as they are; picked images become one notebook (a page per image). */
	async importDocuments(folder?: TFolder): Promise<void> {
		const picked = await pickFiles("application/pdf,.pdf,image/*");
		if (!picked.length) return;
		await this.run("import", async () => {
			const dest = this.target(folder);
			const created: TFile[] = [];
			for (const file of picked.filter(isPdf)) {
				const path = availablePath(this.app, dest, file.name.replace(/\.pdf$/i, ""), "pdf");
				created.push(await this.app.vault.createBinary(path, await file.arrayBuffer()));
			}
			const images = picked.filter((f) => isImage(f) && !isPdf(f));
			if (images.length) {
				const title = images.length === 1 ? images[0].name.replace(/\.[^.]+$/, "") : `Images ${stamp(false)}`;
				created.push(await createNotebookFromImages(this, dest, images, title));
			}
			if (!created.length) {
				new Notice("Nothing to import: pick PDFs or images.");
				return;
			}
			new Notice(`Imported ${created.length} document${created.length === 1 ? "" : "s"}`);
			await this.openPdf(created[0]);
		});
	}

	private async run(what: string, action: () => Promise<void>): Promise<void> {
		try {
			await action();
		} catch (e) {
			debug.error(`could not ${what}`, e);
			new Notice(`GoodNodes: could not ${what}. ${e instanceof Error ? e.message : ""}`);
		}
	}

	async createCanvas(folder?: TFolder): Promise<void> {
		const parent = folder ?? this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
		let name = "Untitled";
		let path = normalizePath(`${parent.path}/${name}.${CANVAS_EXTENSION}`);
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) {
			name = `Untitled ${i}`;
			path = normalizePath(`${parent.path}/${name}.${CANVAS_EXTENSION}`);
		}
		const file = await this.app.vault.create(path, emptyCanvasFile());
		await this.app.workspace.getLeaf(true).openFile(file);
	}

	async openPdf(file: TFile): Promise<void> {
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: PDF_VIEW_TYPE, state: { file: file.path }, active: true });
	}
}

/** "2026-10-09 10.54" – safe in file names (no colon). */
function stamp(withTime: boolean): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	return withTime ? `${date} ${pad(d.getHours())}.${pad(d.getMinutes())}` : date;
}

interface ViewRegistry {
	typeByExtension?: Record<string, string>;
	registerExtensions?(extensions: string[], viewType: string): void;
	unregisterExtensions?(extensions: string[]): void;
}

class PdfPicker extends FuzzySuggestModal<TFile> {
	constructor(private plugin: GoodNodesPlugin) {
		super(plugin.app);
		this.setPlaceholder("Open a PDF as GoodNodes notebook");
	}
	getItems(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter((f) => f.extension === "pdf")
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}
	getItemText(file: TFile): string {
		return file.path;
	}
	onChooseItem(file: TFile): void {
		void this.plugin.openPdf(file);
	}
}
