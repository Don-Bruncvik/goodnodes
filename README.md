# GoodNodes

Handwritten notebooks for Obsidian, made for the iPad and Apple Pencil. A GoodNotes-style experience inside your vault:

- **Infinite canvas**: a whiteboard per subject for mind maps, notes, images and shapes, built on [Excalidraw](https://github.com/excalidraw/excalidraw), with the same GoodNotes-style toolbar as the PDF notebooks.
- **PDF notebooks**: open any PDF from your vault, scroll through it, jump to a page, browse the outline or thumbnails, and write on the pages. The original PDF is never modified.

**The pen draws and fingers move the page.** You never switch to a hand tool: one finger pans or scrolls, two fingers pinch-zoom, even while you hold the pencil.

## Features

| | Canvas (`.goodnodes`) | PDF notebook |
|---|---|---|
| Pen draws, fingers pan & pinch-zoom | ✅ | ✅ |
| Palm rejection (touches ignored while the pen is down) | ✅ | ✅ |
| **Scratch out to erase**: zig-zag over a word to delete it | ✅ | ✅ |
| Undo / redo (scratch-out undoes in one step) | ✅ | ✅ |
| Paper background: blank, grid, dots | ✅ | – |
| One GoodNotes-style toolbar: lasso, pen, highlighter, eraser, text, shapes, image + the active tool's options inline | ✅ | ✅ |
| Pen types fountain / ball / brush, 3 thicknesses, 3 basic + 2 custom colors | ✅ | ✅ |
| Draw and hold: a drawn line, circle, rectangle or triangle snaps to a perfect shape | ✅ | ✅ |
| Lasso: select, move, resize, recolor, cut / copy / paste, duplicate, delete | ✅ (Excalidraw handles) | ✅ |
| Eraser: precise or whole stroke, highlighter only | whole elements | ✅ |
| Fingers draw when no Apple Pencil is used (automatic, or always / never) | ✅ | – |
| Text, shapes, arrows, images | ✅ | ✅ |
| Pages sidebar: thumbnails, outline, bookmarks | – | ✅ |
| Add / insert / delete pages, insert another PDF | – | ✅ |
| Insert a PDF (pages as images) | ✅ | – |
| Draggable page scrubber, jump to page | – | ✅ |
| Export "PDF with notes" | Excalidraw image export | ✅ |
| Dark / light theme follows Obsidian | ✅ | ✅ |

### How files are stored

Everything is a plain file in your vault, so any sync method works (Obsidian Sync, iCloud, Remotely Save/WebDAV, git…).

- A canvas is a `.goodnodes` file (JSON: Excalidraw scene + background + last viewport). Images you add are saved as normal image files in your attachment folder, not as base64 inside the JSON.
- PDF annotations go to a sidecar file next to the PDF: `Book.pdf` → `Book.pdf.goodnodes.json`. The PDF stays untouched. Export creates `Book (annotated).pdf`.

## Usage

Everything starts from Obsidian's file explorer. Right-click a folder (long-press on the iPad):

- **New GoodNodes notebook**: a paged notebook with a cover color, paper (blank, ruled, narrow ruled, grid, dots), A4/Letter, portrait/landscape. It is a PDF, so it opens everywhere.
- **New GoodNodes whiteboard**: an infinite canvas (`.goodnodes`).
- **Import into GoodNodes here**: pick PDFs and/or images from Files (iPad) or disk. PDFs are copied in as they are; images become a notebook with one page per image.

Right-click a PDF → **Open as GoodNodes notebook** (or enable *Open PDFs in GoodNodes* in settings so tapping a PDF does it).

In a notebook/PDF, the **…** menu adds, inserts or deletes pages, **inserts the pages of another PDF**, zooms and exports a PDF with your notes. There's also a **+ Add page** slot after the last page. On a whiteboard, **…** → **Insert PDF** places PDF pages on the board as images you can write on.

- **Toolbar**: like GoodNotes, but in one row: the tools, then the options of the active tool (pen type, thickness, colors), then undo / redo and **…**. The three basic colors are fixed; tap a custom color to use it, tap it again to change it. On a narrow screen the options move to a second row.
- **Draw and hold**: draw a line, circle, rectangle or triangle and keep the pencil on the screen for a moment – it becomes a perfect shape.
- **Scratch out**: scribble firmly back and forth (at least ~4 direction changes) over handwriting. Strokes mostly covered by the scribble disappear together with the scribble. One or two lines through a word, or a scribble over empty space, stay as normal strokes. You can tune or disable this in settings.

## Install

### From Community plugins

*Settings → Community plugins → Browse* → search for **GoodNodes** → *Install* → *Enable* (once it is listed in the Obsidian Community directory).

### With BRAT (beta versions)

1. In Obsidian, install **BRAT** from *Settings → Community plugins → Browse*.
2. *BRAT → Add beta plugin* → paste `https://github.com/Don-Bruncvik/goodnodes`.
3. Enable **GoodNodes** in *Community plugins*.

BRAT keeps the plugin up to date on every device, including the iPad.

### Manually

Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Don-Bruncvik/goodnodes/releases) into `<vault>/.obsidian/plugins/goodnodes/`, then enable the plugin.

## Development

```bash
npm install
npm run dev        # watch build → test-vault/.obsidian/plugins/goodnodes
npm test           # unit tests (scratch-out detection, PDF ink model, export mapping)
npm run build      # type-check + production build
npm run make-test-pdf   # 300-page fixture in test-vault/Test/
```

Open `test-vault/` as a vault in Obsidian to try it. On the iPad there are no devtools. Enable *Settings → GoodNodes → Show debug panel button* to get a live log of pen and touch events and errors, which you can copy into a bug report.

Releases: bump `version` in `manifest.json`, `package.json` and `versions.json`, then push a tag with the same version. GitHub Actions builds and publishes the release.

### Notes on the implementation

- Excalidraw is only the drawing engine: its menu, help, library site links and AI features are replaced or removed. The canvas library ("Add to library") is GoodNodes' own and is shared by all notebooks.

- Excalidraw's fonts are bundled into `main.js` (except the 12 MB CJK font), so text works offline. The Mermaid importer and most UI translations are left out to keep the bundle around 4 MB.
- Finger input never reaches Excalidraw. A capture-phase gesture layer turns touches into pan and zoom (`updateScene` with scroll and zoom), while pen and mouse events pass through. Excalidraw's built-in pen mode can't pinch-zoom while the pencil is in use, which is why this layer exists.
- PDFs are rendered with Obsidian's bundled pdf.js. Only visible pages ±2 are rendered, and canvases far away are released, so memory stays flat with page count.

## Privacy and network use

GoodNodes makes no network requests, has no telemetry and needs no account. All notebooks, notes and images stay in your vault.
One exception comes from Excalidraw: its Chinese, Japanese and Korean handwriting font (Xiaolai, 12 MB) is not bundled and is downloaded from [esm.sh](https://esm.sh) only when you write such text on a whiteboard.

## Third-party code

- [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT) – whiteboard engine; its fonts (Excalifont, Nunito, Comic Shanns, Cascadia, Liberation Sans, Lilita One, Virgil: SIL Open Font License / their own licenses) are bundled.
- [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT) – creating notebooks and exporting PDFs with notes.
- [perfect-freehand](https://github.com/steveruizok/perfect-freehand) (MIT) – pen strokes.
- [React](https://react.dev) (MIT) – used by Excalidraw.
- PDFs are rendered with the pdf.js (Apache 2.0) that ships with Obsidian.

GoodNodes is an independent project and is not affiliated with Goodnotes Limited or with Obsidian.

## License

MIT
