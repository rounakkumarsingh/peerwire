import { describe, expect, test } from "bun:test";
import { decodeBencodedInteger, decodeBencodedString } from "./decode";

const toUint8Array = (str: string) => new TextEncoder().encode(str);

describe("bencoded strings", () => {
	test("valid string", () => {
		const input = toUint8Array("4:test");
		const result = decodeBencodedString(input, 0);
		expect(new TextDecoder().decode(result.value)).toBe("test");
		expect(result.nextOffset).toBe(6);
	});

	test("longer string", () => {
		const input = toUint8Array("10:helloworld");
		const result = decodeBencodedString(input, 0);
		expect(new TextDecoder().decode(result.value)).toBe("helloworld");
		expect(result.nextOffset).toBe(13);
	});

	test("empty string", () => {
		const input = toUint8Array("0:");
		const result = decodeBencodedString(input, 0);
		expect(result.value.length).toBe(0);
		expect(result.nextOffset).toBe(2);
	});

	test("zero-padded length throws", () => {
		const input = toUint8Array("06:myname");
		expect(() => decodeBencodedString(input, 0)).toThrow();
	});

	test("negative length throws", () => {
		const input = toUint8Array("-1:test");
		expect(() => decodeBencodedString(input, 0)).toThrow();
	});

	test("missing colon throws", () => {
		const input = toUint8Array("abc");
		expect(() => decodeBencodedString(input, 0)).toThrow();
	});

	test("content exceeds input throws", () => {
		const input = toUint8Array("100:short");
		expect(() => decodeBencodedString(input, 0)).toThrow();
	});

	test("single zero length is valid", () => {
		const input = toUint8Array("0:");
		const result = decodeBencodedString(input, 0);
		expect(result.value.length).toBe(0);
		expect(result.nextOffset).toBe(2);
	});

	test("non-digit inside length throws - 4a:test", () => {
		const input = toUint8Array("4a:test");
		expect(() => decodeBencodedString(input, 0)).toThrow();
	});

	test("non-digit inside length throws - a4:test", () => {
		const input = toUint8Array("a4:test");
		expect(() => decodeBencodedString(input, 0)).toThrow();
	});

	test("multiple leading zeros throw - 00:", () => {
		const input = toUint8Array("00:");
		expect(() => decodeBencodedString(input, 0)).toThrow();
	});

	test("multiple leading zeros throw - 01:a", () => {
		const input = toUint8Array("01:a");
		expect(() => decodeBencodedString(input, 0)).toThrow();
	});

	test("missing digits before colon throws", () => {
		const input = toUint8Array(":test");
		expect(() => decodeBencodedString(input, 0)).toThrow();
	});

	test("excessively large length throws", () => {
		const input = toUint8Array("9999999999999999999:a");
		expect(() => decodeBencodedString(input, 0)).toThrow();
	});

	test("extra data after valid string is not consumed", () => {
		const input = toUint8Array("4:testjunk");
		const result = decodeBencodedString(input, 0);
		expect(new TextDecoder().decode(result.value)).toBe("test");
		expect(result.nextOffset).toBe(6);
	});

	test("parsing from non-zero offset works", () => {
		const input = toUint8Array("xx4:test");
		const result = decodeBencodedString(input, 2);
		expect(new TextDecoder().decode(result.value)).toBe("test");
		expect(result.nextOffset).toBe(8);
	});

	test("binary payload is preserved", () => {
		const input = new Uint8Array([52, 58, 0, 255, 1, 2]);
		const result = decodeBencodedString(input, 0);
		expect(result.value).toEqual(new Uint8Array([0, 255, 1, 2]));
		expect(result.nextOffset).toBe(6);
	});
});

describe("bencoded integers", () => {
	test("valid integer", () => {
		const input = toUint8Array("i42e");
		const result = decodeBencodedInteger(input, 0);
		expect(result.value).toBe(42n);
		expect(result.nextOffset).toBe(4);
	});
	test("valid negative", () => {
		const input = toUint8Array("i-42e");
		const result = decodeBencodedInteger(input, 0);
		expect(result.value).toBe(-42n);
		expect(result.nextOffset).toBe(5);
	});
	test("valid zero", () => {
		const input = toUint8Array("i0e");
		const result = decodeBencodedInteger(input, 0);
		expect(result.value).toBe(0n);
		expect(result.nextOffset).toBe(3);
	});
	test("invalid zero(minus sign)", () => {
		const input = toUint8Array("i-0e");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("leading zeros (positive)", () => {
		const input = toUint8Array("i069e");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("leading zeros (negative)", () => {
		const input = toUint8Array("i-069e");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("leading zeros (zeors)", () => {
		const input = toUint8Array("i000e");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing i", () => {
		const input = toUint8Array("69e");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing e", () => {
		const input = toUint8Array("i69");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing i & e", () => {
		const input = toUint8Array("69");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing i and negative", () => {
		const input = toUint8Array("-69e");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing e and negative", () => {
		const input = toUint8Array("i-69");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing i & e and negative", () => {
		const input = toUint8Array("-69");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing i and zero", () => {
		const input = toUint8Array("0e");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing e and zero", () => {
		const input = toUint8Array("i0");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing i & e and zero", () => {
		const input = toUint8Array("0");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("invalid string", () => {
		const input = toUint8Array("i01b06e");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});

	test("extra data after valid integer is not consumed", () => {
		const input = toUint8Array("i42ejunk");
		const result = decodeBencodedInteger(input, 0);
		expect(result.value).toBe(42n);
		expect(result.nextOffset).toBe(4);
	});

	test("parsing from non-zero offset works", () => {
		const input = toUint8Array("xxi42e");
		const result = decodeBencodedInteger(input, 2);
		expect(result.value).toBe(42n);
		expect(result.nextOffset).toBe(6);
	});

	test("empty integer throws", () => {
		const input = toUint8Array("ie");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});

	test("only negative sign throws", () => {
		const input = toUint8Array("i-e");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});

	test("very large integer", () => {
		const input = toUint8Array("i9999999999999999999e");
		const result = decodeBencodedInteger(input, 0);
		expect(result.value).toBe(9999999999999999999n);
		expect(result.nextOffset).toBe(21);
	});
});
