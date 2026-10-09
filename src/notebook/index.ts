import { PDFDocument, rgb } from "pdf-lib";
import { App, Modal, TFile, TFolder } from "obsidian";
import { availablePath } from "../files";
import type GoodNodesPlugin from "../main";
import { drawPaperTemplate, templateShapes } from "./paper";
import "./notebook.css";

export type PaperTemplate = "blank" | "ruled" | "ruled-narrow" | "grid" | "dots";
export type PaperSize = "a4" | "letter";
export type Orientation = "portrait" | "landscape";

export interface NotebookOptions {
	title: string;
	template: PaperTemplate;
	size: PaperSize;
	orientation: Orientation;
	cover: string | null;
	pages: number;
}

export interface NotebookMeta {
	template: PaperTemplate;
	size: PaperSize;
	orientation: Orientation;
	cover: string | null;
}

export const DEFAULT_NOTEBOOK: NotebookOptions = {
	title: "Untitled notebook",
	template: "ruled",
	size: "a4",
	orientation: "portrait",
	cover: "#2f6fdd",
	pages: 1,
};

const TEMPLATES: PaperTemplate[] = ["blank", "ruled", "ruled-narrow", "grid", "dots"];
const COVERS = ["#2f6fdd", "#1f9d55", "#e03131", "#f08c00", "#9c36b5", "#343a40", "#c2a679", "#0c8599"];
const PAGE_DIMS: Record<PaperSize, [number, number]> = { a4: [595.28, 841.89], letter: [612, 792] };

export function askNotebookOptions(app: App, initial?: Partial<NotebookOptions>): Promise<NotebookOptions | null> {
	return new NotebookOptionsModal(app, { ...DEFAULT_NOTEBOOK, ...initial }).openAndWait();
}

export async function createNotebook(
	plugin: GoodNodesPlugin,
	folder: TFolder,
	options: NotebookOptions,
): Promise<TFile> {
	const pdf = await PDFDocument.create();
	const [baseWidth, baseHeight] = PAGE_DIMS[options.size];
	const landscape = options.orientation === "landscape";
	const width = landscape ? baseHeight : baseWidth;
	const height = landscape ? baseWidth : baseHeight;
	if (options.cover) {
		const page = pdf.addPage([width, height]);
		const cover = parseHex(options.cover);
		page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(...cover) });
		const darken = cover.map((value) => value * 0.78) as [number, number, number];
		page.drawRectangle({ x: 0, y: 0, width: width * 0.06, height, color: rgb(...darken) });
		const labelX = width * 0.15,
			labelY = height * 0.55,
			labelW = width * 0.7,
			labelH = height * 0.23,
			radius = 14;
		const white = rgb(1, 1, 1);
		page.drawRectangle({ x: labelX + radius, y: labelY, width: labelW - radius * 2, height: labelH, color: white });
		page.drawRectangle({ x: labelX, y: labelY + radius, width: labelW, height: labelH - radius * 2, color: white });
		for (const x of [labelX + radius, labelX + labelW - radius])
			for (const y of [labelY + radius, labelY + labelH - radius])
				page.drawCircle({ x, y, size: radius, color: white });
	}
	for (let index = 0; index < Math.max(1, Math.min(50, Math.floor(options.pages))); index++) {
		const page = pdf.addPage([width, height]);
		drawPaperTemplate(page, options.template);
	}
	const path = availablePath(plugin.app, folder, options.title, "pdf");
	const saved = await plugin.app.vault.createBinary(path, toArrayBuffer(await pdf.save()));
	const sidecar = {
		type: "goodnodes-pdf",
		version: 1,
		pdf: { size: saved.stat.size, pages: pdf.getPageCount() },
		view: { page: 0, zoom: 1, sidebar: null },
		bookmarks: [],
		pages: {},
		notebook: {
			template: options.template,
			size: options.size,
			orientation: options.orientation,
			cover: options.cover,
		},
	};
	await plugin.app.vault.adapter.write(`${saved.path}.goodnodes.json`, JSON.stringify(sidecar));
	return saved;
}

