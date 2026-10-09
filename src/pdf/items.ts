import type { App, TAbstractFile, TFile } from "obsidian";
import { getStroke } from "perfect-freehand";
import { strokeOptions } from "../ink/penStyle";
import type { InkStroke } from "./model";
import { itemBox } from "./model";

export interface ImageCacheLike {
	get(src: string): HTMLImageElement | null;
}

export function fontFamily(font = 6): string {
	if (font === 5) return 'Excalifont, "Comic Sans MS", cursive';
	if (font === 8) return '"Comic Shanns", ui-monospace, Menlo, monospace';
	return 'Nunito, -apple-system, "Helvetica Neue", sans-serif';
}

/** Word-wrapped lines of a text item; `measure` is the rendered width of a string. */
export function layoutText(text: string, boxWidthPx: number, measure: (text: string) => number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		if (!paragraph) {
			lines.push("");
			continue;
		}
		let line = "";
		for (const word of paragraph.split(/\s+/)) {
			const candidate = line ? `${line} ${word}` : word;
			if (measure(candidate) <= boxWidthPx) {
				line = candidate;
				continue;
			}
			if (line) lines.push(line);
			line = "";
			for (const char of word) {
				if (line && measure(line + char) > boxWidthPx) {
					lines.push(line);
					line = char;
				} else line += char;
			}
		}
		lines.push(line);
	}
	return lines.length ? lines : [""];
}

function isVaultFile(file: TAbstractFile | null): file is TFile {
	return file !== null && "extension" in file && "basename" in file && "stat" in file;
}

export class ImageCache implements ImageCacheLike {
	private images = new Map<string, HTMLImageElement | null>();
	constructor(
		private app: App,
		private onLoad: (src: string) => void,
	) {}
	get(src: string): HTMLImageElement | null {
		if (this.images.has(src)) return this.images.get(src) ?? null;
		this.images.set(src, null);
		const file = this.app.vault.getAbstractFileByPath(src);
		if (!isVaultFile(file)) return null;
		const image = new Image();
		image.onload = () => {
			this.images.set(src, image);
			this.onLoad(src);
		};
		image.onerror = () => this.onLoad(src);
		image.src = this.app.vault.getResourcePath(file);
		return null;
	}
}

export function paintItem(
	ctx: CanvasRenderingContext2D,
	stroke: InkStroke,
	map: (x: number, y: number) => [number, number],
	scale: number,
	images: ImageCacheLike,
): void {
	if (stroke.kind === "text") {
		const a = map(stroke.points[0][0], stroke.points[0][1]);
		const b = map(stroke.points[1][0], stroke.points[1][1]);
		const x = Math.min(a[0], b[0]),
			y = Math.min(a[1], b[1]);
		const width = Math.abs(a[0] - b[0]),
			height = Math.abs(a[1] - b[1]);
		const size = stroke.width * scale,
			family = fontFamily(stroke.font);
		ctx.font = `${size}px ${family}`;
		ctx.fillStyle = stroke.color;
		ctx.textAlign = stroke.align ?? "left";
		ctx.textBaseline = "top";
		const lines = layoutText(stroke.text ?? "", width, (text) => ctx.measureText(text).width);
		const left = stroke.align === "center" ? x + width / 2 : stroke.align === "right" ? x + width : x;
		// Half of the 1.25 line height goes above the glyphs, like in the textarea editor.
		lines.forEach((line, i) => {
			if (i * size * 1.25 < height) ctx.fillText(line, left, y + (i * 1.25 + 0.125) * size);
		});
		return;
	}
	if (stroke.kind === "image") {
		const box = itemBox(stroke),
			a = map(box.x, box.y),
			b = map(box.x + box.width, box.y + box.height);
		const x = Math.min(a[0], b[0]),
			y = Math.min(a[1], b[1]),
			width = Math.abs(b[0] - a[0]),
			height = Math.abs(b[1] - a[1]);
		const image = images.get(stroke.src ?? "");
		if (image) ctx.drawImage(image, x, y, width, height);
		else {
			ctx.fillStyle = "#e5e7eb";
			ctx.fillRect(x, y, width, height);
			ctx.strokeStyle = "#c5c8ce";
			ctx.strokeRect(x, y, width, height);
		}
		return;
	}
	const points = stroke.points.map(([x, y, pressure]) => [...map(x, y), pressure]);
	const outline = getStroke(points, strokeOptions(stroke.tool, stroke.pen, stroke.width * scale));
	if (!outline.length) return;
	ctx.beginPath();
	ctx.moveTo(outline[0][0], outline[0][1]);
	for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]);
	ctx.closePath();
	if (stroke.tool === "highlighter") {
		ctx.globalCompositeOperation = "multiply";
		ctx.globalAlpha = 0.35;
	}
	ctx.fillStyle = stroke.color;
	ctx.fill();
	if (stroke.tool === "highlighter") {
		ctx.globalCompositeOperation = "source-over";
		ctx.globalAlpha = 1;
	}
}
