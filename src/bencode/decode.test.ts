import { describe, expect, test } from "bun:test";
import {
	decodeBencodedInteger,
	decodeBencodedList,
	decodeBencodedString,
} from "./decode";

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

describe("test lists", () => {
	test("valid list", () => {
		const input = toUint8Array("l4:spami42ee");
		const result = decodeBencodedList(input, 0);
		expect(result.value).toEqual([toUint8Array("spam"), 42n]);
		expect(result.nextOffset).toEqual(12);
	});
	test("valid long list", () => {
		const input = toUint8Array("l4:spami42e4:teste");
		const result = decodeBencodedList(input, 0);
		expect(result.value).toEqual([
			toUint8Array("spam"),
			42n,
			toUint8Array("test"),
		]);
		expect(result.nextOffset).toEqual(18);
	});
	test("valid nested list", () => {
		const input = toUint8Array("ll4:spamee");
		const result = decodeBencodedList(input, 0);
		expect(result.value).toEqual([[toUint8Array("spam")]]);
		expect(result.nextOffset).toEqual(10);
	});
	test("empty array", () => {
		const input = toUint8Array("le");
		const result = decodeBencodedList(input, 0);
		expect(result.value).toEqual([]);
		expect(result.nextOffset).toEqual(2);
	});
	test("missing e", () => {
		const input = toUint8Array("l4:spam4:egg");
		expect(() => decodeBencodedList(input, 0)).toThrow();
	});
	test("EOF during item decoding", () => {
		const input = toUint8Array("l4:spami42");
		expect(() => decodeBencodedList(input, 0)).toThrow();
	});
	test("deep recursion test", () => {
		const input = toUint8Array(
			"llllllllllllllllllllllllllllllllleeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		);
		expect(decodeBencodedList(input, 0).value).toBeArray();
	});

	test("extra data after valid list is not consumed", () => {
		const input = toUint8Array("l4:spamejunk");
		const result = decodeBencodedList(input, 0);
		expect(result.value).toEqual([toUint8Array("spam")]);
		expect(result.nextOffset).toEqual(8);
	});

	test("parsing from non-zero offset works", () => {
		const input = toUint8Array("xxl4:spame");
		const result = decodeBencodedList(input, 2);
		expect(result.value).toEqual([toUint8Array("spam")]);
		expect(result.nextOffset).toEqual(10);
	});

	test("missing l throws", () => {
		const input = toUint8Array("4:spame");
		expect(() => decodeBencodedList(input, 0)).toThrow();
	});
});
