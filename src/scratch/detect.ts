export interface Pt {
	x: number;
	y: number;
}
export interface StrokeGeom {
	id: string;
	points: Pt[];
}
export interface ScratchOptions {
	minReversals: number;
	minLengthRatio: number;
	coverage: number;
	minRadius: number;
}

export const DEFAULT_SCRATCH_OPTIONS: ScratchOptions = {
	minReversals: 4,
	minLengthRatio: 2.5,
	coverage: 0.6,
	minRadius: 4,
};

export interface ScratchAnalysis {
	isScratch: boolean;
	reversals: number;
	lengthRatio: number;
	turningPoints: Pt[];
	radius: number;
}

const mergedOptions = (opts?: Partial<ScratchOptions>): ScratchOptions => ({
	...DEFAULT_SCRATCH_OPTIONS,
	...opts,
});

const distance = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y);

export function pathLength(points: Pt[]): number {
	let length = 0;
	for (let i = 1; i < points.length; i++) length += distance(points[i - 1], points[i]);
	return length;
}

/** Resamples a polyline at approximately uniform arc-length intervals, retaining both endpoints. */
export function resample(points: Pt[], spacing: number): Pt[] {
	if (points.length <= 1) return points.slice();
	const step = Math.max(0.001, spacing);
	const result: Pt[] = [{ ...points[0] }];
	let carry = 0;
	let last = { ...points[0] };
	for (let i = 1; i < points.length; i++) {
		const end = points[i];
		let segmentLength = distance(last, end);
		if (segmentLength <= 0) {
			last = { ...end };
			continue;
		}
		let start = last;
		let remaining = segmentLength;
		while (carry + remaining >= step) {
			const travel = step - carry;
			const t = travel / remaining;
			const point = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
			result.push(point);
			start = point;
			remaining -= travel;
			carry = 0;
			if (remaining <= 1e-12) break;
		}
		carry += remaining;
		last = { ...end };
	}
	const final = points[points.length - 1];
	if (distance(result[result.length - 1], final) > 1e-9) result.push({ ...final });
	return result;
}

interface Bounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}
function bounds(points: Pt[]): Bounds {
	let minX = Infinity,
		minY = Infinity,
		maxX = -Infinity,
		maxY = -Infinity;
	for (const p of points) {
		if (p.x < minX) minX = p.x;
		if (p.x > maxX) maxX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.y > maxY) maxY = p.y;
	}
	return { minX, minY, maxX, maxY };
}

interface AxisResult {
	reversals: number;
	turns: Pt[];
}
function reversalsOnAxis(points: Pt[], axis: Pt, extent: number): AxisResult {
	const hysteresis = Math.max(2, 0.25 * extent);
	const project = (p: Pt): number => p.x * axis.x + p.y * axis.y;
	let extremumValue = project(points[0]);
	let extremumIndex = 0;
	let direction = 0;
	let reversals = 0;
	const turns: Pt[] = [];

	for (let i = 1; i < points.length; i++) {
		const value = project(points[i]);
		if (direction === 0) {
			if (Math.abs(value - extremumValue) > 0.25) {
				direction = value > extremumValue ? 1 : -1;
				extremumValue = value;
				extremumIndex = i;
			}
			continue;
		}
		const advanced = direction > 0 ? value > extremumValue : value < extremumValue;
		if (advanced) {
			extremumValue = value;
			extremumIndex = i;
		} else if (Math.abs(value - extremumValue) > hysteresis) {
			reversals++;
			turns.push(points[extremumIndex]);
			direction = -direction;
			extremumValue = value;
			extremumIndex = i;
		}
	}
	return { reversals, turns };
}