export async function createNotebookFromImages(
	plugin: GoodNodesPlugin,
	folder: TFolder,
	images: File[],
	title: string,
): Promise<TFile> {
	if (!images.length) throw new Error("Pick at least one image");
	const pdf = await PDFDocument.create();
	for (const file of images) {
		const encoded = await imageToJpeg(file);
		const image = await pdf.embedJpg(encoded.bytes);
		const landscape = encoded.width >= encoded.height;
		const pageWidth = landscape ? PAGE_DIMS.a4[1] : PAGE_DIMS.a4[0];
		const pageHeight = landscape ? PAGE_DIMS.a4[0] : PAGE_DIMS.a4[1];
		const page = pdf.addPage([pageWidth, pageHeight]);
		const scale = Math.min(pageWidth / image.width, pageHeight / image.height);
		const width = image.width * scale;
		const height = image.height * scale;
		page.drawImage(image, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width, height });
	}
	const saved = await plugin.app.vault.createBinary(
		availablePath(plugin.app, folder, title, "pdf"),
		toArrayBuffer(await pdf.save()),
	);
	await plugin.app.vault.adapter.write(
		`${saved.path}.goodnodes.json`,
		JSON.stringify({
			type: "goodnodes-pdf",
			version: 1,
			pdf: { size: saved.stat.size, pages: pdf.getPageCount() },
			view: { page: 0, zoom: 1, sidebar: null },
			bookmarks: [],
			pages: {},
			notebook: { template: "blank", size: "a4", orientation: "portrait", cover: null },
		}),
	);
	return saved;
}

class NotebookOptionsModal extends Modal {
	private options: NotebookOptions;
	private resolve!: (value: NotebookOptions | null) => void;
	private done = false;
	private titleInput!: HTMLInputElement;
	private preview!: HTMLElement;
	constructor(app: App, options: NotebookOptions) {
		super(app);
		this.options = options;
	}
	openAndWait(): Promise<NotebookOptions | null> {
		const result = new Promise<NotebookOptions | null>((resolve) => (this.resolve = resolve));
		this.open();
		return result;
	}
	onOpen(): void {
		this.modalEl.addClass("goodnodes-notebook-modal");
		this.titleEl.setText("Create Notebook");
		const content = this.contentEl;
		content.createEl("label", { text: "Title" });
		this.titleInput = content.createEl("input", {
			cls: "goodnodes-notebook-title",
			attr: { type: "text", value: this.options.title },
		});
		this.titleInput.focus();
		this.titleInput.select();
		this.titleInput.onkeydown = (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				this.submit();
			}
		};
		content.createEl("div", { cls: "goodnodes-notebook-section-title", text: "Cover" });
		const coverRow = content.createDiv({ cls: "goodnodes-notebook-swatches" });
		for (const cover of [null, ...COVERS]) {
			const button = coverRow.createEl("button", {
				cls: "goodnodes-notebook-swatch",
				attr: { title: cover ?? "No cover", "aria-label": cover ?? "No cover" },
			});
			if (cover) button.style.setProperty("--cover-color", cover);
			else button.addClass("is-none");
			button.toggleClass("is-selected", cover === this.options.cover);
			button.onclick = () => {
				this.options.cover = cover;
				coverRow.querySelectorAll("button").forEach((el) => el.toggleClass("is-selected", el === button));
			};
		}
		content.createEl("div", { cls: "goodnodes-notebook-section-title", text: "Paper" });
		const tiles = content.createDiv({ cls: "goodnodes-notebook-templates" });
		this.preview = content.createDiv({ cls: "goodnodes-notebook-preview" });
		for (const template of TEMPLATES) {
			const tile = tiles.createEl("button", {
				cls: "goodnodes-notebook-template",
				attr: { "aria-label": template },
			});
			tile.innerHTML = previewSvg(template);
			tile.createSpan({ text: templateLabel(template) });
			tile.toggleClass("is-selected", template === this.options.template);
			tile.onclick = () => {
				this.options.template = template;
				tiles.querySelectorAll("button").forEach((el) => el.toggleClass("is-selected", el === tile));
				this.preview.innerHTML = previewSvg(template);
			};
		}
		this.preview.innerHTML = previewSvg(this.options.template);
		this.choiceRow(content, "Paper size", "size", ["a4", "letter"]);
		this.choiceRow(content, "Orientation", "orientation", ["portrait", "landscape"]);
		const pagesRow = content.createDiv({ cls: "goodnodes-notebook-pages-row" });
		pagesRow.createSpan({ text: "Pages" });
		const minus = pagesRow.createEl("button", { text: "−", attr: { "aria-label": "Fewer pages" } });
		const count = pagesRow.createSpan({ cls: "goodnodes-notebook-pages-count", text: String(this.options.pages) });
		const plus = pagesRow.createEl("button", { text: "+", attr: { "aria-label": "More pages" } });
		minus.onclick = () => {
			this.options.pages = Math.max(1, this.options.pages - 1);
			count.setText(String(this.options.pages));
		};
		plus.onclick = () => {
			this.options.pages = Math.min(50, this.options.pages + 1);
			count.setText(String(this.options.pages));
		};
		const actions = content.createDiv({ cls: "goodnodes-notebook-actions" });
		actions.createEl("button", { text: "Cancel" }).onclick = () => this.finish(null);
		actions.createEl("button", { text: "Create", cls: "mod-cta" }).onclick = () => this.submit();
	}
	private choiceRow<K extends "size" | "orientation">(
		root: HTMLElement,
		label: string,
		key: K,
		values: NotebookOptions[K][],
	): void {
		const row = root.createDiv({ cls: "goodnodes-notebook-choice-row" });
		row.createSpan({ text: label });
		const controls = row.createDiv({ cls: "goodnodes-notebook-segments" });
		for (const value of values) {
			const button = controls.createEl("button", { text: value[0].toUpperCase() + value.slice(1) });
			button.toggleClass("is-selected", this.options[key] === value);
			button.onclick = () => {
				this.options[key] = value;
				controls.querySelectorAll("button").forEach((el) => el.toggleClass("is-selected", el === button));
			};
		}
	}
	private submit(): void {
		this.options.title = this.titleInput.value.trim() || "Untitled notebook";
		this.finish({ ...this.options });
	}
	private finish(value: NotebookOptions | null): void {
		if (this.done) return;
		this.done = true;
		this.resolve(value);
		this.close();
	}
	onClose(): void {
		this.finish(null);
		this.contentEl.empty();
	}
}

