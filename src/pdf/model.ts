export type InkPoint = [number, number, number];
export type InkTool = "pen" | "highlighter";

export interface InkStroke {
	id: string;
	tool: InkTool;
	color: string;
	width: number;
	points: InkPoint[];
}

export interface PdfSidecar {
	type: "goodnodes-pdf";
	version: 1;
	pdf: { size: number; pages: number };
	view: { page: number; zoom: number; sidebar?: "pages" | "outline" | "bookmarks" | null };
	bookmarks: number[];
	pages: Record<string, InkStroke[]>;
}

export interface PdfHistoryEntry {
	page: number;
	added: InkStroke[];
	removed: InkStroke[];
}

export function newStrokeId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
