import { rgb, type PDFPage } from "pdf-lib";
import type { PaperTemplate } from "./index";

export type PaperShape =
	| { type: "line"; x1: number; y1: number; x2: number; y2: number; color: [number, number, number]; width: number }
	| { type: "dot"; x: number; y: number; radius: number; color: [number, number, number] };

const mm = 72 / 25.4;

/** Pure template geometry in PDF point coordinates, using a top-left origin. */
export function templateShapes(template: PaperTemplate, width: number, height: number): PaperShape[] {
	const shapes: PaperShape[] = [];
	if (template === "ruled" || template === "ruled-narrow") {
		const spacing = (template === "ruled" ? 8 : 6) * mm;
		for (let y = 25 * mm; y <= height; y += spacing)
			shapes.push({ type: "line", x1: 0, y1: y, x2: width, y2: y, color: [0.72, 0.8, 0.9], width: 0.5 });
		shapes.push({
			type: "line",
			x1: 25 * mm,
			y1: 0,
			x2: 25 * mm,
			y2: height,
			color: [0.91, 0.72, 0.72],
			width: 0.45,
		});
	} else if (template === "grid") {
		const spacing = 5 * mm;
		for (let x = 0; x <= width; x += spacing)
			shapes.push({ type: "line", x1: x, y1: 0, x2: x, y2: height, color: [0.85, 0.85, 0.85], width: 0.35 });
		for (let y = 0; y <= height; y += spacing)
			shapes.push({ type: "line", x1: 0, y1: y, x2: width, y2: y, color: [0.85, 0.85, 0.85], width: 0.35 });
	} else if (template === "dots") {
		const spacing = 5 * mm;
		for (let y = spacing / 2; y < height; y += spacing)
			for (let x = spacing / 2; x < width; x += spacing)
				shapes.push({ type: "dot", x, y, radius: 0.45, color: [0.7, 0.7, 0.7] });
	}
	return shapes;
}

/** Draw the shared pure template geometry onto a pdf-lib page. */
export function drawPaperTemplate(
	page: PDFPage,
	template: PaperTemplate,
	width = page.getWidth(),
	height = page.getHeight(),
): void {
	for (const shape of templateShapes(template, width, height)) {
		const color = rgb(shape.color[0], shape.color[1], shape.color[2]);
		if (shape.type === "line") {
			page.drawLine({
				start: { x: shape.x1, y: height - shape.y1 },
				end: { x: shape.x2, y: height - shape.y2 },
				color,
				thickness: shape.width,
			});
		} else {
			page.drawCircle({ x: shape.x, y: height - shape.y, size: shape.radius, color: color as any });
		}
	}
}
