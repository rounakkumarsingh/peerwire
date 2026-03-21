const COLON = ":".charCodeAt(0);
const ZERO = "0".charCodeAt(0);
const NINE = "9".charCodeAt(0);
const MINUS = "-".charCodeAt(0);
const LOWERCASE_I = "i".charCodeAt(0);
const LOWERCASE_E = "e".charCodeAt(0);
const LOWERCASE_L = "l".charCodeAt(0);
const LOWERCASE_D = "d".charCodeAt(0);

const MAX_STRING_LENGTH = 25 * 1024 * 1024;

export type BencodeDecodedValue =
	| Uint8Array
	| bigint
	| BencodeDecodedValue[]
	| Map<Uint8Array, BencodeDecodedValue>;

function parseNumber(input: Uint8Array, offset: number, end?: number): bigint {
	let num = BigInt(0);
	const endCondition = (i: number, input: Uint8Array) => {
		if (end !== undefined) return i < end;
		else {
			const byte = input.at(i);
			if (byte === undefined) return false;
			return byte >= ZERO && byte <= NINE;
		}
	};
	for (let i = offset; endCondition(i, input); i++) {
		const byte = input.at(i);
		if (byte === MINUS && i === offset) {
			continue;
		} else if (byte === undefined || byte < ZERO || byte > NINE) {
			throw new Error("Invalid number to read");
		}
		const digit = byte - ZERO + 0;
		num = num * 10n + BigInt(digit);
	}
	const isNegative = input.at(offset) === MINUS;
	if (isNegative) {
		if (num === 0n) throw new Error("-0 is not an accepted number");
		num *= -1n;
	}
	return num;
}

export function decodeBencodedString(
	input: Uint8Array,
	offset: number,
): { value: Uint8Array; nextOffset: number } {
	const colonPosition = input.indexOf(COLON, offset);
	if (colonPosition <= offset) {
		throw new Error("Expected colon in Bencoded string");
	}

	const contentLengthBig = parseNumber(input, offset, colonPosition);

	// Leading zero check
	if (colonPosition - offset > 1 && input[offset] === ZERO) {
		throw new Error("Length should not start with 0");
	}

	if (contentLengthBig < 0n) {
		throw new Error("Content length must be non-negative");
	}

	// Must fit in JS number
	if (contentLengthBig > BigInt(MAX_STRING_LENGTH)) {
		throw new Error("Content length too large for JS");
	}

	const contentLength = Number(contentLengthBig);

	const start = colonPosition + 1;
	const end = start + contentLength;

	if (end > input.length) {
		throw new Error("Content length exceeds input size");
	}

	const content = input.slice(start, end);

	return {
		value: content,
		nextOffset: end,
	};
}

export function decodeBencodedInteger(
	input: Uint8Array,
	offset: number,
): { value: bigint; nextOffset: number } {
	if (input.at(offset) !== LOWERCASE_I) {
		throw new Error("expected 'i'");
	}
	const numberEnd = input.indexOf(LOWERCASE_E, offset);
	if (numberEnd <= offset + 1) {
		// handles case where e is not available or just ie
		throw new Error(
			numberEnd === offset + 1 ? "expected number" : "expected 'e'",
		);
	}
	const number = parseNumber(input, offset + 1, numberEnd);
	if (
		(input.at(offset + 1) === ZERO && numberEnd - offset > 2) ||
		(input.at(offset + 1) === MINUS &&
			input.at(offset + 2) === ZERO &&
			numberEnd - offset > 3)
	) {
		throw new Error("No leading zeros");
	}
	return {
		value: number,
		nextOffset: numberEnd + 1,
	};
}

export function decodeBencodedList(
	input: Uint8Array,
	offset: number,
): { value: BencodeDecodedValue[]; nextOffset: number } {
	if (input.at(offset) !== LOWERCASE_L) {
		throw new Error("Not a list item. Expected 'l'");
	}
	let currOffset = offset + 1;
	const arr: BencodeDecodedValue[] = [];
	while (currOffset < input.length && input.at(currOffset) !== LOWERCASE_E) {
		const { value, nextOffset } = decodeBencodedItem(input, currOffset);
		arr.push(value);
		currOffset = nextOffset;
	}
	if (currOffset >= input.length) {
		throw new Error("list not closed. Expected 'e'");
	}
	return {
		value: arr,
		nextOffset: currOffset + 1,
	};
}

export function decodeBencodedDictionary(
	input: Uint8Array,
	offset: number,
): { value: Map<Uint8Array, BencodeDecodedValue>; nextOffset: number } {
	if (input[offset] !== LOWERCASE_D) {
		throw new Error("Not a dictionary item. Expected 'd'");
	}
	let currOffset = offset + 1;
	const dict = new Map<Uint8Array, BencodeDecodedValue>();
	let lastKey: Uint8Array | null = null;
	while (currOffset < input.length && input[currOffset] !== LOWERCASE_E) {
		// Parse key (must be a string in bencode)
		const { value: key, nextOffset: afterKeyOffset } = decodeBencodedString(
			input,
			currOffset,
		);
		currOffset = afterKeyOffset;
		const { value, nextOffset: afterValueOffset } = decodeBencodedItem(
			input,
			currOffset,
		);
		currOffset = afterValueOffset;
		if (lastKey !== null && compareBytes(lastKey, key) >= 0) {
			throw new Error("keys must be sorted");
		}
		dict.set(key, value);
		lastKey = key;
	}
	if (currOffset >= input.length) {
		throw new Error("Dictionary not closed. Expected 'e'");
	}
	return {
		value: dict,
		nextOffset: currOffset + 1, // skip 'e'
	};
}

export function decodeBencodedItem(
	input: Uint8Array,
	offset: number,
): { value: BencodeDecodedValue; nextOffset: number } {
	const byte = input[offset];

	if (byte === undefined) {
		throw new Error(`Unexpected end of input at offset ${offset}`);
	}

	switch (byte) {
		case LOWERCASE_I:
			return decodeBencodedInteger(input, offset);

		case LOWERCASE_L:
			return decodeBencodedList(input, offset);

		case LOWERCASE_D:
			return decodeBencodedDictionary(input, offset);

		default:
			if (byte >= ZERO && byte <= NINE) {
				return decodeBencodedString(input, offset);
			}

			throw new Error(
				`Invalid bencoded item at offset ${offset}: 0x${byte.toString(16)}`,
			);
	}
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const minLen = Math.min(a.length, b.length);

	for (let i = 0; i < minLen; i++) {
		if (a[i] !== b[i]) {
			// biome-ignore lint/style/noNonNullAssertion: i < min(|a|, |b|)
			return a[i]! - b[i]!; // negative if a < b
		}
	}

	return a.length - b.length;
}
