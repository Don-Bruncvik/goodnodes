import { describe, expect, it } from "vitest";
import { PdfHistory } from "./history";
import type { InkStroke } from "./model";

const stroke = (id: string): InkStroke => ({ id, tool: "pen", color: "#1e1e1e", width: 2, points: [[1, 2, 0.5]] });

describe("PDF history", () => {
	it("undoes and redoes added strokes", () => {
		const pages = new Map([[0, [stroke("a")]]]);
		const history = new PdfHistory();
		history.push({ page: 0, added: [stroke("a")], removed: [] });
		expect(history.undo(pages)?.page).toBe(0);
		expect(pages.has(0)).toBe(false);
		history.redo(pages);
		expect(pages.get(0)?.map((item) => item.id)).toEqual(["a"]);
	});

	it("keeps a scratch removal as one undo/redo entry without restoring its scratch stroke", () => {
		const pages = new Map<number, InkStroke[]>([]);
		const removed = [stroke("old-a"), stroke("old-b")];
		historySetup(pages, removed);
		const history = new PdfHistory();
		history.push({ page: 3, added: [], removed });
		history.undo(pages);
		expect(pages.get(3)?.map((item) => item.id)).toEqual(["old-a", "old-b"]);
		history.redo(pages);
		expect(pages.has(3)).toBe(false);
	});
});

function historySetup(pages: Map<number, InkStroke[]>, strokes: InkStroke[]): void {
	pages.set(3, strokes);
}
