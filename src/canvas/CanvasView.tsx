import { TextFileView, WorkspaceLeaf } from "obsidian";
import { StrictMode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CaptureUpdateAction, Excalidraw, getSceneVersion, restore, serializeAsJSON } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import type GoodNodesPlugin from "../main";
import { debug } from "../debug";
import { BackgroundLayer, DEFAULT_BACKGROUND, type BackgroundKind, type BackgroundSettings } from "./background";
import { TouchGestures, type Viewport } from "./touch";
import { handleFinishedStroke } from "./scratch";

export const CANVAS_VIEW_TYPE = "goodnodes-canvas";
export const CANVAS_EXTENSION = "goodnodes";

/** On-disk format of a .goodnodes file. `scene` is Excalidraw's own JSON export. */
interface CanvasFile {
	type: "goodnodes";
	version: 1;
	background: BackgroundSettings;
	viewport: Viewport;
	scene: unknown;
}

export function emptyCanvasFile(): string {
	const file: CanvasFile = {
		type: "goodnodes",
		version: 1,
		background: { ...DEFAULT_BACKGROUND },
		viewport: { scrollX: 0, scrollY: 0, zoom: 1 },
		scene: { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} },
	};
	return JSON.stringify(file, null, "\t");
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

export class CanvasView extends TextFileView {
	private root: Root | null = null;
	private api: ExcalidrawImperativeAPI | null = null;
	private hostEl: HTMLElement | null = null;
	private gestures: TouchGestures | null = null;
	private bg: BackgroundLayer | null = null;
	private background: BackgroundSettings = { ...DEFAULT_BACKGROUND };
	private viewport: Viewport = { scrollX: 0, scrollY: 0, zoom: 1 };
	/** Raw text last loaded from or written to disk. */
	private lastData = "";
	/** Scene version + background as of lastData; a change means unsaved edits. */
	private savedVersion = "";
	private loading = false;
	private unsubs: (() => void)[] = [];
	private mountId = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: GoodNodesPlugin,
	) {
		super(leaf);
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
		this.unmount();
	}

	// ---- TextFileView contract ----

	getViewData(): string {
		if (!this.api) return this.lastData;
		const elements = this.api.getSceneElementsIncludingDeleted();
		const scene = JSON.parse(serializeAsJSON(elements, this.api.getAppState(), this.api.getFiles(), "local"));
		const file: CanvasFile = { type: "goodnodes", version: 1, background: this.background, viewport: this.viewport, scene };
		const data = JSON.stringify(file);
		this.lastData = data;
		this.savedVersion = this.currentVersion();
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
		this.mount(parsed);
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

		const restored = restore(file.scene as Parameters<typeof restore>[0], null, null);
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
						if (mountId === this.mountId) this.onApi(api);
					}}
				/>
			</StrictMode>,
		);
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

	private onApi(api: ExcalidrawImperativeAPI): void {
		if (this.api === api) return;
		this.api = api;
		this.unsubs.push(
			api.onScrollChange((scrollX, scrollY, zoom) => {
				this.viewport = { scrollX, scrollY, zoom: zoom.value };
				this.bg?.setViewport(this.viewport);
			}),
			api.onChange((elements) => {
				if (this.loading) return;
				if (this.currentVersion(elements) !== this.savedVersion) this.requestSave();
			}),
			api.onPointerUp((activeTool) => {
				if (activeTool.type !== "freedraw") return;
				// Let Excalidraw finalize the element and record its history entry first.
				setTimeout(() => {
					if (this.api !== api) return;
					try {
						handleFinishedStroke(api, { enabled: true, includeText: true });
					} catch (e) {
						debug.error("scratch-out failed", e);
					}
				}, 0);
			}),
		);
		// The initial scene is not an unsaved change.
		requestAnimationFrame(() => {
			if (api.getAppState().activeTool.type === "selection") api.setActiveTool({ type: "freedraw" });
			this.savedVersion = this.currentVersion();
			this.loading = false;
			debug.log(`canvas ready: ${api.getSceneElements().length} elements`);
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
		this.api?.updateScene({ appState: { theme: dark ? "dark" : "light" }, captureUpdate: CaptureUpdateAction.NEVER });
	}
}

// ---- React side ----

const BACKGROUNDS: { kind: BackgroundKind; label: string; icon: string }[] = [
	{ kind: "blank", label: "Blank", icon: "▢" },
	{ kind: "grid", label: "Grid", icon: "▦" },
	{ kind: "dots", label: "Dots", icon: "⠿" },
];

function CanvasApp(props: {
	initialData: ExcalidrawInitialDataState;
	theme: "light" | "dark";
	background: BackgroundSettings;
	onBackground: (b: BackgroundSettings) => void;
	onApi: (api: ExcalidrawImperativeAPI) => void;
}) {
	const [background, setBackground] = useState(props.background);
	const [open, setOpen] = useState(false);
	const pick = (kind: BackgroundKind) => {
		const next = { ...background, kind };
		setBackground(next);
		setOpen(false);
		props.onBackground(next);
	};
	return (
		<Excalidraw
			initialData={props.initialData}
			excalidrawAPI={props.onApi}
			theme={props.theme}
			handleKeyboardGlobally={false}
			autoFocus={false}
			renderTopRightUI={() => (
				<div className="goodnodes-bg-picker">
					<button
						className="goodnodes-bg-button"
						title="Background"
						aria-label="Background"
						onClick={() => setOpen(!open)}
					>
						{BACKGROUNDS.find((b) => b.kind === background.kind)?.icon}
					</button>
					{open && (
						<div className="goodnodes-bg-menu">
							{BACKGROUNDS.map((b) => (
								<button
									key={b.kind}
									className={b.kind === background.kind ? "is-active" : ""}
									onClick={() => pick(b.kind)}
								>
									<span>{b.icon}</span> {b.label}
								</button>
							))}
						</div>
					)}
				</div>
			)}
		/>
	);
}

// Silence "unused" for BinaryFiles until image-to-vault storage lands (M1).
export type { BinaryFiles };
