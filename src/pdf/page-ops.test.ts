import { describe, expect, it } from "vitest";
import { deleteSidecarPage, insertSidecarPages } from "./page-ops";
import type { PdfSidecar } from "./model";

const initial: PdfSidecar = {
	type: "goodnodes-pdf",
	version: 1,
	pdf: { size: 100, pages: 4 },
	view: { page: 2, zoom: 1, sidebar: null },
	bookmarks: [0, 1, 1, 3],
	pages: { "0": [], "1": [], "2": [], "3": [] },
};

describe("PDF page index shifts", () => {
	it("inserts at index and shifts ink, bookmarks, and current page", () => {
		const value = insertSidecarPages(initial, 2, 2);
		expect(Object.keys(value.pages).sort()).toEqual(["0", "1", "4", "5"]);
		expect(value.bookmarks).toEqual([0, 1, 5]);
		expect(value.view.page).toBe(4);
	});
	it("deletes an index and deduplicates shifted bookmarks", () => {
		const value = deleteSidecarPage(initial, 1, 4);
		expect(Object.keys(value.pages).sort()).toEqual(["0", "1", "2"]);
		expect(value.bookmarks).toEqual([0, 2]);
		expect(value.view.page).toBe(1);
	});
	it("deletes the last page and selects the new final page", () => {
		const value = deleteSidecarPage(initial, 3, 4);
		expect(value.view.page).toBe(2);
		expect(value.bookmarks).toEqual([0, 1]);
	});
});
