export interface PageRotationInfo {
	width: number;
	height: number;
	rotation: number;
}

/** Convert displayed pdf.js viewport coordinates into unrotated scale-1 page coordinates. */
export function displayedToUnrotated(x: number, y: number, page: PageRotationInfo): [number, number] {
	switch (normalize(page.rotation)) {
		case 90:
			return [y, page.height - x];
		case 180:
			return [page.width - x, page.height - y];
		case 270:
			return [page.width - y, x];
		default:
			return [x, y];
	}
}

/** Convert stored unrotated points into displayed viewport coordinates for rendering. */
export function unrotatedToDisplayed(x: number, y: number, page: PageRotationInfo): [number, number] {
	switch (normalize(page.rotation)) {
		case 90:
			return [page.height - y, x];
		case 180:
			return [page.width - x, page.height - y];
		case 270:
			return [y, page.width - x];
		default:
			return [x, y];
	}
}

function normalize(rotation: number): number {
	return ((rotation % 360) + 360) % 360;
}
