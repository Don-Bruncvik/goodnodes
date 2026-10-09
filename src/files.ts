import { App, TFolder, normalizePath } from "obsidian";

/**
 * Open the OS file picker (Files app / camera on iPad). Resolves with the picked
 * files, or [] when cancelled. `capture` asks iOS to open the camera directly.
 */
export function pickFiles(accept: string, options: { multiple?: boolean; capture?: boolean } = {}): Promise<File[]> {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = accept;
	input.multiple = options.multiple ?? true;
	if (options.capture) input.setAttribute("capture", "environment");
	input.style.display = "none";
	document.body.appendChild(input);
	return new Promise<File[]>((resolve) => {
		let settled = false;
		const finish = (files: File[]) => {
			if (settled) return;
			settled = true;
			input.remove();
			window.removeEventListener("focus", onFocus);
			resolve(files);
		};
		// Not every WebView fires "cancel"; when the window regains focus without a
		// "change" shortly after, the picker was dismissed.
		const onFocus = () => window.setTimeout(() => finish(Array.from(input.files ?? [])), 1000);
		input.addEventListener("change", () => finish(Array.from(input.files ?? [])), { once: true });
		input.addEventListener("cancel", () => finish([]), { once: true });
		window.addEventListener("focus", onFocus);
		input.click();
	});
}

/** File name safe on every OS/sync target; keeps letters with diacritics. */
export function safeFileName(name: string): string {
	const cleaned = name
		.replace(/[\\/:*?"<>|#^[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned || "Untitled";
}

/** `folder/base.ext`, or `folder/base 1.ext`, `base 2.ext`… if taken. */
export function availablePath(app: App, folder: TFolder, base: string, ext: string): string {
	const dir = folder.isRoot() ? "" : `${folder.path}/`;
	const stem = safeFileName(base);
	let path = normalizePath(`${dir}${stem}.${ext}`);
	for (let i = 1; app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir}${stem} ${i}.${ext}`);
	return path;
}

export async function ensureFolder(app: App, path: string): Promise<TFolder> {
	const normalized = normalizePath(path.trim());
	if (!normalized || normalized === "/") return app.vault.getRoot();
	const existing = app.vault.getAbstractFileByPath(normalized);
	if (existing instanceof TFolder) return existing;
	if (existing) throw new Error(`Not a folder: ${normalized}`);
	return app.vault.createFolder(normalized);
}

export function isImage(file: File): boolean {
	return file.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic|heif|bmp)$/i.test(file.name);
}

export function isPdf(file: File): boolean {
	return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}
