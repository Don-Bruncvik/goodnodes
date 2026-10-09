import { App, TFile, normalizePath } from "obsidian";
import type { BinaryFileData, BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";
import { debug } from "../debug";

// Images pasted into a canvas live as normal files in the vault (synced like
// everything else) instead of base64 inside the .goodnodes JSON. The JSON keeps
// only { id, mimeType, created, path } per image.

export interface StoredFile {
	id: string;
	mimeType: string;
	created: number;
	/** Vault path of the image; absent while it is still embedded as dataURL. */
	path?: string;
	dataURL?: string;
}

const EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/svg+xml": "svg",
	"image/avif": "avif",
	"image/bmp": "bmp",
};

export class CanvasImages {
	/** Excalidraw file id → vault path. */
	private paths = new Map<string, string>();
	private writing = new Set<string>();

	constructor(
		private app: App,
		private imageFolder: () => string,
	) {}

	reset(stored: Record<string, StoredFile> | undefined): void {
		this.paths.clear();
		for (const f of Object.values(stored ?? {})) if (f.path) this.paths.set(f.id, f.path);
	}

	/** Load vault-backed images of a file as Excalidraw BinaryFileData. */
	async load(stored: Record<string, StoredFile> | undefined): Promise<BinaryFileData[]> {
		const out: BinaryFileData[] = [];
		for (const f of Object.values(stored ?? {})) {
			if (!f.path) continue;
			const file = this.app.vault.getAbstractFileByPath(f.path);
			if (!(file instanceof TFile)) {
				debug.log(`image missing in vault: ${f.path}`, "warn");
				continue;
			}
			try {
				const buf = await this.app.vault.readBinary(file);
				out.push({
					id: f.id as FileId,
					mimeType: f.mimeType as BinaryFileData["mimeType"],
					created: f.created,
					dataURL: toDataURL(buf, f.mimeType),
				});
			} catch (e) {
				debug.error(`cannot read image ${f.path}`, e);
			}
		}
		return out;
	}

	/**
	 * Write images that exist only in memory to the vault. Resolves to true if any
	 * new file was written (the canvas should be saved again to drop the dataURL).
	 */
	async persistNew(files: BinaryFiles, canvasFile: TFile): Promise<boolean> {
		let wrote = false;
		for (const f of Object.values(files)) {
			if (this.paths.has(f.id) || this.writing.has(f.id)) continue;
			this.writing.add(f.id);
			try {
				const ext = EXT[f.mimeType] ?? "png";
				const name = `${canvasFile.basename} ${f.id.slice(0, 8)}.${ext}`;
				const path = await this.targetPath(name, canvasFile);
				await this.app.vault.createBinary(path, fromDataURL(f.dataURL));
				this.paths.set(f.id, path);
				wrote = true;
				debug.log(`image stored: ${path}`);
			} catch (e) {
				debug.error("cannot store image", e);
			} finally {
				this.writing.delete(f.id);
			}
		}
		return wrote;
	}

	/** Replace dataURLs by vault paths where the image is already stored. */
	toStored(
		sceneFiles: Record<string, { id: string; mimeType: string; created: number; dataURL: string }>,
	): Record<string, StoredFile> {
		const out: Record<string, StoredFile> = {};
		for (const [id, f] of Object.entries(sceneFiles ?? {})) {
			const path = this.paths.get(id);
			out[id] = path
				? { id, mimeType: f.mimeType, created: f.created, path }
				: { id, mimeType: f.mimeType, created: f.created, dataURL: f.dataURL };
		}
		return out;
	}

	private async targetPath(name: string, canvasFile: TFile): Promise<string> {
		const folder = this.imageFolder();
		if (!folder) return this.app.fileManager.getAvailablePathForAttachment(name, canvasFile.path);
		const dir = normalizePath(folder);
		if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
		let path = normalizePath(`${dir}/${name}`);
		const dot = name.lastIndexOf(".");
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) {
			path = normalizePath(`${dir}/${name.slice(0, dot)} ${i}${name.slice(dot)}`);
		}
		return path;
	}
}

function toDataURL(buf: ArrayBuffer, mimeType: string): DataURL {
	const bytes = new Uint8Array(buf);
	let bin = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return `data:${mimeType};base64,${btoa(bin)}` as DataURL;
}

function fromDataURL(dataURL: string): ArrayBuffer {
	const comma = dataURL.indexOf(",");
	const meta = dataURL.slice(0, comma);
	const body = dataURL.slice(comma + 1);
	if (!meta.endsWith(";base64")) return new TextEncoder().encode(decodeURIComponent(body)).buffer;
	const bin = atob(body);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes.buffer;
}
