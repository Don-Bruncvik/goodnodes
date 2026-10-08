import type { InkPoint, InkStroke } from "./model";

export function findEraserHits(path: InkPoint[], strokes: InkStroke[], radius = 8): string[] {
	if (!path.length) return [];
	const radiusSquared = radius * radius;
	return strokes.filter((stroke) => {
		for (const point of stroke.points) if (path.some((candidate, i) => i === 0
			? distanceSquared(point, candidate) <= radiusSquared
			: pointSegmentDistanceSquared(point, path[i - 1], candidate) <= radiusSquared)) return true;
		for (let strokeIndex = 1; strokeIndex < stroke.points.length; strokeIndex++) {
			for (let pathIndex = 1; pathIndex < path.length; pathIndex++) {
				if (segmentsWithinRadius(stroke.points[strokeIndex - 1], stroke.points[strokeIndex], path[pathIndex - 1], path[pathIndex], radiusSquared)) return true;
			}
		}
		return false;
	}).map((stroke) => stroke.id);
}

function distanceSquared(a: InkPoint, b: InkPoint): number { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2; }
function pointSegmentDistanceSquared(p: InkPoint, a: InkPoint, b: InkPoint): number {
	const dx = b[0] - a[0], dy = b[1] - a[1];
	const length = dx * dx + dy * dy;
	const t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
	return (p[0] - (a[0] + t * dx)) ** 2 + (p[1] - (a[1] + t * dy)) ** 2;
}

function segmentsWithinRadius(a: InkPoint, b: InkPoint, c: InkPoint, d: InkPoint, radiusSquared: number): boolean {
	if (segmentsIntersect(a, b, c, d)) return true;
	return Math.min(
		pointSegmentDistanceSquared(a, c, d), pointSegmentDistanceSquared(b, c, d),
		pointSegmentDistanceSquared(c, a, b), pointSegmentDistanceSquared(d, a, b),
	) <= radiusSquared;
}

function segmentsIntersect(a: InkPoint, b: InkPoint, c: InkPoint, d: InkPoint): boolean {
	const cross = (p: InkPoint, q: InkPoint, r: InkPoint) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
	const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
	return abC * abD <= 0 && cdA * cdB <= 0 &&
		Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <= Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) &&
		Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <= Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]));
}
