export type PenType = "fountain" | "ball" | "brush";

export interface StrokeOptions {
	size: number;
	thinning: number;
	smoothing: number;
	streamline: number;
	simulatePressure?: boolean;
	start?: { cap?: boolean; taper?: number };
	end?: { cap?: boolean; taper?: number };
}

export function strokeOptions(tool: "pen" | "highlighter", pen: PenType | undefined, size: number): StrokeOptions {
	if (tool === "highlighter") return { size: size * 5, thinning: 0, smoothing: 0.5, streamline: 0.5 };
	switch (pen ?? "fountain") {
		case "ball":
			return { size, thinning: 0, smoothing: 0.5, streamline: 0.5, simulatePressure: false };
		case "brush":
			return {
				size: size * 1.2,
				thinning: 0.85,
				smoothing: 0.5,
				streamline: 0.5,
				start: { taper: 12 },
				end: { taper: 18 },
			};
		default:
			return { size, thinning: 0.6, smoothing: 0.5, streamline: 0.5 };
	}
}
