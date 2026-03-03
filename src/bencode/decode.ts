const COLON = ":".charCodeAt(0);
const ZERO = "0".charCodeAt(0);
const NINE = "9".charCodeAt(0);
const MAX_STRING_LENGTH = 25 * 1024 * 1024;
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
		if (byte === undefined || byte < ZERO || byte > NINE) {
			throw new Error("Invalid length");
		}
		const digit = byte - ZERO + 0;
		num = num * 10n + BigInt(digit);
	}
	return num;
}

export function decodeBencodedString(
	input: Uint8Array,
	offset: number,
): { value: Uint8Array; nextOffset: number } {
	const colonPosition = input.indexOf(COLON, offset);
	if (colonPosition <= 0) {
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
