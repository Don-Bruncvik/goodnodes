import { describe, expect, it } from "vitest";
import { parseSidecar, serializeSidecar } from "./sidecar";
import type { PdfSidecar } from "./model";

const example: PdfSidecar = {
	type: "goodnodes-pdf", version: 1, pdf: { size: 1234, pages: 2 }, view: { page: 1, zoom: 1.25 },
	pages: { "1": [{ id: "s1", tool: "pen", color: "#1971c2", width: 2, points: [[1.236, 4.567, 0.7]] }] },
};

describe("PDF sidecar", () => {
	it("round trips compact versioned data", () => {
		const encoded = serializeSidecar(example);
		expect(encoded).not.toContain("\n");
		expect(parseSidecar(encoded, 2)).toEqual({ ...example, pages: { "1": [{ ...example.pages["1"][0], points: [[1.24, 4.57, 0.7]] }] } });
	});

	it("tolerates garbage and old/invalid files", () => {
		expect(parseSidecar("not json", 2)).toBeNull();
		expect(parseSidecar(JSON.stringify({ type: "goodnodes-pdf", version: 0 }), 2)).toBeNull();
	});

	it("skips malformed and out-of-range stroke records", () => {
		const parsed = parseSidecar(JSON.stringify({ ...example, pages: { "0": [null], "9": example.pages["1"] } }), 2);
		expect(parsed?.pages).toEqual({});
	});
});
