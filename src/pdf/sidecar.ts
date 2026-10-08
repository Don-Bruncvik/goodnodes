import type { InkStroke, PdfSidecar } from "./model";

export function parseSidecar(text: string, pageCount: number): PdfSidecar | null {
	try {
		const raw = JSON.parse(text) as Partial<PdfSidecar>;
		if (raw.type !== "goodnodes-pdf" || raw.version !== 1 || !raw.pdf || !raw.view || !raw.pages) return null;
		if (!Number.isFinite(raw.pdf.size) || !Number.isFinite(raw.pdf.pages)) return null;
		const pages: Record<string, InkStroke[]> = {};
		for (const [key, value] of Object.entries(raw.pages)) {
			const index = Number(key);
			if (!Number.isInteger(index) || index < 0 || index >= pageCount || !Array.isArray(value)) continue;
			const strokes = value.filter(isStroke).map((stroke) => ({
				id: stroke.id,
				tool: stroke.tool,
				color: stroke.color,
				width: stroke.width,
				points: stroke.points.map(
					(point) => [round(point[0]), round(point[1]), clampPressure(point[2])] as [number, number, number],
				),
			}));
			if (strokes.length) pages[key] = strokes;
		}
		return {
			type: "goodnodes-pdf",
			version: 1,
			pdf: { size: raw.pdf.size, pages: raw.pdf.pages },
			view: {
				page: clamp(Math.floor(raw.view.page ?? 0), 0, Math.max(0, pageCount - 1)),
				zoom: clamp(raw.view.zoom ?? 1, 0.5, 4),
				sidebar:
					raw.view.sidebar === "pages" || raw.view.sidebar === "outline" || raw.view.sidebar === "bookmarks"
						? raw.view.sidebar
						: null,
			},
			bookmarks: [
				...new Set(
					(Array.isArray(raw.bookmarks) ? raw.bookmarks : []).filter(
						(page) => Number.isInteger(page) && page >= 0 && page < pageCount,
					),
				),
			].sort((a, b) => a - b),
			pages,
		};
	} catch {
		return null;
	}
}

export function serializeSidecar(data: PdfSidecar): string {
	const pages: Record<string, InkStroke[]> = {};
	for (const [index, strokes] of Object.entries(data.pages)) {
		if (strokes.length)
			pages[index] = strokes.map((stroke) => ({
				...stroke,
				points: stroke.points.map(([x, y, pressure]) => [round(x), round(y), clampPressure(pressure)]),
			}));
	}
	const bookmarks = [...new Set(data.bookmarks.filter((page) => Number.isInteger(page) && page >= 0))].sort(
		(a, b) => a - b,
	);
	return JSON.stringify({ ...data, bookmarks, pages });
}

function isStroke(value: unknown): value is InkStroke {
	if (!value || typeof value !== "object") return false;
	const stroke = value as InkStroke;
	return (
		typeof stroke.id === "string" &&
		(stroke.tool === "pen" || stroke.tool === "highlighter") &&
		typeof stroke.color === "string" &&
		/^#[\da-f]{6}$/i.test(stroke.color) &&
		Number.isFinite(stroke.width) &&
		stroke.width > 0 &&
		Array.isArray(stroke.points) &&
		stroke.points.length > 0 &&
		stroke.points.every(
			(point) =>
				Array.isArray(point) &&
				point.length >= 3 &&
				Number.isFinite(point[0]) &&
				Number.isFinite(point[1]) &&
				Number.isFinite(point[2]),
		)
	);
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}
function clampPressure(value: number): number {
	return clamp(value, 0, 1);
}
function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
