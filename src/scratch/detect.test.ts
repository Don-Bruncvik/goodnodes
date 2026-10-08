import { describe, it, expect } from "vitest";
import { analyzeScratch, findScratchedStrokes, isScratchGesture, type Pt, type StrokeGeom } from "./detect";

function interpolatePolyline(vertices: Pt[], pointsPerLeg = 12): Pt[] {
  const points: Pt[] = [];
  for (let leg = 1; leg < vertices.length; leg++) {
    const a = vertices[leg - 1], b = vertices[leg];
    for (let i = 0; i < pointsPerLeg; i++) {
      const t = i / pointsPerLeg;
      points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  points.push({ ...vertices[vertices.length - 1] });
  return points;
}

function horizontalScratch(): Pt[] {
  const vertices: Pt[] = [];
  for (let pass = 0; pass < 6; pass++) {
    const y = 5 + pass * 4;
    vertices.push({ x: pass % 2 === 0 ? 0 : 100, y });
    vertices.push({ x: pass % 2 === 0 ? 100 : 0, y: y + 1 });
  }
  return interpolatePolyline(vertices, 15);
}

function verticalZigzag(): Pt[] {
  const vertices: Pt[] = [];
  for (let i = 0; i <= 12; i++) vertices.push({ x: 4 + i * 7.5, y: i % 2 === 0 ? 3 : 27 });
  return interpolatePolyline(vertices, 8);
}

function cursiveWord(offsetX = 0, offsetY = 0): StrokeGeom[] {
  const result: StrokeGeom[] = [];
  for (let stroke = 0; stroke < 5; stroke++) {
    const points: Pt[] = [];
    const startX = 5 + stroke * 18;
    for (let i = 0; i < 32; i++) {
      const x = startX + i * 0.5;
      const phase = i / 31 * Math.PI * 2;
      points.push({ x: x + offsetX, y: 15 + Math.sin(phase) * (4 + (stroke % 2)) + offsetY });
    }
    result.push({ id: `word-${stroke}`, points });
  }
  return result;
}

describe("scratch gesture detection", () => {
  it("recognizes horizontal back-and-forth scratching and covers a cursive word", () => {
    const scratch = horizontalScratch();
    expect(isScratchGesture(scratch)).toBe(true);
    expect(findScratchedStrokes(scratch, cursiveWord())).toEqual(["word-0", "word-1", "word-2", "word-3", "word-4"]);
  });

  it("recognizes a vertical zig-zag and returns strokes under it", () => {
    const scratch = verticalZigzag();
    expect(analyzeScratch(scratch).reversals).toBeGreaterThanOrEqual(4);
    expect(isScratchGesture(scratch)).toBe(true);
    expect(findScratchedStrokes(scratch, cursiveWord())).toEqual(["word-0", "word-1", "word-2", "word-3", "word-4"]);
  });

  it("does not treat one straight line or one V-shaped back-and-forth as a scratch", () => {
    const line = interpolatePolyline([{ x: 0, y: 15 }, { x: 100, y: 15 }], 40);
    const v = interpolatePolyline([{ x: 0, y: 5 }, { x: 50, y: 25 }, { x: 100, y: 5 }], 20);
    expect(isScratchGesture(line)).toBe(false);
    expect(findScratchedStrokes(line, cursiveWord())).toEqual([]);
    expect(isScratchGesture(v)).toBe(false);
    expect(findScratchedStrokes(v, cursiveWord())).toEqual([]);
  });

  it("keeps an empty-area zig-zag as a normal stroke result", () => {
    const scratch = horizontalScratch();
    expect(isScratchGesture(scratch)).toBe(true);
    expect(findScratchedStrokes(scratch, cursiveWord(500, 0))).toEqual([]);
  });

  it("requires enough of a candidate stroke to lie under the scratch", () => {
    const scratch = horizontalScratch();
    const mostlyInside: StrokeGeom = { id: "inside", points: Array.from({ length: 80 }, (_, i) => ({ x: 8 + i, y: 15 })) };
    const partlyOutside: StrokeGeom = { id: "partial", points: Array.from({ length: 301 }, (_, i) => ({ x: 25 + i, y: 15 })) };
    const result = findScratchedStrokes(scratch, [mostlyInside, partlyOutside]);
    expect(result).toContain("inside");
    expect(result).not.toContain("partial");
  });

  it("handles empty and undersized gesture inputs without throwing", () => {
    for (const points of [[], [{ x: 0, y: 0 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }]]) {
      expect(() => analyzeScratch(points)).not.toThrow();
      expect(isScratchGesture(points)).toBe(false);
      expect(findScratchedStrokes(points, cursiveWord())).toEqual([]);
    }
  });

  it("finishes a representative batch of coverage queries quickly", () => {
    const scratchVertices: Pt[] = [];
    for (let pass = 0; pass < 20; pass++) {
      scratchVertices.push({ x: pass % 2 === 0 ? 0 : 100, y: 4 + pass * 1.1 });
      scratchVertices.push({ x: pass % 2 === 0 ? 100 : 0, y: 4 + pass * 1.1 });
    }
    const scratch = interpolatePolyline(scratchVertices, 10).slice(0, 400);
    const strokes: StrokeGeom[] = Array.from({ length: 200 }, (_, s) => ({
      id: `perf-${s}`,
      points: Array.from({ length: 300 }, (_, i) => ({ x: (i / 299) * 100, y: 3 + (s % 26) + Math.sin(i * 0.08 + s) * 1.5 })),
    }));
    const start = performance.now();
    findScratchedStrokes(scratch, strokes);
    expect(performance.now() - start).toBeLessThan(50);
  });
});
