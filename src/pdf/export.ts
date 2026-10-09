import { PDFDocument, rgb, degrees } from "pdf-lib";
import { getStroke } from "perfect-freehand";
import type { InkPoint, InkStroke } from "./model";
import { strokeOptions } from "../ink/penStyle";
import { itemBox } from "./model";

export interface PdfAssets {
	/** PNG of a text item as it is shown on screen (upright in the displayed page orientation). */
	renderText(item: InkStroke, page: number): Promise<Uint8Array>;
	readImage(src: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
}

export interface PageBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Convert pdf.js scale-1 viewport coordinates (top-left origin) into PDF user space. */
export function viewportToPdfPoint(x: number, y: number, box: PageBox, rotation: number): [number, number] {
	switch (((rotation % 360) + 360) % 360) {
		case 90:
			return [box.x + y, box.y + x];
		case 180:
			return [box.x + box.width - x, box.y + y];
		case 270:
			return [box.x + box.width - y, box.y + box.height - x];
		default:
			return [box.x + x, box.y + box.height - y];
	}
}

export function strokeToSvgPath(stroke: InkStroke): string {
	const outline = getStroke(
		stroke.points.map(([x, y, pressure]) => [x, y, pressure]),
		strokeOptions(stroke.tool, stroke.pen, stroke.width),
	);
	if (!outline.length) return "";
	return `M ${outline.map(([x, y]) => `${round(x)} ${round(y)}`).join(" L ")} Z`;
}

export async function createAnnotatedPdf(
	source: ArrayBuffer,
	pageStrokes: Map<number, InkStroke[]>,
	assets: PdfAssets,
): Promise<Uint8Array> {
	const pdf = await PDFDocument.load(source);
	for (const [index, strokes] of pageStrokes) {
		const page = pdf.getPage(index);
		const box = page.getCropBox();
		for (const stroke of strokes) {
			if (stroke.kind === "text" || stroke.kind === "image") {
				let image;
				if (stroke.kind === "text") image = await pdf.embedPng(await assets.renderText(stroke, index));
				else {
					const asset = await assets.readImage(stroke.src ?? "");
					if (!asset) continue;
					image =
						asset.mime === "image/jpeg" ? await pdf.embedJpg(asset.bytes) : await pdf.embedPng(asset.bytes);
				}
				page.drawImage(image, uprightPlacement(itemBox(stroke), box, page.getRotation().angle));
				continue;
			}
			const outline = getStroke(
				stroke.points.map(([x, y, pressure]) => [x, y, pressure]),
				strokeOptions(stroke.tool, stroke.pen, stroke.width),
			);
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

/**
 * Where to draw an image that is upright on screen. Items are boxes in unrotated page units (y down);
 * on a page with /Rotate the image is turned the opposite way, so the viewer shows it upright.
 */
export function uprightPlacement(
	item: PageBox,
	box: PageBox,
	rotation: number,
): { x: number; y: number; width: number; height: number; rotate: ReturnType<typeof degrees> } {
	const left = box.x + item.x,
		bottom = box.y + box.height - item.y - item.height,
		right = left + item.width,
		top = bottom + item.height;
	const angle = ((rotation % 360) + 360) % 360;
	const swapped = angle === 90 || angle === 270;
	const width = swapped ? item.height : item.width,
		height = swapped ? item.width : item.height;
	// pdf-lib rotates counterclockwise around (x, y); pick the corner that keeps the image in the box.
	const [x, y] =
		angle === 90 ? [right, bottom] : angle === 180 ? [right, top] : angle === 270 ? [left, top] : [left, bottom];
	return { x, y, width, height, rotate: degrees(angle) };
}

function hexRgb(hex: string): [number, number, number] {
	return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number];
}
function round(value: number): number {
	return Math.round(value * 100) / 100;
}

export type ExportPoint = InkPoint;
