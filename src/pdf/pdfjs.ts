import { loadPdfJs } from "obsidian";

export interface PdfViewport {
	width: number;
	height: number;
	rotation?: number;
}

export interface PdfRenderTask {
	promise: Promise<void>;
	cancel(): void;
}

export interface PdfPageProxy {
	rotate?: number;
	view?: number[];
	getViewport(options: { scale: number; rotation?: number }): PdfViewport;
	render(options: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): PdfRenderTask;
	cleanup(): void;
}

export interface PdfOutlineItem {
	title: string;
	dest: string | unknown[] | null;
	items: PdfOutlineItem[];
}

export interface PdfDocumentProxy {
	numPages: number;
	getPage(page: number): Promise<PdfPageProxy>;
	getOutline(): Promise<PdfOutlineItem[] | null>;
	getDestination(destination: string): Promise<unknown[] | null>;
	getPageIndex(reference: unknown): Promise<number>;
	destroy(): Promise<void>;
}

export interface PdfJsLib {
	version?: string;
	getDocument(options: Record<string, unknown>): { promise: Promise<PdfDocumentProxy> };
}

/**
 * The asset folders Obsidian ships for its own PDF viewer. Without them pdf.js
 * can't decode JPEG 2000 images (GoodNotes exports use them for page scans,
 * which then rendered as blank white), CJK fonts, ICC colors or the standard 14 fonts.
 */
function assetOptions(): Record<string, unknown> {
	const url = (path: string) => new URL(path, window.location.href).href;
	return {
		cMapUrl: url("/lib/pdfjs/cmaps/"),
		cMapPacked: true,
		standardFontDataUrl: url("/lib/pdfjs/standard_fonts/"),
		wasmUrl: url("/lib/pdfjs/wasm/"),
		iccUrl: url("/lib/pdfjs/iccs/"),
		isEvalSupported: false,
	};
}

/** Open a PDF with Obsidian's bundled pdf.js, set up like Obsidian's own viewer. */
export async function openPdf(data: ArrayBuffer | Uint8Array, pdfjs?: PdfJsLib): Promise<PdfDocumentProxy> {
	const lib = pdfjs ?? ((await loadPdfJs()) as PdfJsLib);
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	return lib.getDocument({ data: bytes, ...assetOptions() }).promise;
}
