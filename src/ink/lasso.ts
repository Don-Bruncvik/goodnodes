import { newStrokeId, type InkStroke } from "../pdf/model";

export function pointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const a = polygon[i],
			b = polygon[j];
		if (
			a[1] > point[1] !== b[1] > point[1] &&
			point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
		)
			inside = !inside;
	}
	return inside;
}
export function strokesInLasso(polygon: [number, number][], strokes: InkStroke[], minFraction = 0.5): InkStroke[] {
	return strokes.filter(
		(stroke) =>
			stroke.points.filter(([x, y]) => pointInPolygon([x, y], polygon)).length / stroke.points.length >=
			minFraction,
	);
}
export function boundsOf(strokes: InkStroke[]): { x: number; y: number; width: number; height: number } | null {
	const points = strokes.flatMap((s) => s.points);
	if (!points.length) return null;
	const xs = points.map((p) => p[0]),
		ys = points.map((p) => p[1]);
	return {
		x: Math.min(...xs),
		y: Math.min(...ys),
		width: Math.max(...xs) - Math.min(...xs),
		height: Math.max(...ys) - Math.min(...ys),
	};
}
export function transformStrokes(
	strokes: InkStroke[],
	transform: { dx: number; dy: number; scale: number; originX: number; originY: number },
): InkStroke[] {
	const { dx, dy, scale, originX, originY } = transform;
	return strokes.map((stroke) => ({
		...stroke,
		id: newStrokeId(),
		width: stroke.width * scale,
		points: stroke.points.map(([x, y, p]) => [
			originX + (x - originX) * scale + dx,
			originY + (y - originY) * scale + dy,
			p,
		]),
	}));
}
