import { newStrokeId, type InkPoint, type InkStroke } from "./model";

export function findEraserHits(path: InkPoint[], strokes: InkStroke[], radius = 8): string[] {
	if (!path.length) return [];
	const radiusSquared = radius * radius;
	return strokes
		.filter((stroke) => {
			for (const point of stroke.points)
				if (
					path.some((candidate, i) =>
						i === 0
							? distanceSquared(point, candidate) <= radiusSquared
							: pointSegmentDistanceSquared(point, path[i - 1], candidate) <= radiusSquared,
					)
				)
					return true;
			for (let strokeIndex = 1; strokeIndex < stroke.points.length; strokeIndex++) {
				for (let pathIndex = 1; pathIndex < path.length; pathIndex++) {
					if (
						segmentsWithinRadius(
							stroke.points[strokeIndex - 1],
							stroke.points[strokeIndex],
							path[pathIndex - 1],
							path[pathIndex],
							radiusSquared,
						)
					)
						return true;
				}
			}
			return false;
		})
		.map((stroke) => stroke.id);
}

/** Split each hit stroke at eraser crossings, keeping untouched runs as independent strokes. */
export function splitStrokesByEraser(
	path: InkPoint[],
	strokes: InkStroke[],
	radius: number,
): { removed: InkStroke[]; added: InkStroke[] } {
	if (!path.length) return { removed: [], added: [] };
	const removed: InkStroke[] = [],
		added: InkStroke[] = [];
	for (const stroke of strokes) {
		const samples: InkPoint[] = [];
		for (let i = 0; i < stroke.points.length; i++) {
			const a = stroke.points[i - 1],
				b = stroke.points[i];
			if (i === 0) samples.push(b);
			else {
				const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(1, radius * 0.4)));
				for (let j = 1; j <= steps; j++) {
					const t = j / steps;
					samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
				}
			}
		}
		const kept: InkPoint[][] = [];
		let run: InkPoint[] = [];
		for (const point of samples) {
			if (nearPath(point, path, radius)) {
				if (run.length >= 2) kept.push(run);
				run = [];
			} else {
				if (run.length && distanceSquared(run[run.length - 1], point) > radius * radius * 9) {
					if (run.length >= 2) kept.push(run);
					run = [];
				}
				run.push(point);
			}
		}
		if (run.length >= 2) kept.push(run);
		// Strokes the eraser didn't touch stay exactly as they are (no new id, no undo noise).
		if (samples.some((point) => nearPath(point, path, radius))) {
			removed.push(stroke);
			for (const points of kept) added.push({ ...stroke, id: newStrokeId(), points });
		}
	}
	return { removed, added };
}

function nearPath(point: InkPoint, path: InkPoint[], radius: number): boolean {
	const r2 = radius * radius;
	return path.some((candidate, i) =>
		i === 0
			? distanceSquared(point, candidate) <= r2
			: pointSegmentDistanceSquared(point, path[i - 1], candidate) <= r2,
	);
}

function distanceSquared(a: InkPoint, b: InkPoint): number {
	return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}
function pointSegmentDistanceSquared(p: InkPoint, a: InkPoint, b: InkPoint): number {
	const dx = b[0] - a[0],
		dy = b[1] - a[1];
	const length = dx * dx + dy * dy;
	const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
	return (p[0] - (a[0] + t * dx)) ** 2 + (p[1] - (a[1] + t * dy)) ** 2;
}

function segmentsWithinRadius(a: InkPoint, b: InkPoint, c: InkPoint, d: InkPoint, radiusSquared: number): boolean {
	if (segmentsIntersect(a, b, c, d)) return true;
	return (
		Math.min(
			pointSegmentDistanceSquared(a, c, d),
			pointSegmentDistanceSquared(b, c, d),
			pointSegmentDistanceSquared(c, a, b),
			pointSegmentDistanceSquared(d, a, b),
		) <= radiusSquared
	);
}

function segmentsIntersect(a: InkPoint, b: InkPoint, c: InkPoint, d: InkPoint): boolean {
	const cross = (p: InkPoint, q: InkPoint, r: InkPoint) =>
		(q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
	const abC = cross(a, b, c),
		abD = cross(a, b, d),
		cdA = cross(c, d, a),
		cdB = cross(c, d, b);
	return (
		abC * abD <= 0 &&
		cdA * cdB <= 0 &&
		Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) &&
		Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]))
	);
}
