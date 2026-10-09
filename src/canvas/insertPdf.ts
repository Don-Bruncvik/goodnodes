import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile } from "obsidian";
import { CaptureUpdateAction, convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { BinaryFileData, DataURL, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";
import { debug } from "../debug";
import { isPdf, pickFiles } from "../files";
import { openPdf } from "../pdf/pdfjs";

// "Insert PDF" on a whiteboard: every chosen page becomes an image on the canvas,
// stacked top to bottom at the current view. The page images are then stored in
// the vault like any other pasted image (see images.ts), so the .goodnodes file
// stays small and the pages sync.

/** Page width in scene units; the user zooms as usual. */
const PAGE_WIDTH = 800;
const PAGE_GAP = 40;
/** Rendered resolution: sharp when zoomed in ~2×, still small as JPEG. */
const RENDER_WIDTH = 1600;
const ASK_RANGE_ABOVE = 10;

interface PdfSource {
	name: string;
	bytes: ArrayBuffer;
}

export async function insertPdfIntoCanvas(app: App, api: ExcalidrawImperativeAPI): Promise<void> {
	const source = await choosePdf(app);
	if (!source) return;
	const doc = await openPdf(source.bytes);
	try {
		const total: number = doc.numPages;
		const range = total > ASK_RANGE_ABOVE ? await askRange(app, source.name, total) : [1, total];
		if (!range) return;
		const [from, to] = range;
		const notice = new Notice(`Inserting ${to - from + 1} page(s) of ${source.name}…`, 0);

		const st = api.getAppState();
		// Top-left of the stack: centered horizontally in the current view, a bit below its top.
		const viewWidth = st.width / st.zoom.value;
		let x = -st.scrollX + viewWidth / 2 - PAGE_WIDTH / 2;
		let y = -st.scrollY + 60 / st.zoom.value;
		const files: BinaryFileData[] = [];
		const skeletons: Parameters<typeof convertToExcalidrawElements>[0] = [];
		for (let n = from; n <= to; n++) {
			const page = await doc.getPage(n);
			const base = page.getViewport({ scale: 1 });
			const viewport = page.getViewport({ scale: RENDER_WIDTH / base.width });
			const canvas = document.createElement("canvas");
			canvas.width = Math.round(viewport.width);
			canvas.height = Math.round(viewport.height);
			const ctx = canvas.getContext("2d", { alpha: false });
			if (!ctx) continue;
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			await page.render({ canvasContext: ctx, viewport }).promise;
			const dataURL = canvas.toDataURL("image/jpeg", 0.88) as DataURL;
			canvas.width = canvas.height = 0;
			page.cleanup();

			const id = newFileId();
			files.push({ id, mimeType: "image/jpeg", dataURL, created: Date.now() });
			const height = (PAGE_WIDTH * base.height) / base.width;
			skeletons.push({ type: "image", fileId: id, x, y, width: PAGE_WIDTH, height });
			y += height + PAGE_GAP;
			notice.setMessage(`Inserting page ${n - from + 1} of ${to - from + 1}…`);
		}
		api.addFiles(files);
		const elements = convertToExcalidrawElements(skeletons);
		api.updateScene({
			elements: [...api.getSceneElementsIncludingDeleted(), ...elements],
			captureUpdate: CaptureUpdateAction.IMMEDIATELY,
		});
		notice.hide();
		new Notice(`Inserted ${elements.length} page(s)`);
	} catch (e) {
		debug.error("insert PDF failed", e);
		new Notice("GoodNodes: could not insert the PDF.");
	} finally {
		void doc.destroy();
	}
}

function newFileId(): FileId {
	const random =
		globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
	return random.replace(/-/g, "") as FileId;
}

/** A vault PDF, or one from the device ("From Files…"). */
function choosePdf(app: App): Promise<PdfSource | null> {
	return new Promise((resolve) => {
		new PdfPicker(app, async (choice) => {
			try {
				if (choice === "device") {
					const [file] = (await pickFiles("application/pdf,.pdf", { multiple: false })).filter(isPdf);
					resolve(file ? { name: file.name.replace(/\.pdf$/i, ""), bytes: await file.arrayBuffer() } : null);
				} else if (choice) {
					resolve({ name: choice.basename, bytes: await app.vault.readBinary(choice) });
				} else {
					resolve(null);
				}
			} catch (e) {
				debug.error("cannot read PDF", e);
				resolve(null);
			}
		}).open();
	});
}

type PdfChoice = TFile | "device";

class PdfPicker extends FuzzySuggestModal<PdfChoice> {
	private chosen = false;

	constructor(
		app: App,
		private done: (choice: PdfChoice | null) => void,
	) {
		super(app);
		this.setPlaceholder("Insert a PDF from the vault, or pick “From Files…”");
	}

	getItems(): PdfChoice[] {
		const pdfs = this.app.vault
			.getFiles()
			.filter((f) => f.extension === "pdf")
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
		return ["device", ...pdfs];
	}

	getItemText(item: PdfChoice): string {
		return item === "device" ? "From Files…" : item.path;
	}

	onChooseItem(item: PdfChoice): void {
		this.chosen = true;
		this.done(item);
	}

	onClose(): void {
		// onChooseItem runs after onClose; wait a tick before treating it as cancel.
		window.setTimeout(() => {
			if (!this.chosen) this.done(null);
		}, 0);
	}
}

function askRange(app: App, name: string, total: number): Promise<[number, number] | null> {
	return new Promise((resolve) => {
		const modal = new Modal(app);
		let from = 1;
		let to = Math.min(total, ASK_RANGE_ABOVE);
		let done = false;
		modal.titleEl.setText(`Insert pages of ${name}`);
		modal.contentEl.createEl("p", {
			text: `The PDF has ${total} pages. Each page becomes an image on the whiteboard.`,
		});
		const clamp = (v: number) => Math.min(total, Math.max(1, Math.round(v) || 1));
		new Setting(modal.contentEl).setName("From page").addText((t) => {
			t.inputEl.type = "number";
			t.setValue(String(from)).onChange((v) => (from = clamp(Number(v))));
		});
		new Setting(modal.contentEl).setName("To page").addText((t) => {
			t.inputEl.type = "number";
			t.setValue(String(to)).onChange((v) => (to = clamp(Number(v))));
		});
		new Setting(modal.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => modal.close()))
			.addButton((b) =>
				b
					.setButtonText("Insert")
					.setCta()
					.onClick(() => {
						done = true;
						modal.close();
						resolve(from <= to ? [from, to] : [to, from]);
					}),
			);
		modal.onClose = () => {
			if (!done) resolve(null);
		};
		modal.open();
	});
}
