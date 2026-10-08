import { TFile, TextFileView, WorkspaceLeaf } from "obsidian";
import { StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CaptureUpdateAction, Excalidraw, getSceneVersion, restore, serializeAsJSON } from "@excalidraw/excalidraw";
import type { AppState, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import "./canvas.css";
import type GoodNodesPlugin from "../main";
import { debug } from "../debug";
import { BackgroundLayer, DEFAULT_BACKGROUND, type BackgroundKind, type BackgroundSettings } from "./background";
import { TouchGestures, type Viewport } from "./touch";
import { handleFinishedStroke } from "./scratch";
import { CanvasImages, type StoredFile } from "./images";

export const CANVAS_VIEW_TYPE = "goodnodes-canvas";
export const CANVAS_EXTENSION = "goodnodes";

/**
 * On-disk format of a .goodnodes file. `scene` is Excalidraw's own JSON export,
 * except that `scene.files` holds vault paths instead of dataURLs (see images.ts).
 */
interface CanvasFile {
	type: "goodnodes";
	version: 1;
	background: BackgroundSettings;
	viewport: Viewport;
	scene: { elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, StoredFile> } & Record<
		string,
		unknown
	>;
}

export function emptyCanvasFile(): string {
	const file: CanvasFile = {
		type: "goodnodes",
		version: 1,
		background: { ...DEFAULT_BACKGROUND },
		viewport: { scrollX: 0, scrollY: 0, zoom: 1 },
		scene: { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} },
	};
	return JSON.stringify(file);
}

function parseCanvasFile(data: string): CanvasFile {
	if (!data.trim()) return JSON.parse(emptyCanvasFile());
	const parsed = JSON.parse(data) as Partial<CanvasFile>;
	return {
		type: "goodnodes",
		version: 1,
		background: { ...DEFAULT_BACKGROUND, ...parsed.background },
		viewport: { scrollX: 0, scrollY: 0, zoom: 1, ...parsed.viewport },
		scene: parsed.scene ?? {},
	};
}

/** Restore a scene from disk; vault-backed images are loaded separately. */
function restoreScene(scene: CanvasFile["scene"]) {
	const embedded: Record<string, StoredFile> = {};
	for (const [id, f] of Object.entries(scene.files ?? {})) if (f.dataURL) embedded[id] = f;
	return restore({ ...scene, files: embedded } as Parameters<typeof restore>[0], null, null);
}

