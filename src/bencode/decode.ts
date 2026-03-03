const COLON = ":".charCodeAt(0);
const ZERO = "0".charCodeAt(0);
const NINE = "9".charCodeAt(0);
const MINUS = "-".charCodeAt(0);
const LOWERCASE_I = "i".charCodeAt(0);
const LOWERCASE_E = "e".charCodeAt(0);

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

export function decodeBencodedInteger(
	input: Uint8Array,
	offset: number,
): { value: bigint; nextOffset: number } {
	if (input.at(offset) !== LOWERCASE_I) {
		throw new Error("expected 'i'");
	}
	const numberEnd = input.indexOf(LOWERCASE_E);
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
