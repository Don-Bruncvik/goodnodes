export type RecognizedShape = { kind: "line" | "ellipse" | "rectangle" | "triangle"; points: [number, number][] };

export type ToolbarShape = "line" | "arrow" | "rectangle" | "ellipse" | "diamond";

export function shapePoints(kind: ToolbarShape, a: [number, number], b: [number, number]): [number, number][] {
	const [x1, y1] = a,
		[x2, y2] = b;
	let points: [number, number][];
	if (kind === "line") points = [a, b];
	else if (kind === "arrow") {
		const angle = Math.atan2(y2 - y1, x2 - x1),
			length = Math.hypot(x2 - x1, y2 - y1);
		const head = Math.min(16, length * 0.3);
		const h1: [number, number] = [
			x2 - head * Math.cos(angle - (28 * Math.PI) / 180),
			y2 - head * Math.sin(angle - (28 * Math.PI) / 180),
		];
		const h2: [number, number] = [
			x2 - head * Math.cos(angle + (28 * Math.PI) / 180),
			y2 - head * Math.sin(angle + (28 * Math.PI) / 180),
		];
		points = [a, b, h1, b, h2];
	} else if (kind === "rectangle")
		points = [
			[x1, y1],
			[x2, y1],
			[x2, y2],
			[x1, y2],
			[x1, y1],
		];
	else if (kind === "diamond")
		points = [
			[(x1 + x2) / 2, y1],
			[x2, (y1 + y2) / 2],
			[(x1 + x2) / 2, y2],
			[x1, (y1 + y2) / 2],
			[(x1 + x2) / 2, y1],
		];
	else
		points = Array.from({ length: 65 }, (_, i) => [
			(x1 + x2) / 2 + ((x2 - x1) / 2) * Math.cos((i * Math.PI * 2) / 64),
			(y1 + y2) / 2 + ((y2 - y1) / 2) * Math.sin((i * Math.PI * 2) / 64),
		]);
	const dense: [number, number][] = [points[0]];
	for (let i = 1; i < points.length; i++) {
		const prev = points[i - 1],
			next = points[i],
			steps = Math.max(1, Math.ceil(Math.hypot(next[0] - prev[0], next[1] - prev[1]) / 4));
		for (let j = 1; j <= steps; j++) {
			const t = j / steps;
			dense.push([prev[0] + (next[0] - prev[0]) * t, prev[1] + (next[1] - prev[1]) * t]);
		}
	}
	return dense;
}

export function recognizeShape(input: [number, number][]): RecognizedShape | null {
	if (input.length < 5) return null;
	const points = input.filter(
		(_, i) => i === 0 || i === input.length - 1 || i % Math.max(1, Math.floor(input.length / 120)) === 0,
	);
	const [first, last] = [points[0], points[points.length - 1]];
	const diagonal = Math.hypot(max(points, 0) - min(points, 0), max(points, 1) - min(points, 1));
	if (diagonal < 4) return null;
	const lineLength = distance(first, last);
	if (lineLength > diagonal * 0.75 && maxSegmentDeviation(points, first, last) < lineLength * 0.08)
		return { kind: "line", points: [first, last] };
	if (distance(first, last) > diagonal * 0.2) return null;
	const compact = points.filter(
		(point, index) => index === 0 || distance(point, points[index - 1]) > diagonal * 0.025,
	);
	while (compact.length > 2 && distance(compact[0], compact[compact.length - 1]) < diagonal * 0.2) compact.pop();
	const simplified = rdp([...compact, compact[0]], diagonal * 0.04).slice(0, -1);
	if (simplified.length === 3) return { kind: "triangle", points: close(simplified) };
	if (simplified.length === 4) {
		const xs = simplified.map((p) => p[0]),
			ys = simplified.map((p) => p[1]);
		return {
			kind: "rectangle",
			points: close([
				[Math.min(...xs), Math.min(...ys)],
				[Math.max(...xs), Math.min(...ys)],
				[Math.max(...xs), Math.max(...ys)],
				[Math.min(...xs), Math.max(...ys)],
			]),
		};
	}
	if (simplified.length >= 5 && ellipseFit(points, diagonal)) {
		const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length;
		const cy = points.reduce((sum, p) => sum + p[1], 0) / points.length;
		const rx = (max(points, 0) - min(points, 0)) / 2,
			ry = (max(points, 1) - min(points, 1)) / 2;
		return {
			kind: "ellipse",
			points: Array.from({ length: 49 }, (_, i) => [
				cx + rx * Math.cos((i * Math.PI * 2) / 48),
				cy + ry * Math.sin((i * Math.PI * 2) / 48),
			]),
		};
	}
	return null;
}

function ellipseFit(points: [number, number][], diagonal: number): boolean {
	const cx = (max(points, 0) + min(points, 0)) / 2,
		cy = (max(points, 1) + min(points, 1)) / 2;
	const rx = (max(points, 0) - min(points, 0)) / 2,
		ry = (max(points, 1) - min(points, 1)) / 2;
	if (rx < 2 || ry < 2) return false;
	const error =
		points.reduce((sum, [x, y]) => sum + Math.abs(Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2) - 1), 0) /
		points.length;
	return error < Math.min(0.24, 10 / diagonal);
}
function rdp(points: [number, number][], tolerance: number): [number, number][] {
	if (points.length < 3) return points;
	let far = 0,
		index = 0;
	for (let i = 1; i < points.length - 1; i++) {
		const d = segmentDistance(points[i], points[0], points[points.length - 1]);
		if (d > far) {
			far = d;
			index = i;
		}
	}
	if (far <= tolerance) return [points[0], points[points.length - 1]];
	return [...rdp(points.slice(0, index + 1), tolerance).slice(0, -1), ...rdp(points.slice(index), tolerance)];
}
function maxSegmentDeviation(points: [number, number][], a: [number, number], b: [number, number]): number {
	return Math.max(...points.map((p) => segmentDistance(p, a, b)));
}
function segmentDistance(p: [number, number], a: [number, number], b: [number, number]): number {
	const dx = b[0] - a[0],
		dy = b[1] - a[1],
		t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
	return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
function distance(a: [number, number], b: [number, number]): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
function close(points: [number, number][]): [number, number][] {
	return [...points, points[0]];
}
function min(points: [number, number][], axis: number): number {
	return Math.min(...points.map((p) => p[axis]));
}
function max(points: [number, number][], axis: number): number {
	return Math.max(...points.map((p) => p[axis]));
}