export function analyzeScratch(points: Pt[], opts?: Partial<ScratchOptions>): ScratchAnalysis {
	const options = mergedOptions(opts);
	const zero: ScratchAnalysis = {
		isScratch: false,
		reversals: 0,
		lengthRatio: 0,
		turningPoints: [],
		radius: options.minRadius,
	};
	if (points.length < 8) return zero;
	const box = bounds(points);
	const width = box.maxX - box.minX;
	const height = box.maxY - box.minY;
	const diag = Math.hypot(width, height);
	const denom = Math.max(width, height);
	if (diag < 8 || denom <= 0) return zero;

	const sampled = resample(points, Math.max(1, diag / 200));
	let meanX = 0,
		meanY = 0;
	for (const p of sampled) {
		meanX += p.x;
		meanY += p.y;
	}
	meanX /= sampled.length;
	meanY /= sampled.length;
	let xx = 0,
		xy = 0,
		yy = 0;
	for (const p of sampled) {
		const x = p.x - meanX,
			y = p.y - meanY;
		xx += x * x;
		xy += x * y;
		yy += y * y;
	}
	// The dominant eigenvector of the 2x2 covariance matrix is the principal axis.
	const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
	const principal = { x: Math.cos(angle), y: Math.sin(angle) };
	const minor = { x: -principal.y, y: principal.x };
	const extent = (axis: Pt): number => {
		let low = Infinity,
			high = -Infinity;
		for (const p of sampled) {
			const value = p.x * axis.x + p.y * axis.y;
			low = Math.min(low, value);
			high = Math.max(high, value);
		}
		return high - low;
	};
	const alongPrincipal = reversalsOnAxis(sampled, principal, extent(principal));
	const alongMinor = reversalsOnAxis(sampled, minor, extent(minor));
	const winner = alongMinor.reversals > alongPrincipal.reversals ? alongMinor : alongPrincipal;
	const lengthRatio = pathLength(points) / denom;
	const turningPoints = points.length ? [points[0], ...winner.turns, points[points.length - 1]] : [];
	let meanTurnDistance = 0;
	for (let i = 1; i < turningPoints.length; i++) meanTurnDistance += distance(turningPoints[i - 1], turningPoints[i]);
	if (turningPoints.length > 1) meanTurnDistance /= turningPoints.length - 1;
	const radius = Math.max(options.minRadius, 0.15 * meanTurnDistance);
	return {
		isScratch: winner.reversals >= options.minReversals && lengthRatio >= options.minLengthRatio,
		reversals: winner.reversals,
		lengthRatio,
		turningPoints,
		radius,
	};
}

export function isScratchGesture(points: Pt[], opts?: Partial<ScratchOptions>): boolean {
	return analyzeScratch(points, opts).isScratch;
}

