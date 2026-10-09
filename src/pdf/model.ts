export type InkPoint = [number, number, number];
export type InkTool = "pen" | "highlighter";
import type { PenType } from "../ink/penStyle";

export interface InkStroke {
	id: string;
	tool: InkTool;
	color: string;
	width: number;
	pen?: PenType;
	points: InkPoint[];
	kind?: "text" | "image";
	text?: string;
	font?: number;
	align?: "left" | "center" | "right";
	src?: string;
}

export function isBoxItem(stroke: InkStroke): boolean {
	return stroke.kind === "text" || stroke.kind === "image";
}

export function itemBox(stroke: InkStroke): { x: number; y: number; width: number; height: number } {
	const a = stroke.points[0] ?? [0, 0, 0],
		b = stroke.points[1] ?? a;
	return {
		x: Math.min(a[0], b[0]),
		y: Math.min(a[1], b[1]),
		width: Math.abs(a[0] - b[0]),
		height: Math.abs(a[1] - b[1]),
	};
}

export interface PdfSidecar {
	type: "goodnodes-pdf";
	version: 1;
	pdf: { size: number; pages: number };
	view: { page: number; zoom: number; sidebar?: "pages" | "outline" | "bookmarks" | "closed" | null };
	bookmarks: number[];
	pages: Record<string, InkStroke[]>;
	notebook?: import("../notebook").NotebookMeta;
}

export interface PdfHistoryEntry {
	page: number;
	added: InkStroke[];
	removed: InkStroke[];
}

export function newStrokeId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
