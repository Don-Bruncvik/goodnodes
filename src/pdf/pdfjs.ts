import { loadPdfJs } from "obsidian";

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
export async function openPdf(data: ArrayBuffer | Uint8Array, pdfjs?: any): Promise<any> {
	const lib = pdfjs ?? (await loadPdfJs());
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	return lib.getDocument({ data: bytes, ...assetOptions() }).promise;
}
