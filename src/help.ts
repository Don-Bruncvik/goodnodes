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
		section("Canvas notebooks", [
			"Text, shapes, arrows and images are in the top toolbar.",
			"The paper button (top right) switches between blank, grid and dots.",
			"Library: select something on the canvas, then choose “Add to library” to reuse it in any notebook.",
		]);
		section("PDF notebooks", [
			"Open the GoodNodes library (ribbon) and tap “Import PDF”, or tap a PDF in the library.",
			"Pages sidebar: thumbnails, outline and bookmarks. Drag the bar on the right edge to scrub through pages.",
			"Your notes are stored next to the PDF (“…pdf.goodnodes.json”); the PDF itself is never changed. Export via “…”.",
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
