# GoodNodes

Handwritten notebooks for Obsidian, made for the iPad and Apple Pencil. A GoodNotes-style experience inside your vault:

- **Infinite canvas**: a whiteboard per subject for mind maps, notes, images and shapes, built on [Excalidraw](https://github.com/excalidraw/excalidraw). Excalidraw's own toolbar stays as it is.
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
| Text, shapes, arrows, images (Excalidraw) | ✅ | – |
| Tap the active pen to pick color & width | ✅ | ✅ |
| Pen, highlighter, eraser | Excalidraw tools | ✅ |
| Pages sidebar: thumbnails, outline, bookmarks | – | ✅ |
| Draggable page scrubber, jump to page | – | ✅ |
| Export "PDF with notes" | Excalidraw image export | ✅ |
| Dark / light theme follows Obsidian | ✅ | ✅ |

### How files are stored

Everything is a plain file in your vault, so any sync method works (Obsidian Sync, iCloud, Remotely Save/WebDAV, git…).

- A canvas is a `.goodnodes` file (JSON: Excalidraw scene + background + last viewport). Images you add are saved as normal image files in your attachment folder, not as base64 inside the JSON.
- PDF annotations go to a sidecar file next to the PDF: `Book.pdf` → `Book.pdf.goodnodes.json`. The PDF stays untouched. Export creates `Book (annotated).pdf`.

## Usage

- **New canvas**: click the ✏️ ribbon icon, or right-click a folder and choose *New GoodNodes canvas*. Tap any `.goodnodes` file to open it.
- **PDF as notebook**: click the 📖 ribbon icon and pick a PDF, or right-click a PDF and choose *Open as GoodNodes notebook*. In settings you can make tapping a PDF always open it in GoodNodes.
- **Pen color & width**: tap the pen once to select it, tap it again to open its color and width picker. Your choice is remembered.
- **Scratch out**: scribble firmly back and forth (at least ~4 direction changes) over handwriting. Strokes mostly covered by the scribble disappear together with the scribble. One or two lines through a word, or a scribble over empty space, stay as normal strokes. You can tune or disable this in settings.

## Install

### With BRAT (beta, recommended until it's in the community store)

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

- Excalidraw's fonts are bundled into `main.js` (except the 12 MB CJK font), so text works offline. The Mermaid importer and most UI translations are left out to keep the bundle around 4 MB.
- Finger input never reaches Excalidraw. A capture-phase gesture layer turns touches into pan and zoom (`updateScene` with scroll and zoom), while pen and mouse events pass through. Excalidraw's built-in pen mode can't pinch-zoom while the pencil is in use, which is why this layer exists.
- PDFs are rendered with Obsidian's bundled pdf.js. Only visible pages ±2 are rendered, and canvases far away are released, so memory stays flat with page count.

## License

MIT
