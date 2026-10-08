import { mkdir, writeFile } from "node:fs/promises";
import { PDFDocument, StandardFonts, rgb, PDFDict, PDFName, PDFHexString } from "pdf-lib";

const out = "test-vault/Test/test-300.pdf";
await mkdir("test-vault/Test", { recursive: true });
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
const portrait = [595.28, 841.89];
const pageRefs = [];
for (let n = 1; n <= 300; n++) {

	const page = pdf.addPage(n === 150 ? [841.89, 595.28] : portrait);
	pageRefs.push(page.ref);
	const { width, height } = page.getSize();
	page.drawText(String(n), { x: 42, y: height - 115, size: 64, font: bold, color: rgb(0.12, 0.25, 0.48) });
	page.drawText(`GoodNodes PDF performance fixture — page ${n}`, { x: 42, y: height - 148, size: 17, font: bold, color: rgb(0.12, 0.12, 0.12) });
	page.drawLine({ start: { x: 42, y: height - 165 }, end: { x: width - 42, y: height - 165 }, thickness: 2, color: rgb(0.25, 0.48, 0.75) });
	for (let line = 0; line < 25; line++) {
		page.drawText(`Line ${String(line + 1).padStart(2, "0")}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer vitae lectus at sapien.`, {
			x: 48, y: height - 195 - line * 20, size: 10, font, color: rgb(0.18, 0.18, 0.18), maxWidth: width - 96,
		});
	}
	page.drawRectangle({ x: width - 142, y: 34, width: 86, height: 48, borderColor: rgb(0.8, 0.25, 0.2), borderWidth: 2, color: rgb(1, 0.92, 0.82), opacity: 0.65 });
	page.drawRectangle({ x: 42, y: 35, width: 34, height: 34, borderColor: rgb(0.15, 0.5, 0.3), borderWidth: 2 });
	page.drawCircle({ x: width / 2, y: 56, size: 17, borderColor: rgb(0.25, 0.4, 0.8), borderWidth: 2 });
}

// Add a simple linked outline tree using pdf-lib's low-level object context.
const ctx = pdf.context;
const refs = [];
for (let chapter = 0; chapter < 10; chapter++) refs.push(ctx.nextRef());
const rootRef = ctx.nextRef();
const root = ctx.obj({ Type: "Outlines", First: refs[0], Last: refs.at(-1), Count: refs.length });
ctx.assign(rootRef, root);
for (let chapter = 0; chapter < 10; chapter++) {
	const dict = ctx.obj({
		Title: PDFHexString.fromText(`Chapter ${chapter + 1}`), Parent: rootRef,
		Dest: [pageRefs[chapter * 3], PDFName.of("Fit")],
		...(chapter > 0 ? { Prev: refs[chapter - 1] } : {}),
		...(chapter < 9 ? { Next: refs[chapter + 1] } : {}),
	});
	ctx.assign(refs[chapter], dict);
}
pdf.catalog.set(PDFName.of("Outlines"), rootRef);
const bytes = await pdf.save();
await writeFile(out, bytes);
console.log(`Wrote ${out} (${bytes.length} bytes)`);
