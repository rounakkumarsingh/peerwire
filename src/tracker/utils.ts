import type { PeerId } from "./types";

export function generatePeerId(): PeerId {
	const bytes = new Uint8Array(20);
	crypto.getRandomValues(bytes);
	return bytes as PeerId;
}

export function percentEncodeBytes(bytes: Uint8Array): string {
	let result = "";
	for (let i = 0; i < bytes.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: i <= bytes.length
		const byte = bytes[i]!;
		result += `%${byte.toString(16).padStart(2, "0").toUpperCase()}`;
	}
	return result;
}

export function encodePeerId(id: PeerId): string {
	return percentEncodeBytes(id);
}
