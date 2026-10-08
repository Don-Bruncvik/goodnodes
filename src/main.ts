import { FuzzySuggestModal, Plugin, TFile, TFolder, normalizePath } from "obsidian";
import { debug, DebugPanel } from "./debug";
import { CANVAS_EXTENSION, CANVAS_VIEW_TYPE, CanvasView, emptyCanvasFile } from "./canvas/CanvasView";
import { PDF_VIEW_TYPE, PdfNotebookView } from "./pdf/PdfView";

export default class GoodNodesPlugin extends Plugin {
	debugPanel = new DebugPanel();

	async onload(): Promise<void> {
		debug.log(`GoodNodes ${this.manifest.version} loaded, UA: ${navigator.userAgent}`);
		window.addEventListener("error", this.onWindowError);
		window.addEventListener("unhandledrejection", this.onUnhandledRejection);

		this.registerView(CANVAS_VIEW_TYPE, (leaf) => new CanvasView(leaf, this));
		this.registerExtensions([CANVAS_EXTENSION], CANVAS_VIEW_TYPE);
		this.registerView(PDF_VIEW_TYPE, (leaf) => new PdfNotebookView(leaf, this));

		this.addRibbonIcon("pencil", "New GoodNodes canvas", () => void this.createCanvas());
		this.addRibbonIcon("book-open", "Open PDF as GoodNodes notebook", () => new PdfPickerModal(this).open());
		this.addRibbonIcon("bug", "GoodNodes debug panel", () => this.debugPanel.toggle());

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (file instanceof TFolder) {
					menu.addItem((item) =>
						item.setTitle("New GoodNodes canvas").setIcon("pencil").onClick(() => void this.createCanvas(file)),
					);
				} else if (file instanceof TFile && file.extension === "pdf") {
					menu.addItem((item) =>
						item.setTitle("Open as GoodNodes notebook").setIcon("book-open").onClick(() => void this.openPdf(file)),
					);
				}
			}),
		);
	}

	onunload(): void {
		this.debugPanel.close();
		window.removeEventListener("error", this.onWindowError);
		window.removeEventListener("unhandledrejection", this.onUnhandledRejection);
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

	async openPdf(file: TFile): Promise<void> {
		const leaf = this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: PDF_VIEW_TYPE, state: { file: file.path }, active: true });
	}
}

class PdfPickerModal extends FuzzySuggestModal<TFile> {
	constructor(private plugin: GoodNodesPlugin) {
		super(plugin.app);
		this.setPlaceholder("Pick a PDF to open as notebook");
	}
	getItems(): TFile[] {
		return this.app.vault.getFiles().filter((f) => f.extension === "pdf");
	}
	getItemText(file: TFile): string {
		return file.path;
	}
	onChooseItem(file: TFile): void {
		void this.plugin.openPdf(file);
	}
}
