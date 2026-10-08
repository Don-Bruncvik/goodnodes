import { describe, expect, it } from "vitest";
import { viewportToPdfPoint } from "./export";
import { displayedToUnrotated, unrotatedToDisplayed } from "./coordinates";

const box = { x: 10, y: 20, width: 200, height: 300 };

describe("PDF viewport coordinate export mapping", () => {
	it("maps unrotated top-left viewport coordinates through a crop box offset", () => {
		expect(viewportToPdfPoint(0, 0, box, 0)).toEqual([10, 320]);
		expect(viewportToPdfPoint(200, 300, box, 0)).toEqual([210, 20]);
	});

	it("maps clockwise quarter turns", () => {
		expect(viewportToPdfPoint(0, 0, box, 90)).toEqual([10, 20]);
		expect(viewportToPdfPoint(300, 200, box, 90)).toEqual([210, 320]);
		expect(viewportToPdfPoint(0, 0, box, 180)).toEqual([210, 20]);
		expect(viewportToPdfPoint(200, 300, box, 180)).toEqual([10, 320]);
		expect(viewportToPdfPoint(0, 0, box, 270)).toEqual([210, 320]);
		expect(viewportToPdfPoint(300, 200, box, 270)).toEqual([10, 20]);
	});

	it("round trips display coordinates to the unrotated page model", () => {
		for (const rotation of [0, 90, 180, 270]) {
			const info = { width: 200, height: 300, rotation };
			const point: [number, number] = [41, 83];
			const displayed = unrotatedToDisplayed(point[0], point[1], info);
			expect(displayedToUnrotated(displayed[0], displayed[1], info)).toEqual(point);
		}
	});
});
