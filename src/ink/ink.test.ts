import { describe, expect, it } from "vitest";
import { recognizeShape } from "./shapes";
import { boundsOf, pointInPolygon, strokesInLasso, transformStrokes } from "./lasso";
import { splitStrokesByEraser } from "../pdf/eraser";
import type { InkStroke } from "../pdf/model";
import { strokeOptions } from "./penStyle";

const stroke = (id: string, points: [number, number, number][]): InkStroke => ({
	id,
	tool: "pen",
	color: "#123456",
	width: 2,
	points,
});
const noisy = (points: [number, number][]): [number, number][] =>
	points.map(([x, y], i) => [x + (i % 2 ? 0.25 : -0.25), y + (i % 3 ? -0.2 : 0.2)]);

describe("ink recognition and geometry", () => {
	it("uses the expected width and pressure response for pen types and highlighter", () => {
		expect(strokeOptions("pen", undefined, 2)).toMatchObject({ size: 2, thinning: 0.6 });
		expect(strokeOptions("pen", "ball", 2)).toMatchObject({ size: 2, thinning: 0, simulatePressure: false });
		expect(strokeOptions("pen", "brush", 2)).toMatchObject({ size: 2.4, thinning: 0.85 });
		expect(strokeOptions("highlighter", undefined, 2)).toMatchObject({ size: 10, thinning: 0 });
	});
	it("recognizes line, triangle, rectangle, ellipse and rejects a scribble", () => {
		expect(recognizeShape(noisy(Array.from({ length: 20 }, (_, i) => [i * 5, i * 2])))?.kind).toBe("line");
		expect(
			recognizeShape(
				noisy([
					[0, 0],
					[50, 100],
					[100, 0],
					[0, 0],
					[0, 1],
					[0, 0],
				]),
			)?.kind,
		).toBe("triangle");
		expect(
			recognizeShape(
				noisy([
					[0, 0],
					[100, 0],
					[100, 60],
					[0, 60],
					[0, 0],
				]),
			)?.kind,
		).toBe("rectangle");
		const ellipse = Array.from(
			{ length: 50 },
			(_, i) =>
				[50 + 40 * Math.cos((i * Math.PI * 2) / 49), 40 + 25 * Math.sin((i * Math.PI * 2) / 49)] as [
					number,
					number,
				],
		);
		expect(recognizeShape(ellipse)?.kind).toBe("ellipse");
		expect(
			recognizeShape([
				[0, 0],
				[20, 30],
				[40, 0],
				[20, 30],
				[40, 40],
				[0, 20],
				[35, 10],
				[0, 0],
			]),
		).toBeNull();
	});
	it("selects by point fraction, reports bounds, and transforms with fresh ids", () => {
		const a = stroke("a", [
				[2, 2, 0.5],
				[3, 3, 0.5],
				[80, 80, 0.5],
			]),
			b = stroke("b", [
				[80, 80, 0.5],
				[90, 90, 0.5],
			]);
		const polygon: [number, number][] = [
			[0, 0],
			[10, 0],
			[10, 10],
			[0, 10],
		];
		expect(pointInPolygon([5, 5], polygon)).toBe(true);
		expect(strokesInLasso(polygon, [a, b])).toEqual([a]);
		expect(boundsOf([a])).toEqual({ x: 2, y: 2, width: 78, height: 78 });
		const moved = transformStrokes([a], { dx: 1, dy: 2, scale: 2, originX: 0, originY: 0 })[0];
		expect(moved.id).not.toBe(a.id);
		expect(moved.points[0]).toEqual([5, 6, 0.5]);
		expect(moved.width).toBe(4);
	});
	it("splits around the precise eraser path", () => {
		const source = stroke(
			"s",
			Array.from({ length: 11 }, (_, i) => [i * 10, 0, 0.5]),
		);
		const result = splitStrokesByEraser(
			[
				[50, -5, 0.5],
				[50, 5, 0.5],
			],
			[source],
			2,
		);
		expect(result.removed).toEqual([source]);
		expect(result.added.length).toBe(2);
		expect(result.added.every((piece) => piece.id !== source.id && piece.points.length >= 2)).toBe(true);
	});
	it("leaves strokes the precise eraser doesn't touch alone", () => {
		const far = stroke("far", [
			[0, 50, 0.5],
			[100, 50, 0.5],
		]);
		const result = splitStrokesByEraser(
			[
				[50, -5, 0.5],
				[50, 5, 0.5],
			],
			[far],
			2,
		);
		expect(result).toEqual({ removed: [], added: [] });
	});
});
