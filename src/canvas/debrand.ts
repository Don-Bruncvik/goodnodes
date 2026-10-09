// Excalidraw is the drawing engine, not the product the user sees: remove its
// links (docs, libraries site, socials) and features that call Excalidraw's
// services, and route "help" to GoodNodes' own help.
//
// Most of it is done with Excalidraw props (custom MainMenu, aiEnabled={false})
// and CSS; this covers what has no prop: menu entries without stable selectors
// and the help shortcuts.

const REMOVE_ITEMS = ["Mermaid to Excalidraw"];
const LIBRARY_HINT =
	"Select something on the canvas and choose “Add to library” to keep it here for all your notebooks.";

export function debrandExcalidraw(host: HTMLElement, openHelp: () => void): () => void {
	let raf = 0;
	const clean = () => {
		raf = 0;
		for (const item of host.querySelectorAll<HTMLElement>(".dropdown-menu-item")) {
			const text = item.querySelector(".dropdown-menu-item__text")?.textContent?.trim();
			if (text && REMOVE_ITEMS.includes(text)) item.remove();
		}
		const hint = host.querySelector<HTMLElement>(".library-menu-items__no-items__hint");
		if (hint && hint.textContent !== LIBRARY_HINT) hint.textContent = LIBRARY_HINT;
	};
	const observer = new MutationObserver(() => {
		if (!raf) raf = requestAnimationFrame(clean);
	});
	observer.observe(host, { childList: true, subtree: true });

	// The "?" button and the "?" shortcut open GoodNodes help instead of Excalidraw's.
	const onClick = (e: MouseEvent) => {
		if (!(e.target as Element | null)?.closest?.(".help-icon")) return;
		e.preventDefault();
		e.stopPropagation();
		openHelp();
	};
	const onKey = (e: KeyboardEvent) => {
		if (e.key !== "?" || (e.target as Element | null)?.closest?.("textarea, input, [contenteditable]")) return;
		e.preventDefault();
		e.stopPropagation();
		openHelp();
	};
	host.addEventListener("click", onClick, true);
	host.addEventListener("keydown", onKey, true);

	return () => {
		cancelAnimationFrame(raf);
		observer.disconnect();
		host.removeEventListener("click", onClick, true);
		host.removeEventListener("keydown", onKey, true);
	};
}
