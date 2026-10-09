import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement, ExcalidrawFreeDrawElement } from "@excalidraw/excalidraw/element/types";
import { debug } from "../debug";
import { analyzeScratch, findScratchedStrokes, type Pt, type ScratchOptions, type StrokeGeom } from "../scratch/detect";

// Scratch-out on the Excalidraw canvas: after a freedraw stroke ends, check whether
// it is a zig-zag over existing strokes; if so, delete those strokes and the
// scratch itself.
//
// Undo: the scratch was already recorded in Excalidraw's history as "add element".
// It is removed with CaptureUpdateAction.NEVER (no history entry), the covered
// strokes with IMMEDIATELY. A single undo then brings the strokes back while the
// scratch stays gone; the scratch's own "add" entry has no visible change left and
// is skipped by Excalidraw's history.

/** A freshly finished stroke is the newest freedraw element, updated within this window. */
const FRESH_MS = 1500;

export interface ScratchConfig extends Partial<ScratchOptions> {
	enabled: boolean;
	includeText: boolean;
}

export function handleFinishedStroke(api: ExcalidrawImperativeAPI, config: ScratchConfig): void {
	if (!config.enabled) return;
	const t0 = performance.now();
	const elements = api.getSceneElements();
	let scratch: ExcalidrawFreeDrawElement | null = null;
	for (const el of elements) {
		if (el.type === "freedraw" && (!scratch || el.updated > scratch.updated)) scratch = el;
	}
	if (!scratch || Date.now() - scratch.updated > FRESH_MS) return;

	const points = absolutePoints(scratch);
	const analysis = analyzeScratch(points, config);
	if (!analysis.isScratch) return;

	const candidates: StrokeGeom[] = [];
	for (const el of elements) {
		if (el.id === scratch.id || el.locked) continue;
		if (el.type === "freedraw") candidates.push({ id: el.id, points: absolutePoints(el) });
		else if (config.includeText && el.type === "text") candidates.push({ id: el.id, points: boxPoints(el) });
	}
	const ids = new Set(findScratchedStrokes(points, candidates, config));
	debug.log(
		`scratch: reversals=${analysis.reversals} ratio=${analysis.lengthRatio.toFixed(1)} ` +
			`→ erases ${ids.size} of ${candidates.length} (${(performance.now() - t0).toFixed(1)} ms)`,
	);
	if (ids.size === 0) return; // plain scribble stays as a stroke

	const scratchId = scratch.id;
	const all = api.getSceneElementsIncludingDeleted();
	api.updateScene({
		elements: all.map((el) => (el.id === scratchId ? newElementWith(el, { isDeleted: true }) : el)),
		captureUpdate: CaptureUpdateAction.NEVER,
	});
	api.updateScene({
		elements: api
			.getSceneElementsIncludingDeleted()
			.map((el) => (ids.has(el.id) ? newElementWith(el, { isDeleted: true }) : el)),
		captureUpdate: CaptureUpdateAction.IMMEDIATELY,
	});
}

type RotatableBox = { x: number; y: number; width: number; height: number; angle: number };

function absolutePoints(el: ExcalidrawFreeDrawElement): Pt[] {
	const pts = el.points.map((point: readonly [number, number]) => ({ x: el.x + point[0], y: el.y + point[1] }));
	return el.angle ? rotateAll(pts, el) : pts;
}

/** A text box as a few horizontal scan lines, so coverage is measured over its area. */
function boxPoints(el: ExcalidrawElement): Pt[] {
	const pts: Pt[] = [];
	const rows = 3;
	const step = Math.max(2, el.width / 40);
	for (let r = 1; r <= rows; r++) {
		const y = el.y + (el.height * r) / (rows + 1);
		for (let x = el.x; x <= el.x + el.width; x += step) pts.push({ x, y });
	}
	return el.angle ? rotateAll(pts, el) : pts;
}

function rotateAll(pts: Pt[], el: RotatableBox): Pt[] {
	const cx = el.x + el.width / 2;
	const cy = el.y + el.height / 2;
	const cos = Math.cos(el.angle);
	const sin = Math.sin(el.angle);
	return pts.map((p) => ({
		x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
		y: cy + (p.x - cx) * sin + (p.y - cy) * cos,
	}));
}
