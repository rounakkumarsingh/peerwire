import type { PeerId } from "./types";

const CLIENT_ID = "PW";
const VERSION = "0001";

export function generatePeerId(): PeerId {
	const bytes = new Uint8Array(20);
	const prefix = `-${CLIENT_ID}${VERSION}-`;

	// Encode prefix (8 bytes: -PW0001-)
	for (let i = 0; i < prefix.length; i++) {
		bytes[i] = prefix.charCodeAt(i);
	}

	// Fill remaining 12 bytes with random values
	const randomBytes = new Uint8Array(12);
	crypto.getRandomValues(randomBytes);
	bytes.set(randomBytes, 8);

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
