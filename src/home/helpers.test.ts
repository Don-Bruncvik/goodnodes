import { describe, expect, it } from "vitest";
import { collisionSafePath, filterAndSortFiles, formatRelativeDate, sanitizePdfName } from "./helpers";

describe("home helpers", () => {
	it("sanitizes PDF names while retaining unicode", () => {
		expect(sanitizePdfName("  Résumé [Final] #1?.PDF  ")).toBe("Résumé Final 1.pdf");
		expect(sanitizePdfName("***")).toBe("Untitled.pdf");
	});

	it("adds an incrementing suffix when a path already exists", () => {
		const existing = new Set(["Books/Notes.pdf", "Books/Notes 1.pdf"]);
		expect(collisionSafePath("Books/Notes.pdf", (path) => existing.has(path))).toBe("Books/Notes 2.pdf");
	});

	it("formats dates as today, yesterday, or a compact calendar date", () => {
		const now = new Date(2026, 9, 9, 15, 0).getTime();
		expect(formatRelativeDate(new Date(2026, 9, 9, 9, 12).getTime(), now)).toBe("Today 09:12");
		expect(formatRelativeDate(new Date(2026, 9, 8, 23, 0).getTime(), now)).toBe("Yesterday");
		expect(formatRelativeDate(new Date(2026, 9, 3, 12, 0).getTime(), now)).toBe("3 Oct");
	});

	it("filters by type and path/name, then sorts by name or modification time", () => {
		const files = [
			{ path: "Books/Zeta.pdf", basename: "Zeta", extension: "pdf", mtime: 20 },
			{ path: "Books/Alpha.goodnodes", basename: "Alpha", extension: "goodnodes", mtime: 10 },
			{ path: "Other/Alpha.pdf", basename: "Alpha", extension: "pdf", mtime: 30 },
			{ path: "Readme.md", basename: "Readme", extension: "md", mtime: 50 },
		];
		expect(filterAndSortFiles(files, "books", "all", "modified").map((file) => file.basename)).toEqual([
			"Zeta",
			"Alpha",
		]);
		expect(filterAndSortFiles(files, "", "pdfs", "name").map((file) => file.path)).toEqual([
			"Other/Alpha.pdf",
			"Books/Zeta.pdf",
		]);
	});
});
