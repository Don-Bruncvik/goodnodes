import { PDFDocument, rgb } from "pdf-lib";
import { getStroke } from "perfect-freehand";
import type { InkPoint, InkStroke } from "./model";

export interface PageBox { x: number; y: number; width: number; height: number }

/** Convert pdf.js scale-1 viewport coordinates (top-left origin) into PDF user space. */
export function viewportToPdfPoint(x: number, y: number, box: PageBox, rotation: number): [number, number] {
	switch (((rotation % 360) + 360) % 360) {
		case 90: return [box.x + y, box.y + x];
		case 180: return [box.x + box.width - x, box.y + y];
		case 270: return [box.x + box.width - y, box.y + box.height - x];
		default: return [box.x + x, box.y + box.height - y];
	}
}

export function strokeToSvgPath(stroke: InkStroke): string {
	const outline = getStroke(stroke.points.map(([x, y, pressure]) => [x, y, pressure]), {
		size: stroke.width * (stroke.tool === "highlighter" ? 5 : 1),
		thinning: stroke.tool === "highlighter" ? 0 : 0.6,
		 smoothing: 0.5,
		streamline: 0.35,
	});
	if (!outline.length) return "";
	return `M ${outline.map(([x, y]) => `${round(x)} ${round(y)}`).join(" L ")} Z`;
}

export async function createAnnotatedPdf(source: ArrayBuffer, pageStrokes: Map<number, InkStroke[]>): Promise<Uint8Array> {
	const pdf = await PDFDocument.load(source);
	for (const [index, strokes] of pageStrokes) {
		const page = pdf.getPage(index);
		const box = page.getCropBox();
		for (const stroke of strokes) {
			const outline = getStroke(stroke.points.map(([x, y, pressure]) => [x, y, pressure]), {
				size: stroke.width * (stroke.tool === "highlighter" ? 5 : 1),
				thinning: stroke.tool === "highlighter" ? 0 : 0.6,
				smoothing: 0.5,
				streamline: 0.35,
			});
			if (!outline.length) continue;
			// SVG coordinates in pdf-lib are y-down, so map back through the page's rotation.
			const mapped = outline.map(([x, y]) => viewportToPdfPoint(x, y, box, 0));
			const path = `M ${mapped.map(([x, y]) => `${round(x - box.x)} ${round(box.y + box.height - y)}`).join(" L ")} Z`;
			const color = hexRgb(stroke.color);
			page.drawSvgPath(path, {
				x: box.x,
				y: box.y + box.height,
				color: rgb(color[0], color[1], color[2]),
				opacity: stroke.tool === "highlighter" ? 0.35 : 1,
				borderWidth: 0,
			});
		}
	}
	return pdf.save();
}

function hexRgb(hex: string): [number, number, number] {
	return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number];
}
function round(value: number): number { return Math.round(value * 100) / 100; }

export type ExportPoint = InkPoint;
