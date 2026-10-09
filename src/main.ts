import { Notice, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { debug, DebugPanel } from "./debug";
import { CANVAS_EXTENSION, CANVAS_VIEW_TYPE, CanvasView, emptyCanvasFile } from "./canvas/CanvasView";
import { PDF_VIEW_TYPE, PdfNotebookView } from "./pdf/PdfView";
import { askNotebookOptions, createNotebook, createNotebookFromImages } from "./notebook";
import { availablePath, isImage, isPdf, pickFiles } from "./files";
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
		if (this.settings.openPdfByDefault) this.takeOverPdf();

		this.updateDebugRibbon();

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
							.setTitle("New text document")
							.setIcon("file-text")
							.onClick(() => void this.newTextDoc(file)),
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

	/** GoodNotes "Text Doc" = a regular Obsidian note. */
	async newTextDoc(folder?: TFolder): Promise<void> {
		await this.run("create the document", async () => {
			const path = availablePath(this.app, this.target(folder), "Untitled document", "md");
			const file = await this.app.vault.create(path, "");
			await this.app.workspace.getLeaf(true).openFile(file, { state: { mode: "source" } });
		});
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
