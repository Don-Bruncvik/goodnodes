// Paged notebooks (GoodNotes "Notebook"): a generated PDF with paper templates,
// opened in the PDF notebook view. CONTRACT STUB – implementation pending.
import type { App, TFile, TFolder } from "obsidian";
import type GoodNodesPlugin from "../main";

export type PaperTemplate = "blank" | "ruled" | "ruled-narrow" | "grid" | "dots";
export type PaperSize = "a4" | "letter";
export type Orientation = "portrait" | "landscape";

export interface NotebookOptions {
	title: string;
	template: PaperTemplate;
	size: PaperSize;
	orientation: Orientation;
	/** Cover color (hex) for a cover page in front, or null for no cover. */
	cover: string | null;
	/** Number of paper pages (without the cover). */
	pages: number;
}

/** Stored in the PDF sidecar so "Add page" can append matching paper. */
export interface NotebookMeta {
	template: PaperTemplate;
	size: PaperSize;
	orientation: Orientation;
	cover: string | null;
}

export const DEFAULT_NOTEBOOK: NotebookOptions = {
	title: "Untitled notebook",
	template: "ruled",
	size: "a4",
	orientation: "portrait",
	cover: "#2f6fdd",
	pages: 1,
};

/** Shows the "New notebook" dialog; resolves with the options, or null if cancelled. */
export function askNotebookOptions(_app: App, _initial?: Partial<NotebookOptions>): Promise<NotebookOptions | null> {
	throw new Error("not implemented");
}

/** Writes `<title>.pdf` (+ sidecar with NotebookMeta) into `folder`; returns the PDF. Does not open it. */
export async function createNotebook(
	_plugin: GoodNodesPlugin,
	_folder: TFolder,
	_options: NotebookOptions,
): Promise<TFile> {
	throw new Error("not implemented");
}

/** One page per image (fit to A4, orientation from the image); returns the new PDF. Does not open it. */
export async function createNotebookFromImages(
	_plugin: GoodNodesPlugin,
	_folder: TFolder,
	_images: File[],
	_title: string,
): Promise<TFile> {
	throw new Error("not implemented");
}
