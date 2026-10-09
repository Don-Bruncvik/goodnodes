import { describe, expect, it } from "vitest";
import { templateShapes } from "./paper";

describe("notebook paper template geometry", () => {
	it("leaves blank pages empty", () => {
		expect(templateShapes("blank", 595.28, 841.89)).toEqual([]);
	});
	it("uses 8 mm ruled spacing with the first line 25 mm from top and a red margin", () => {
		const lines = templateShapes("ruled", 595.28, 841.89).filter((shape) => shape.type === "line");
		expect(lines[0]).toMatchObject({
			y1: expect.closeTo((25 * 72) / 25.4),
			y2: expect.closeTo((25 * 72) / 25.4),
			width: 0.5,
		});
		expect(lines[1].y1 - lines[0].y1).toBeCloseTo((8 * 72) / 25.4);
		expect(lines[lines.length - 1]).toMatchObject({
			x1: expect.closeTo((25 * 72) / 25.4),
			x2: expect.closeTo((25 * 72) / 25.4),
		});
	});
	it("places grid lines and round dots at 5 mm spacing", () => {
		const grid = templateShapes("grid", 120, 120).filter((shape) => shape.type === "line");
		const vertical = grid.filter((shape) => shape.type === "line" && shape.x1 === shape.x2);
		expect(vertical[1].x1 - vertical[0].x1).toBeCloseTo((5 * 72) / 25.4);
		const dots = templateShapes("dots", 120, 120).filter((shape) => shape.type === "dot");
		expect(dots[0]).toMatchObject({ radius: 0.45 });
		expect(dots[1].x - dots[0].x).toBeCloseTo((5 * 72) / 25.4);
	});
});
