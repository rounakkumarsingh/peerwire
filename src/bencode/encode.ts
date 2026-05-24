import { toUint8Array } from "../utils/toUint8Array";

export type BencodeEncodedValue =
	| string
	| bigint
	| BencodeEncodedValue[]
	| Map<string, BencodeEncodedValue>;

export function encodeItem(val: BencodeEncodedValue): Uint8Array {
	if (typeof val === "string") {
		return encodeString(val);
	} else if (typeof val === "bigint") {
		return encodeInteger(val);
	} else if (Array.isArray(val)) {
		return encodeList(val);
	} else if (val instanceof Map) {
		return encodeDict(val);
	}
	throw new Error("Unsupported Error type");
}

export function encodeInteger(number: bigint): Uint8Array {
	return toUint8Array(`i${number.toString()}e`);
}

export function encodeString(string: string): Uint8Array {
	return toUint8Array(`${string.length.toString()}:${string}`);
}

export function encodeList(vals: BencodeEncodedValue[]): Uint8Array {
	const byteStrings = vals.map(encodeItem);
	return Buffer.concat([toUint8Array("l"), ...byteStrings, toUint8Array("e")]);
}

export function encodeDict(dict: Map<string, BencodeEncodedValue>): Uint8Array {
	const sortedKeys = Array.from(dict.keys()).sort();
	const kvPairs: Uint8Array[] = [];
	for (const key of sortedKeys) {
		kvPairs.push(encodeString(key));
		// biome-ignore lint/style/noNonNullAssertion: these keys come from `dict.keys()`
		kvPairs.push(encodeItem(dict.get(key)!));
	}
	return Buffer.concat([toUint8Array("d"), ...kvPairs, toUint8Array("e")]);
}