export class CanvasView extends TextFileView {
	private root: Root | null = null;
	private api: ExcalidrawImperativeAPI | null = null;
	private hostEl: HTMLElement | null = null;
	private gestures: TouchGestures | null = null;
	private bg: BackgroundLayer | null = null;
	private images: CanvasImages;
	private background: BackgroundSettings = { ...DEFAULT_BACKGROUND };
	private viewport: Viewport = { scrollX: 0, scrollY: 0, zoom: 1 };
	/** Raw text last loaded from or written to disk. */
	private lastData = "";
	/** Scene version + background as of lastData; a change means unsaved edits. */
	private savedVersion = "";
	private savedViewport = "";
	private loading = false;
	private unsubs: (() => void)[] = [];
	private mountId = 0;
	private fileCount = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: GoodNodesPlugin,
	) {
		super(leaf);
		this.images = new CanvasImages(this.app, () => this.plugin.settings.imageFolder);
	}

	getViewType(): string {
		return CANVAS_VIEW_TYPE;
	}

	getIcon(): string {
		return "pencil";
	}

	getDisplayText(): string {
		return this.file?.basename ?? "GoodNodes";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("goodnodes-canvas-view");
		this.registerEvent(this.app.workspace.on("css-change", () => this.applyTheme()));
	}

	async onClose(): Promise<void> {
		await this.flushViewport();
		this.unmount();
	}

	async onUnloadFile(file: TFile): Promise<void> {
		await this.flushViewport();
		await super.onUnloadFile(file);
	}

	/**
	 * Panning/zooming alone doesn't mark the file dirty (that would rewrite and
	 * re-sync it constantly); the viewport is written once, when the file closes.
	 */
	private async flushViewport(): Promise<void> {
		const file = this.file;
		if (!this.api || !file || JSON.stringify(this.viewport) === this.savedViewport) return;
		try {
			await this.app.vault.modify(file, this.getViewData());
		} catch (e) {
			debug.error("cannot save viewport", e);
		}
	}

	// ---- TextFileView contract ----

	getViewData(): string {
		if (!this.api) return this.lastData;
		const elements = this.api.getSceneElementsIncludingDeleted();
		const scene = JSON.parse(serializeAsJSON(elements, this.api.getAppState(), this.api.getFiles(), "local"));
		scene.files = this.images.toStored(scene.files);
		const file: CanvasFile = {
			type: "goodnodes",
			version: 1,
			background: this.background,
			viewport: this.viewport,
			scene,
		};
		const data = JSON.stringify(file);
		this.lastData = data;
		this.savedVersion = this.currentVersion();
		this.savedViewport = JSON.stringify(this.viewport);
		return data;
	}

	setViewData(data: string, clear: boolean): void {
		if (!clear && data === this.lastData) return;
		if (!clear && this.api && this.currentVersion() !== this.savedVersion) {
			// Changed on disk (sync) while we have unsaved strokes: keep ours, they win on next save.
			debug.log("file changed externally but view has unsaved changes; keeping local", "warn");
			return;
		}
		let parsed: CanvasFile;
		try {
			parsed = parseCanvasFile(data);
		} catch (e) {
			debug.error("cannot parse .goodnodes file", e);
			return;
		}
		this.lastData = data;
		if (!clear && this.api) this.reloadInPlace(parsed);
		else this.mount(parsed);
	}

	clear(): void {
		this.unmount();
	}

	// ---- mounting ----

	private mount(file: CanvasFile): void {
		this.unmount();
		this.loading = true;
		const mountId = ++this.mountId;
		this.background = file.background;
		this.viewport = file.viewport;
		this.savedViewport = JSON.stringify(file.viewport);
		this.images.reset(file.scene.files);

		const restored = restoreScene(file.scene);
		const initialData: ExcalidrawInitialDataState = {
			elements: restored.elements,
			files: restored.files,
			appState: {
				...restored.appState,
				viewBackgroundColor: "transparent",
				penMode: true,
				penDetected: true,
				// Opening a notebook should be ready to write.
				activeTool: { type: "freedraw", customType: null, locked: false, lastActiveTool: null },
				scrollX: this.viewport.scrollX,
				scrollY: this.viewport.scrollY,
				zoom: { value: this.viewport.zoom as AppState["zoom"]["value"] },
			},
			scrollToContent: false,
		};

		const host = this.contentEl.createDiv({ cls: "goodnodes-canvas-host" });
		this.hostEl = host;
		this.bg = new BackgroundLayer(host, this.background, this.isDark());
		this.bg.setViewport(this.viewport);
		const excalidrawEl = host.createDiv({ cls: "goodnodes-canvas-excalidraw" });
		this.gestures = new TouchGestures(host, {
			getViewport: () => this.viewport,
			setViewport: (v) => this.applyViewport(v),
			maxTouchSize: () => this.plugin.settings.palmMaxTouchSize,
		});

		this.root = createRoot(excalidrawEl);
		this.root.render(
			<StrictMode>
				<CanvasApp
					initialData={initialData}
					theme={this.isDark() ? "dark" : "light"}
					background={this.background}
					onBackground={(b) => this.setBackground(b)}
					onApi={(api) => {
						if (mountId === this.mountId) this.onApi(api, file);
					}}
				/>
			</StrictMode>,
		);
	}

	/** Apply a newer version of the file (e.g. from sync) without remounting. */
	private reloadInPlace(file: CanvasFile): void {
		const api = this.api;
		if (!api) return;
		this.loading = true;
		this.background = file.background;
		this.bg?.setSettings(file.background);
		this.images.reset(file.scene.files);
		const restored = restoreScene(file.scene);
		api.updateScene({ elements: restored.elements, captureUpdate: CaptureUpdateAction.NEVER });
		const embedded = Object.values(restored.files);
		if (embedded.length) api.addFiles(embedded);
		void this.images
			.load(file.scene.files)
			.then((files) => files.length && this.api === api && api.addFiles(files));
		requestAnimationFrame(() => {
			this.savedVersion = this.currentVersion();
			this.loading = false;
			debug.log("canvas reloaded from disk");
		});
	}

	private unmount(): void {
		for (const u of this.unsubs) u();
		this.unsubs = [];
		this.gestures?.destroy();
		this.gestures = null;
		this.bg?.destroy();
		this.bg = null;
		this.root?.unmount();
		this.root = null;
		this.api = null;
		this.hostEl?.remove();
		this.hostEl = null;
	}

	private onApi(api: ExcalidrawImperativeAPI, file: CanvasFile): void {
		if (this.api === api) return;
		this.api = api;
		this.unsubs.push(
			api.onScrollChange((scrollX, scrollY, zoom) => {
				this.viewport = { scrollX, scrollY, zoom: zoom.value };
				this.bg?.setViewport(this.viewport);
			}),
			api.onChange((elements, _appState, files) => {
				if (this.loading) return;
				if (this.currentVersion(elements) !== this.savedVersion) this.requestSave();
				const count = Object.keys(files).length;
				if (count !== this.fileCount) {
					this.fileCount = count;
					this.storeNewImages();
				}
			}),
			api.onPointerUp((activeTool) => {
				if (activeTool.type !== "freedraw") return;
				// Let Excalidraw finalize the element and record its history entry first.
				setTimeout(() => {
					if (this.api !== api) return;
					const s = this.plugin.settings;
					try {
						handleFinishedStroke(api, {
							enabled: s.scratchEnabled,
							includeText: s.scratchText,
							minReversals: s.scratchMinReversals,
							coverage: s.scratchCoverage,
						});
					} catch (e) {
						debug.error("scratch-out failed", e);
					}
				}, 0);
			}),
		);
		void this.images.load(file.scene.files).then((files) => {
			if (files.length && this.api === api) api.addFiles(files);
		});
		// The initial scene is not an unsaved change.
		requestAnimationFrame(() => {
			if (api.getAppState().activeTool.type === "selection") api.setActiveTool({ type: "freedraw" });
			this.fileCount = Object.keys(api.getFiles()).length;
			this.savedVersion = this.currentVersion();
			this.loading = false;
			debug.log(`canvas ready: ${api.getSceneElements().length} elements`);
		});
	}

	private storeNewImages(): void {
		const api = this.api;
		const file = this.file;
		if (!api || !file) return;
		void this.images.persistNew(api.getFiles(), file).then((wrote) => {
			if (wrote) this.requestSave();
		});
	}

	private currentVersion(
		elements: readonly ExcalidrawElement[] = this.api?.getSceneElementsIncludingDeleted() ?? [],
	): string {
		return `${getSceneVersion(elements)}|${this.background.kind}|${this.background.size}|${this.background.color}`;
	}

	private applyViewport(v: Viewport): void {
		this.viewport = v;
		this.bg?.setViewport(v);
		this.api?.updateScene({
			appState: { scrollX: v.scrollX, scrollY: v.scrollY, zoom: { value: v.zoom as AppState["zoom"]["value"] } },
			captureUpdate: CaptureUpdateAction.NEVER,
		});
	}

	private setBackground(b: BackgroundSettings): void {
		this.background = b;
		this.bg?.setSettings(b);
		this.requestSave();
	}

	private isDark(): boolean {
		return document.body.hasClass("theme-dark");
	}

	private applyTheme(): void {
		const dark = this.isDark();
		this.bg?.setDark(dark);
		this.api?.updateScene({
			appState: { theme: dark ? "dark" : "light" },
			captureUpdate: CaptureUpdateAction.NEVER,
		});
	}
}

