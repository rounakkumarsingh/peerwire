export function toUint8Array(str: string) {
	return new TextEncoder().encode(str);
}
