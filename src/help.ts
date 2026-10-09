import { App, Modal } from "obsidian";

/** GoodNodes' own help, shown instead of Excalidraw's help dialog and docs links. */
export class GoodNodesHelpModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText("GoodNodes");
		contentEl.addClass("goodnodes-help");
		const section = (title: string, items: string[]) => {
			contentEl.createEl("h4", { text: title });
			const ul = contentEl.createEl("ul");
			for (const item of items) ul.createEl("li", { text: item });
		};
		section("Writing", [
			"The pen (or mouse) writes. Fingers never draw.",
			"One finger moves the page, two fingers zoom – also while holding the pen.",
			"Tap the pen once to select it, tap it again to choose color and width.",
			"Scribble firmly back and forth over handwriting to erase it (scratch out). Undo brings it back.",
		]);
		section("Create (right-click a folder, long-press on iPad)", [
			"New GoodNodes notebook: pages with a cover and paper (blank, ruled, grid, dots).",
			"New GoodNodes whiteboard: an infinite canvas for mind maps, text, shapes and images.",
			"New text document: a normal Obsidian note.",
			"Import into GoodNodes here: copy PDFs or images from Files into the folder.",
		]);
		section("Whiteboards", [
			"Text, shapes, arrows and images are in the top toolbar; the paper button switches blank, grid and dots.",
			"Insert PDF (button top right, or ☰): its pages are placed on the board as images you can write on.",
			"Library: select something, choose “Add to library”, and reuse it in any whiteboard.",
		]);
		section("Notebooks and PDFs", [
			"Right-click a PDF → Open as GoodNodes notebook (or turn on “Open PDFs in GoodNodes” in settings).",
			"“…” menu: add, insert or delete pages, insert the pages of another PDF, export with your notes.",
			"Pages sidebar: thumbnails, outline and bookmarks. Drag the bar on the right edge to scrub through pages.",
			"Notes are stored next to the PDF (“…pdf.goodnodes.json”); an imported PDF itself only changes when you add or delete pages.",
		]);
		contentEl.createEl("p", {
			cls: "goodnodes-help-footer",
			text: "Settings → GoodNodes: scratch-out sensitivity, palm rejection, folders.",
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