// ---- React side ----

const BACKGROUNDS: { kind: BackgroundKind; label: string }[] = [
	{ kind: "blank", label: "Blank" },
	{ kind: "grid", label: "Grid" },
	{ kind: "dots", label: "Dots" },
];

const SIZES: { size: number; label: string }[] = [
	{ size: 16, label: "S" },
	{ size: 24, label: "M" },
	{ size: 40, label: "L" },
];

function BackgroundIcon({ kind }: { kind: BackgroundKind }) {
	return (
		<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5">
			<rect x="2.5" y="2.5" width="15" height="15" rx="3" />
			{kind === "grid" && <path d="M7.5 2.5v15M12.5 2.5v15M2.5 7.5h15M2.5 12.5h15" strokeWidth="1" />}
			{kind === "dots" &&
				[6.5, 10, 13.5].flatMap((x) =>
					[6.5, 10, 13.5].map((y) => (
						<circle key={`${x}-${y}`} cx={x} cy={y} r="0.9" fill="currentColor" stroke="none" />
					)),
				)}
		</svg>
	);
}

function CanvasApp(props: {
	initialData: ExcalidrawInitialDataState;
	theme: "light" | "dark";
	background: BackgroundSettings;
	onBackground: (b: BackgroundSettings) => void;
	onApi: (api: ExcalidrawImperativeAPI) => void;
}) {
	const [background, setBackground] = useState(props.background);
	const [open, setOpen] = useState(false);
	const update = (patch: Partial<BackgroundSettings>) => {
		const next = { ...background, ...patch };
		setBackground(next);
		props.onBackground(next);
	};
	return (
		<Excalidraw
			initialData={props.initialData}
			excalidrawAPI={props.onApi}
			theme={props.theme}
			handleKeyboardGlobally={false}
			autoFocus={false}
			UIOptions={{
				canvasActions: {
					// The file is managed by Obsidian; the paper is our background layer.
					loadScene: false,
					saveToActiveFile: false,
					export: false,
					changeViewBackgroundColor: false,
					toggleTheme: false,
				},
			}}
			renderTopRightUI={() => (
				<div className="goodnodes-bg-picker">
					<button
						className="goodnodes-bg-button"
						title="Paper background"
						aria-label="Paper background"
						onClick={() => setOpen(!open)}
					>
						<BackgroundIcon kind={background.kind} />
					</button>
					{open && (
						<div className="goodnodes-bg-menu">
							{BACKGROUNDS.map((b) => (
								<button
									key={b.kind}
									className={b.kind === background.kind ? "is-active" : ""}
									onClick={() => update({ kind: b.kind })}
								>
									<BackgroundIcon kind={b.kind} /> {b.label}
								</button>
							))}
							{background.kind !== "blank" && (
								<div className="goodnodes-bg-sizes">
									{SIZES.map((s) => (
										<button
											key={s.size}
											className={s.size === background.size ? "is-active" : ""}
											title={`Spacing ${s.size}`}
											onClick={() => update({ size: s.size })}
										>
											{s.label}
										</button>
									))}
								</div>
							)}
						</div>
					)}
				</div>
			)}
		/>
	);
}
