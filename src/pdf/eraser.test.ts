import { describe, expect, it } from "vitest";
import { findEraserHits } from "./eraser";
import type { InkPoint, InkStroke } from "./model";

const stroke: InkStroke = {
	id: "line",
	tool: "pen",
	color: "#1e1e1e",
	width: 2,
	points: [
		[20, 5, 0.5],
		[20, 20, 0.5],
	],
};

describe("PDF stroke eraser", () => {
	it("hits strokes within its radius along the eraser path", () => {
		const path: InkPoint[] = [
			[10, 10, 0.5],
			[30, 10, 0.5],
		];
		expect(findEraserHits(path, [stroke], 6)).toEqual(["line"]);
	});

	it("leaves strokes outside its radius", () => {
		expect(
			findEraserHits(
				[
					[0, 0, 0.5],
					[5, 0, 0.5],
				],
				[stroke],
				4,
			),
		).toEqual([]);
	});

	it("detects crossing long segments even when their stored endpoints are far apart", () => {
		const longLine: InkStroke = {
			...stroke,
			id: "long",
			points: [
				[0, 10, 0.5],
				[100, 10, 0.5],
			],
		};
		expect(
			findEraserHits(
				[
					[50, 0, 0.5],
					[50, 20, 0.5],
				],
				[longLine],
				1,
			),
		).toEqual(["long"]);
	});
});
