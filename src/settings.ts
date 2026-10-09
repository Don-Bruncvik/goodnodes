import { App, PluginSettingTab, Setting } from "obsidian";
import type GoodNodesPlugin from "./main";
import { PDF_VIEW_TYPE, PdfNotebookView } from "./pdf/PdfView";
import type { PenType } from "./ink/penStyle";

export interface GoodNodesSettings {
	// Last used tool settings, chosen in the pen popover (tap the active pen) and
	// remembered across notebooks and restarts. Not shown in the settings tab.
	/** PDF pen ink color. */
	penColor: string;
	/** PDF pen width in page points. */
	penWidth: number;
	penWidths: number[];
	/** The two user-set colors per tool, after the three basic ones (GoodNotes-style). */
	customColors: Record<ColorKey, string[]>;
	highlighterColor: string;
	/** PDF highlighter width, in stroke.width units (highlighters render 5× wider than pens). */
	highlighterWidth: number;
	highlighterWidths: number[];
	/** PDF eraser radius in CSS px. */
	eraserSize: number;
	penType: PenType;
	eraserMode: "precise" | "stroke";
	eraserHighlighterOnly: boolean;
	drawAndHold: boolean;
	/** Canvas (Excalidraw) freedraw color and width. */
	canvasPenColor: string;
	canvasPenWidth: number;
	canvasFingerDrawing: "auto" | "on" | "off";
	canvasTextColor: string;
	canvasTextSize: number;
	canvasTextFont: number;
	canvasTextAlign: "left" | "center" | "right";
	/** Smooth strokes with perfect-freehand's streamline/smoothing. */
	smoothing: boolean;
	scratchEnabled: boolean;
	/** Direction reversals needed to count as scratching out. */
	scratchMinReversals: number;
	/** Fraction (0–1) of a stroke that must lie under the scratch to be erased. */
	scratchCoverage: number;
	/** Also erase canvas text boxes by scratching over them. */
	scratchText: boolean;
	/** Touches with a contact larger than this (CSS px) are treated as a palm. 0 = off. */
	palmMaxTouchSize: number;
	/** Open PDFs in GoodNodes when tapped in the file list (instead of Obsidian's viewer). Needs reload. */
	openPdfByDefault: boolean;
	pdfPageDirection: "horizontal" | "vertical";
	/** Folder for images pasted into canvases; empty = Obsidian's attachment setting. */
	imageFolder: string;
	shapeKind: "line" | "arrow" | "rectangle" | "ellipse" | "diamond";
	shapeColor: string;
	showDebugRibbon: boolean;
	/** Canvas library items ("Add to library"), shared by all notebooks. Not shown in the tab. */
	library: unknown[];
}

export const DEFAULT_SETTINGS: GoodNodesSettings = {
	penColor: "#1e1e1e",
	penWidth: 2,
	penWidths: [1, 2, 4],
	customColors: {
		pen: ["#2f9e44", "#9c36b5"],
		highlighter: ["#faa2c1", "#ffa94d"],
		text: ["#2f9e44", "#9c36b5"],
		shapes: ["#2f9e44", "#9c36b5"],
	},

	highlighterColor: "#ffd43b",
	highlighterWidth: 2.4,
	highlighterWidths: [1.6, 2.4, 3.6],
	eraserSize: 10,
	penType: "fountain",
	eraserMode: "stroke",
	eraserHighlighterOnly: false,
	drawAndHold: true,
	canvasPenColor: "#1e1e1e",
	canvasPenWidth: 2,
	canvasFingerDrawing: "auto",
	canvasTextColor: "#1e1e1e",
	canvasTextSize: 20,
	canvasTextFont: 5,
	canvasTextAlign: "left",
	smoothing: true,
	scratchEnabled: true,
	scratchMinReversals: 4,
	scratchCoverage: 0.6,
	scratchText: true,
	palmMaxTouchSize: 0,
	openPdfByDefault: false,
	pdfPageDirection: "horizontal",
	imageFolder: "",
	shapeKind: "rectangle",
	shapeColor: "#1e1e1e",
	showDebugRibbon: false,
	library: [],
};