interface Triangle {
	a: Pt;
	b: Pt;
	c: Pt;
	box: Bounds;
}
interface Segment {
	a: Pt;
	b: Pt;
	box: Bounds;
}
type Grid<T> = Map<string, T[]>;
const cellKey = (x: number, y: number): string => `${x},${y}`;
function addToGrid<T>(grid: Grid<T>, item: T, box: Bounds, size: number): void {
	const x0 = Math.floor(box.minX / size),
		x1 = Math.floor(box.maxX / size);
	const y0 = Math.floor(box.minY / size),
		y1 = Math.floor(box.maxY / size);
	for (let x = x0; x <= x1; x++)
		for (let y = y0; y <= y1; y++) {
			const key = cellKey(x, y);
			const bucket = grid.get(key);
			if (bucket) bucket.push(item);
			else grid.set(key, [item]);
		}
}
function triangle(a: Pt, b: Pt, c: Pt): Triangle {
	return {
		a,
		b,
		c,
		box: {
			minX: Math.min(a.x, b.x, c.x),
			minY: Math.min(a.y, b.y, c.y),
			maxX: Math.max(a.x, b.x, c.x),
			maxY: Math.max(a.y, b.y, c.y),
		},
	};
}
function segment(a: Pt, b: Pt, radius: number): Segment {
	return {
		a,
		b,
		box: {
			minX: Math.min(a.x, b.x) - radius,
			minY: Math.min(a.y, b.y) - radius,
			maxX: Math.max(a.x, b.x) + radius,
			maxY: Math.max(a.y, b.y) + radius,
		},
	};
}
function pointInTriangle(p: Pt, tri: Triangle): boolean {
	if (p.x < tri.box.minX || p.x > tri.box.maxX || p.y < tri.box.minY || p.y > tri.box.maxY) return false;
	const cross = (a: Pt, b: Pt, q: Pt): number => (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
	const d1 = cross(tri.a, tri.b, p),
		d2 = cross(tri.b, tri.c, p),
		d3 = cross(tri.c, tri.a, p);
	return (d1 >= -1e-9 && d2 >= -1e-9 && d3 >= -1e-9) || (d1 <= 1e-9 && d2 <= 1e-9 && d3 <= 1e-9);
}
function withinSegment(p: Pt, seg: Segment, radius: number): boolean {
	if (p.x < seg.box.minX || p.x > seg.box.maxX || p.y < seg.box.minY || p.y > seg.box.maxY) return false;
	const dx = seg.b.x - seg.a.x,
		dy = seg.b.y - seg.a.y;
	const denom = dx * dx + dy * dy;
	const t = denom === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - seg.a.x) * dx + (p.y - seg.a.y) * dy) / denom));
	const qx = seg.a.x + t * dx,
		qy = seg.a.y + t * dy;
	return (p.x - qx) ** 2 + (p.y - qy) ** 2 <= radius * radius;
}
function intersects(a: Bounds, b: Bounds): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Returns strokes whose resampled length lies mostly in the triangles or dilated scratch path. */
export function findScratchedStrokes(scratch: Pt[], strokes: StrokeGeom[], opts?: Partial<ScratchOptions>): string[] {
	const options = mergedOptions(opts);
	const analysis = analyzeScratch(scratch, options);
	if (!analysis.isScratch || strokes.length === 0) return [];
	const scratchBox = bounds(scratch);
	const expanded = {
		minX: scratchBox.minX - analysis.radius,
		minY: scratchBox.minY - analysis.radius,
		maxX: scratchBox.maxX + analysis.radius,
		maxY: scratchBox.maxY + analysis.radius,
	};
	const gridSize = Math.max(4, analysis.radius);
	const triangles: Triangle[] = [];
	for (let i = 0; i + 2 < analysis.turningPoints.length; i++)
		triangles.push(
			triangle(analysis.turningPoints[i], analysis.turningPoints[i + 1], analysis.turningPoints[i + 2]),
		);
	const triangleGrid: Grid<Triangle> = new Map();
	for (const tri of triangles) addToGrid(triangleGrid, tri, tri.box, gridSize);
	const scratchSampled = resample(scratch, 1.5);
	const segments: Segment[] = [];
	for (let i = 1; i < scratchSampled.length; i++)
		segments.push(segment(scratchSampled[i - 1], scratchSampled[i], analysis.radius));
	if (scratchSampled.length === 1) segments.push(segment(scratchSampled[0], scratchSampled[0], analysis.radius));
	const segmentGrid: Grid<Segment> = new Map();
	for (const seg of segments) addToGrid(segmentGrid, seg, seg.box, gridSize);

	const ids: string[] = [];
	for (const stroke of strokes) {
		if (stroke.points.length === 0) continue;
		const strokeBox = bounds(stroke.points);
		if (!intersects(strokeBox, expanded)) continue;
		const sampledStroke = stroke.points.length === 1 ? stroke.points : resample(stroke.points, 1.5);
		let inside = 0;
		for (const p of sampledStroke) {
			const key = cellKey(Math.floor(p.x / gridSize), Math.floor(p.y / gridSize));
			const nearbyTriangles = triangleGrid.get(key) ?? [];
			let covered = false;
			for (const tri of nearbyTriangles)
				if (pointInTriangle(p, tri)) {
					covered = true;
					break;
				}
			if (!covered) {
				const nearbySegments = segmentGrid.get(key) ?? [];
				for (const seg of nearbySegments)
					if (withinSegment(p, seg, analysis.radius)) {
						covered = true;
						break;
					}
			}
			if (covered) inside++;
		}
		if (inside / sampledStroke.length >= options.coverage) ids.push(stroke.id);
	}
	return ids;
}