function templateLabel(template: PaperTemplate): string {
	return template === "ruled-narrow" ? "Narrow ruled" : template[0].toUpperCase() + template.slice(1);
}
function previewSvg(template: PaperTemplate): string {
	// Half-A4 geometry (points) scaled into a 100×140 viewBox: spacing looks 2× wider,
	// otherwise grid and dots blur into grey at thumbnail size.
	const W = 595.28 / 2;
	const H = 841.89 / 2;
	const sx = 100 / W;
	const sy = 140 / H;
	const marks = templateShapes(template, W, H)
		.map((s) =>
			s.type === "line"
				? `<line x1="${s.x1 * sx}" y1="${s.y1 * sy}" x2="${s.x2 * sx}" y2="${s.y2 * sy}" stroke="rgb(${s.color.map((c) => Math.round(c * 210)).join(",")})" stroke-width="0.9"/>`
				: `<circle cx="${s.x * sx}" cy="${s.y * sy}" r="0.75" fill="#999"/>`,
		)
		.join("");
	return `<svg viewBox="0 0 100 140" aria-hidden="true"><rect width="100" height="140" fill="white"/>${marks}</svg>`;
}
function parseHex(hex: string): [number, number, number] {
	const value = hex.replace("#", "");
	return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [number, number, number];
}
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.length);
	copy.set(bytes);
	return copy.buffer;
}

async function imageToJpeg(file: File): Promise<{ bytes: Uint8Array; width: number; height: number }> {
	let bitmap: ImageBitmap | null = null;
	let image: HTMLImageElement | null = null;
	let objectUrl: string | null = null;
	try {
		try {
			bitmap = await createImageBitmap(file);
		} catch {
			/* iOS HEIC may need the browser decoder. */
		}
		if (!bitmap) {
			objectUrl = URL.createObjectURL(file);
			image = new Image();
			image.src = objectUrl;
			await new Promise<void>((resolve, reject) => {
				image!.onload = () => resolve();
				image!.onerror = () => reject(new Error(`Could not decode ${file.name}`));
			});
		}
		const sourceWidth = bitmap?.width ?? image!.naturalWidth;
		const sourceHeight = bitmap?.height ?? image!.naturalHeight;
		const scale = Math.min(1, 2480 / Math.max(sourceWidth, sourceHeight));
		const canvas = document.createElement("canvas");
		canvas.width = Math.max(1, Math.round(sourceWidth * scale));
		canvas.height = Math.max(1, Math.round(sourceHeight * scale));
		const context = canvas.getContext("2d")!;
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, canvas.width, canvas.height);
		if (bitmap) context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		else context.drawImage(image!, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(
				(value) => (value ? resolve(value) : reject(new Error("JPEG encoding failed"))),
				"image/jpeg",
				0.9,
			),
		);
		return { bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
	} finally {
		bitmap?.close();
		if (objectUrl) URL.revokeObjectURL(objectUrl);
	}
}
