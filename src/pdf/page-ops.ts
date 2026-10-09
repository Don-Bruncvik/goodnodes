import type { PdfSidecar } from "./model";

/** Shift sidecar indexes when `count` pages are inserted immediately before `at`. */
export function insertSidecarPages(sidecar: PdfSidecar, at: number, count = 1): PdfSidecar {
	const pages: PdfSidecar["pages"] = {};
	for (const [key, strokes] of Object.entries(sidecar.pages)) {
		const index = Number(key);
		pages[String(index >= at ? index + count : index)] = strokes;
	}
	return {
		...sidecar,
		pages,
		bookmarks: uniqueSorted(sidecar.bookmarks.map((page) => (page >= at ? page + count : page))),
		view: { ...sidecar.view, page: sidecar.view.page >= at ? sidecar.view.page + count : sidecar.view.page },
	};
}

/** Remove one page and clamp the selected page to the previous final index. */
export function deleteSidecarPage(sidecar: PdfSidecar, at: number, oldPageCount: number): PdfSidecar {
	const pages: PdfSidecar["pages"] = {};
	for (const [key, strokes] of Object.entries(sidecar.pages)) {
		const index = Number(key);
		if (index === at) continue;
		pages[String(index > at ? index - 1 : index)] = strokes;
	}
	const remaining = Math.max(1, oldPageCount - 1);
	const selected =
		sidecar.view.page > at
			? sidecar.view.page - 1
			: sidecar.view.page === at
				? Math.max(0, at - 1)
				: sidecar.view.page;
	return {
		...sidecar,
		pages,
		bookmarks: uniqueSorted(
			sidecar.bookmarks.filter((page) => page !== at).map((page) => (page > at ? page - 1 : page)),
		),
		view: { ...sidecar.view, page: Math.max(0, Math.min(remaining - 1, selected)) },
	};
}

function uniqueSorted(values: number[]): number[] {
	return [...new Set(values)].sort((a, b) => a - b);
}
