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