export class GoodNodesSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: GoodNodesPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => void this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl).setName("Writing").setHeading();
		new Setting(containerEl)
			.setName("Smooth strokes")
			.setDesc("Even out shaky lines while writing.")
			.addToggle((t) => t.setValue(s.smoothing).onChange((v) => ((s.smoothing = v), save())));
		new Setting(containerEl)
			.setName("Draw with finger")
			.setDesc("Choose whether fingers use the active canvas tool or pan and zoom.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("auto", "Automatic (until Apple Pencil is used)")
					.addOption("on", "Always")
					.addOption("off", "Never (fingers only scroll and zoom)")
					.setValue(s.canvasFingerDrawing)
					.onChange((value) => {
						s.canvasFingerDrawing = value as GoodNodesSettings["canvasFingerDrawing"];
						void this.plugin.saveSettings();
						for (const leaf of this.app.workspace.getLeavesOfType("goodnodes-canvas"))
							(leaf.view as unknown as { applyFingerSetting(): void }).applyFingerSetting();
					}),
			);

		new Setting(containerEl)
			.setName("Palm rejection: max finger size")
			.setDesc(
				"Touches with a larger contact area are ignored as a resting palm. 0 turns this off. Touches are always ignored while the pen is down.",
			)
			.addSlider((sl) =>
				sl
					.setLimits(0, 120, 5)
					.setValue(s.palmMaxTouchSize)
					.onChange((v) => ((s.palmMaxTouchSize = v), save())),
			);

		new Setting(containerEl).setName("Scratch out to erase").setHeading();
		new Setting(containerEl)
			.setName("Enabled")
			.setDesc("Zig-zag firmly over handwriting to erase it. A plain scribble over empty space stays a stroke.")
			.addToggle((t) => t.setValue(s.scratchEnabled).onChange((v) => ((s.scratchEnabled = v), save())));
		new Setting(containerEl)
			.setName("Direction changes needed")
			.setDesc("Higher = you must scratch harder. Default 4.")
			.addSlider((sl) =>
				sl
					.setLimits(3, 10, 1)
					.setValue(s.scratchMinReversals)
					.onChange((v) => ((s.scratchMinReversals = v), save())),
			);
		new Setting(containerEl)
			.setName("Coverage")
			.setDesc("How much of a stroke must be under the scratch to be erased (%). Default 60.")
			.addSlider((sl) =>
				sl
					.setLimits(30, 95, 5)
					.setValue(Math.round(s.scratchCoverage * 100))
					.onChange((v) => ((s.scratchCoverage = v / 100), save())),
			);
		new Setting(containerEl)
			.setName("Also erase text boxes")
			.setDesc("On the canvas, scratching over a text box deletes it too.")
			.addToggle((t) => t.setValue(s.scratchText).onChange((v) => ((s.scratchText = v), save())));

		new Setting(containerEl).setName("Files").setHeading();
		new Setting(containerEl)
			.setName("Page turning")
			.setDesc("Choose how pages are arranged in the GoodNodes PDF view.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("horizontal", "Horizontal, like a book")
					.addOption("vertical", "Vertical scrolling")
					.setValue(s.pdfPageDirection)
					.onChange((value) => {
						s.pdfPageDirection = value as "horizontal" | "vertical";
						void this.plugin.saveSettings();
						for (const leaf of this.app.workspace.getLeavesOfType(PDF_VIEW_TYPE))
							(leaf.view as PdfNotebookView).applyPageDirection();
					}),
			);
		new Setting(containerEl)
			.setName("Open PDFs in GoodNodes")
			.setDesc(
				"Tapping a PDF opens it as a notebook instead of Obsidian's viewer. Restart Obsidian after changing.",
			)
			.addToggle((t) => t.setValue(s.openPdfByDefault).onChange((v) => ((s.openPdfByDefault = v), save())));
		new Setting(containerEl)
			.setName("Image folder")
			.setDesc("Where images added to a canvas are stored. Empty = Obsidian's attachment folder setting.")
			.addText((t) =>
				t
					.setPlaceholder("E.g. Attachments")
					.setValue(s.imageFolder)
					.onChange((v) => ((s.imageFolder = v.trim()), save())),
			);

		new Setting(containerEl).setName("Troubleshooting").setHeading();
		new Setting(containerEl)
			.setName("Show debug panel button")
			.setDesc("Adds a ribbon button with a live log of pen/touch events and errors. Useful for bug reports.")
			.addToggle((t) =>
				t.setValue(s.showDebugRibbon).onChange((v) => {
					s.showDebugRibbon = v;
					save();
					this.plugin.updateDebugRibbon();
				}),
			);
	}
}

export type ColorKey = "pen" | "highlighter" | "text" | "shapes";

/** Three fixed colors per tool; two more are the user's own (`customColors`). */
export const BASIC_COLORS: Record<ColorKey, string[]> = {
	pen: ["#1e1e1e", "#1971c2", "#e03131"],
	highlighter: ["#ffd43b", "#69db7c", "#74c0fc"],
	text: ["#1e1e1e", "#1971c2", "#e03131"],
	shapes: ["#1e1e1e", "#1971c2", "#e03131"],
};

export function colorKey(tool: string): ColorKey {
	return tool === "highlighter" || tool === "text" || tool === "shapes" ? tool : "pen";
}

/** The five colors the toolbar shows for a tool: 3 basic, then the 2 custom ones. */
export function toolColors(settings: GoodNodesSettings, tool: string): string[] {
	const key = colorKey(tool);
	return [...BASIC_COLORS[key], ...settings.customColors[key]];
}

/** A color picked in slot `index` (0–4); slots 3 and 4 are the custom ones and remember it. */
export function rememberToolColor(settings: GoodNodesSettings, tool: string, index: number, color: string): void {
	if (index >= BASIC_COLORS.pen.length)
		settings.customColors[colorKey(tool)][index - BASIC_COLORS.pen.length] = color;
}
