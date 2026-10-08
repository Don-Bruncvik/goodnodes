import type { InkStroke, PdfHistoryEntry } from "./model";

/** Stores inverse operations so scratch removal remains one atomic undo step. */
export class PdfHistory {
	private undoStack: PdfHistoryEntry[] = [];
	private redoStack: PdfHistoryEntry[] = [];

	push(entry: PdfHistoryEntry): void {
		if (!entry.added.length && !entry.removed.length) return;
		this.undoStack.push(cloneEntry(entry));
		this.redoStack = [];
	}

	undo(pages: Map<number, InkStroke[]>): PdfHistoryEntry | null {
		const entry = this.undoStack.pop();
		if (!entry) return null;
		apply(pages, entry.page, entry.added, entry.removed);
		this.redoStack.push(entry);
		return entry;
	}

	redo(pages: Map<number, InkStroke[]>): PdfHistoryEntry | null {
		const entry = this.redoStack.pop();
		if (!entry) return null;
		apply(pages, entry.page, entry.removed, entry.added);
		this.undoStack.push(entry);
		return entry;
	}

	clear(): void {
		this.undoStack = [];
		this.redoStack = [];
	}
	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}
	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}
}

function apply(pages: Map<number, InkStroke[]>, page: number, remove: InkStroke[], add: InkStroke[]): void {
	const current = pages.get(page) ?? [];
	const removedIds = new Set(remove.map((stroke) => stroke.id));
	const next = current.filter((stroke) => !removedIds.has(stroke.id));
	const existing = new Set(next.map((stroke) => stroke.id));
	for (const stroke of add) if (!existing.has(stroke.id)) next.push(stroke);
	if (next.length) pages.set(page, next);
	else pages.delete(page);
}

function cloneEntry(entry: PdfHistoryEntry): PdfHistoryEntry {
	return { page: entry.page, added: entry.added.slice(), removed: entry.removed.slice() };
}
