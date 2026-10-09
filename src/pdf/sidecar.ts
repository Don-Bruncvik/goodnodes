import type { InkStroke, PdfSidecar } from "./model";
import type { NotebookMeta, Orientation, PaperSize, PaperTemplate } from "../notebook";

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
				...(stroke.pen ? { pen: stroke.pen } : {}),
				points: stroke.points.map(
					(point) => [round(point[0]), round(point[1]), clampPressure(point[2])] as [number, number, number],
				),
				...(stroke.kind ? { kind: stroke.kind } : {}),
				...(stroke.text !== undefined ? { text: stroke.text } : {}),
				...(stroke.font !== undefined ? { font: stroke.font } : {}),
				...(stroke.align ? { align: stroke.align } : {}),
				...(stroke.src ? { src: stroke.src } : {}),
			}));
			if (strokes.length) pages[key] = strokes;
		}
		const notebook = parseNotebook(raw.notebook);
		return {
			type: "goodnodes-pdf",
			version: 1,
			pdf: { size: raw.pdf.size, pages: raw.pdf.pages },
			view: {
				page: clamp(Math.floor(raw.view.page ?? 0), 0, Math.max(0, pageCount - 1)),
				zoom: clamp(raw.view.zoom ?? 1, 0.5, 4),
				sidebar:
					raw.view.sidebar === "pages" ||
					raw.view.sidebar === "outline" ||
					raw.view.sidebar === "bookmarks" ||
					raw.view.sidebar === "closed"
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
			...(notebook ? { notebook } : {}),
		};
	} catch {
		return null;
	}
}

function parseNotebook(value: unknown): NotebookMeta | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Partial<NotebookMeta>;
	if (
		!(["blank", "ruled", "ruled-narrow", "grid", "dots"] as PaperTemplate[]).includes(raw.template as PaperTemplate)
	)
		return undefined;
	if (!("a4" === raw.size || "letter" === raw.size)) return undefined;
	if (!("portrait" === raw.orientation || "landscape" === raw.orientation)) return undefined;
	if (raw.cover !== null && (typeof raw.cover !== "string" || !/^#[\da-f]{6}$/i.test(raw.cover))) return undefined;
	return {
		template: raw.template as PaperTemplate,
		size: raw.size as PaperSize,
		orientation: raw.orientation as Orientation,
		cover: raw.cover,
	};
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
	const valid =
		typeof stroke.id === "string" &&
		(stroke.tool === "pen" || stroke.tool === "highlighter") &&
		(stroke.pen === undefined || stroke.pen === "fountain" || stroke.pen === "ball" || stroke.pen === "brush") &&
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
		);
	if (!valid) return false;
	if (stroke.kind !== undefined && stroke.kind !== "text" && stroke.kind !== "image") return false;
	if (stroke.kind && stroke.points.length < 2) return false;
	if (stroke.kind && stroke.tool !== "pen") return false;
	if (stroke.kind === "text" && typeof stroke.text !== "string") return false;
	if (stroke.kind === "image" && (typeof stroke.src !== "string" || !stroke.src.trim())) return false;
	if (stroke.font !== undefined && !Number.isFinite(stroke.font)) return false;
	if (stroke.align !== undefined && !["left", "center", "right"].includes(stroke.align)) return false;
	return true;
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
