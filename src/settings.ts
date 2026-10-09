import { App, PluginSettingTab, Setting } from "obsidian";
import type GoodNodesPlugin from "./main";

export interface GoodNodesSettings {
	// Last used tool settings, chosen in the pen popover (tap the active pen) and
	// remembered across notebooks and restarts. Not shown in the settings tab.
	/** PDF pen ink color. */
	penColor: string;
	/** PDF pen width in page points. */
	penWidth: number;
	highlighterColor: string;
	/** PDF highlighter width, in stroke.width units (highlighters render 5× wider than pens). */
	highlighterWidth: number;
	/** PDF eraser radius in CSS px. */
	eraserSize: number;
	/** Canvas (Excalidraw) freedraw color and width. */
	canvasPenColor: string;
	canvasPenWidth: number;
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
	/** Folder for images pasted into canvases; empty = Obsidian's attachment setting. */
	imageFolder: string;
	/** Folder where "Import PDF" puts PDFs; empty = vault root. */
	importFolder: string;
	showDebugRibbon: boolean;
	/** Canvas library items ("Add to library"), shared by all notebooks. Not shown in the tab. */
	library: unknown[];
}

export const DEFAULT_SETTINGS: GoodNodesSettings = {
	penColor: "#1e1e1e",
	penWidth: 2,
	highlighterColor: "#ffd43b",
	highlighterWidth: 2.4,
	eraserSize: 10,
	canvasPenColor: "#1e1e1e",
	canvasPenWidth: 2,
	smoothing: true,
	scratchEnabled: true,
	scratchMinReversals: 4,
	scratchCoverage: 0.6,
	scratchText: true,
	palmMaxTouchSize: 0,
	openPdfByDefault: false,
	imageFolder: "",
	importFolder: "GoodNodes",
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
			.setName("Palm rejection: max finger size")
			.setDesc(
				"Touches with a larger contact area are ignored as a resting palm. 0 turns this off. Touches are always ignored while the pen is down.",
			)
			.addSlider((sl) =>
				sl
					.setLimits(0, 120, 5)
					.setValue(s.palmMaxTouchSize)
					.setDynamicTooltip()
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
					.setDynamicTooltip()
					.onChange((v) => ((s.scratchMinReversals = v), save())),
			);
		new Setting(containerEl)
			.setName("Coverage")
			.setDesc("How much of a stroke must be under the scratch to be erased (%). Default 60.")
			.addSlider((sl) =>
				sl
					.setLimits(30, 95, 5)
					.setValue(Math.round(s.scratchCoverage * 100))
					.setDynamicTooltip()
					.onChange((v) => ((s.scratchCoverage = v / 100), save())),
			);
		new Setting(containerEl)
			.setName("Also erase text boxes")
			.setDesc("On the canvas, scratching over a text box deletes it too.")
			.addToggle((t) => t.setValue(s.scratchText).onChange((v) => ((s.scratchText = v), save())));

		new Setting(containerEl).setName("Files").setHeading();
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
					.setPlaceholder("e.g. Attachments")
					.setValue(s.imageFolder)
					.onChange((v) => ((s.imageFolder = v.trim()), save())),
			);
		new Setting(containerEl)
			.setName("PDF import folder")
			.setDesc('Where PDFs added with "Import PDF" in the GoodNodes library are copied. Empty = vault root.')
			.addText((t) =>
				t
					.setPlaceholder("GoodNodes")
					.setValue(s.importFolder)
					.onChange((v) => ((s.importFolder = v.trim()), save())),
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
