const INVALID_NAME_CHARS = /[\\/:*?"<>|#^\[\]]/g;

export function sanitizePdfName(name: string): string {
	const cleaned = name.replace(INVALID_NAME_CHARS, "").trim().replace(/\s+/g, " ");
	const stem = cleaned.replace(/\.pdf$/i, "").trim();
	return `${stem || "Untitled"}.pdf`;
}

export function collisionSafePath(path: string, exists: (candidate: string) => boolean): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
	if (!exists(normalized)) return normalized;
	const slash = normalized.lastIndexOf("/");
	const parent = slash < 0 ? "" : normalized.slice(0, slash + 1);
	const filename = normalized.slice(slash + 1);
	const dot = filename.lastIndexOf(".");
	const stem = dot > 0 ? filename.slice(0, dot) : filename;
	const ext = dot > 0 ? filename.slice(dot) : "";
	for (let i = 1; ; i++) {
		const candidate = `${parent}${stem} ${i}${ext}`;
		if (!exists(candidate)) return candidate;
	}
}

export function formatRelativeDate(timestamp: number, now = Date.now()): string {
	const date = new Date(timestamp);
	const today = new Date(now);
	const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
	const fileDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	const days = Math.round((midnight - fileDay) / 86_400_000);
	if (days === 0)
		return `Today ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
	if (days === 1) return "Yesterday";
	return `${date.getDate()} ${date.toLocaleDateString([], { month: "short" })}`;
}

export type LibraryFilter = "all" | "notebooks" | "pdfs";
export type LibrarySort = "modified" | "name";
export interface LibraryFile {
	path: string;
	basename: string;
	extension: string;
	mtime: number;
}

export function filterAndSortFiles<T extends LibraryFile>(
	files: T[],
	query: string,
	filter: LibraryFilter,
	sort: LibrarySort,
): T[] {
	const needle = query.trim().toLocaleLowerCase();
	return files
		.filter((file) => file.extension === "goodnodes" || file.extension === "pdf")
		.filter(
			(file) =>
				filter === "all" ||
				(filter === "notebooks" ? file.extension === "goodnodes" : file.extension === "pdf"),
		)
		.filter(
			(file) =>
				!needle ||
				file.basename.toLocaleLowerCase().includes(needle) ||
				file.path.toLocaleLowerCase().includes(needle),
		)
		.sort((a, b) =>
			sort === "name"
				? a.basename.localeCompare(b.basename, undefined, { sensitivity: "base" })
				: b.mtime - a.mtime,
		);
}
