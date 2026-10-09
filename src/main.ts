import { Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { debug, DebugPanel } from "./debug";
import { CANVAS_EXTENSION, CANVAS_VIEW_TYPE, CanvasView, emptyCanvasFile } from "./canvas/CanvasView";
import { PDF_VIEW_TYPE, PdfNotebookView } from "./pdf/PdfView";
import { HOME_VIEW_TYPE, HomeView, importPdfs } from "./home/HomeView";
import { DEFAULT_SETTINGS, GoodNodesSettingTab, type GoodNodesSettings } from "./settings";

export default class GoodNodesPlugin extends Plugin {
	debugPanel = new DebugPanel();
	settings: GoodNodesSettings = { ...DEFAULT_SETTINGS };
	private debugRibbon: HTMLElement | null = null;

	async onload(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<GoodNodesSettings> | null) };
		this.addSettingTab(new GoodNodesSettingTab(this.app, this));
		debug.log(`GoodNodes ${this.manifest.version} loaded, UA: ${navigator.userAgent}`);
		window.addEventListener("error", this.onWindowError);
		window.addEventListener("unhandledrejection", this.onUnhandledRejection);

		this.registerView(CANVAS_VIEW_TYPE, (leaf) => new CanvasView(leaf, this));
		this.registerExtensions([CANVAS_EXTENSION], CANVAS_VIEW_TYPE);
		this.registerView(PDF_VIEW_TYPE, (leaf) => new PdfNotebookView(leaf, this));
		this.registerView(HOME_VIEW_TYPE, (leaf) => new HomeView(leaf, this));
		if (this.settings.openPdfByDefault) this.takeOverPdf();

		this.addRibbonIcon("pencil", "New GoodNodes canvas", () => void this.createCanvas());
		this.addRibbonIcon("library", "GoodNodes library", () => void this.openLibrary());
		this.updateDebugRibbon();

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) =>
						item
							.setTitle("New GoodNodes canvas")
							.setIcon("pencil")
							.onClick(() => void this.createCanvas(file)),
					);
					menu.addItem((item) =>
						item
							.setTitle("Import PDF here")
							.setIcon("file-plus")
							.onClick(async () => {
								const [first] = await importPdfs(this, file);
								if (first) await this.openPdf(first);
							}),
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

	onunload(): void {
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

	/** The GoodNodes library (home screen): all notebooks and PDFs, new notebook, import PDF. */
	async openLibrary(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(HOME_VIEW_TYPE)[0];
		const leaf = existing ?? this.app.workspace.getLeaf(true);
		if (!existing) await leaf.setViewState({ type: HOME_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	async openPdf(file: TFile): Promise<void> {
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: PDF_VIEW_TYPE, state: { file: file.path }, active: true });
	}
}

interface ViewRegistry {
	typeByExtension?: Record<string, string>;
	registerExtensions?(extensions: string[], viewType: string): void;
	unregisterExtensions?(extensions: string[]): void;
}
