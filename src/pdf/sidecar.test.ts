import { describe, expect, it } from "vitest";
import { parseSidecar, serializeSidecar } from "./sidecar";
import type { InkStroke, PdfSidecar } from "./model";

const example: PdfSidecar = {
	type: "goodnodes-pdf",
	version: 1,
	pdf: { size: 1234, pages: 2 },
	view: { page: 1, zoom: 1.25, sidebar: null },
	bookmarks: [0],
	pages: { "1": [{ id: "s1", tool: "pen", color: "#1971c2", width: 2, points: [[1.236, 4.567, 0.7]] }] },
	notebook: { template: "ruled", size: "a4", orientation: "portrait", cover: "#2f6fdd" },
};

describe("PDF sidecar", () => {
	it("round trips text and image box items", () => {
		const items: InkStroke[] = [
			{
				id: "t",
				tool: "pen",
				color: "#123456",
				width: 12,
				kind: "text",
				text: "Hello",
				font: 6,
				align: "center",
				points: [
					[1, 2, 0.5],
					[30, 40, 0.5],
				],
			},
			{
				id: "i",
				tool: "pen",
				color: "#123456",
				width: 1,
				kind: "image",
				src: "img/a.png",
				points: [
					[3, 4, 0.5],
					[50, 60, 0.5],
				],
			},
		];
		const data = { ...example, pages: { "0": items } };
		expect(parseSidecar(serializeSidecar(data), 2)?.pages["0"]).toEqual(items);
	});
	it("round trips compact versioned data", () => {
		const encoded = serializeSidecar(example);
		expect(encoded).not.toContain("\n");
		expect(parseSidecar(encoded, 2)).toEqual({
			...example,
			pages: { "1": [{ ...example.pages["1"][0], points: [[1.24, 4.57, 0.7]] }] },
		});
	});

	it("defaults old bookmark data and normalizes bookmark indexes", () => {
		const old = { ...example, view: { page: 1, zoom: 1.25 }, bookmarks: undefined };
		expect(parseSidecar(JSON.stringify(old), 2)?.bookmarks).toEqual([]);
		const parsed = parseSidecar(JSON.stringify({ ...example, bookmarks: [1, 1, -1, 8, 0] }), 2);
		expect(parsed?.bookmarks).toEqual([0, 1]);
		expect(parseSidecar(serializeSidecar({ ...example, bookmarks: [1, 0, 1] }), 2)?.bookmarks).toEqual([0, 1]);
	});

	it("round trips valid notebook metadata and ignores invalid metadata", () => {
		expect(parseSidecar(serializeSidecar(example), 2)?.notebook).toEqual(example.notebook);
		expect(
			parseSidecar(JSON.stringify({ ...example, notebook: { template: "bad" } }), 2)?.notebook,
		).toBeUndefined();
	});

	it("tolerates garbage and old/invalid files", () => {
		expect(parseSidecar("not json", 2)).toBeNull();
		expect(parseSidecar(JSON.stringify({ type: "goodnodes-pdf", version: 0 }), 2)).toBeNull();
	});

	it("skips malformed and out-of-range stroke records", () => {
		const parsed = parseSidecar(JSON.stringify({ ...example, pages: { "0": [null], "9": example.pages["1"] } }), 2);
		expect(parsed?.pages).toEqual({});
	});

	it("drops unknown or invalid box item kinds", () => {
		const base = example.pages["1"][0];
		const parsed = parseSidecar(
			JSON.stringify({
				...example,
				pages: {
					"0": [
						{
							...base,
							kind: "unknown",
							text: "x",
							points: [
								[0, 0, 0.5],
								[1, 1, 0.5],
							],
						},
						{
							...base,
							kind: "text",
							points: [
								[0, 0, 0.5],
								[1, 1, 0.5],
							],
						},
						{
							...base,
							kind: "image",
							src: "",
							points: [
								[0, 0, 0.5],
								[1, 1, 0.5],
							],
						},
					],
				},
			}),
			2,
		);
		expect(parsed?.pages).toEqual({});
	});
});
