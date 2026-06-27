import { describe, expect, test } from "bun:test";
import { toUint8Array } from "../utils/toUint8Array";
import {
	decodeBencodedDictionary,
	decodeBencodedInteger,
	decodeBencodedList,
	decodeBencodedString,
} from "./decode";
import {
	type BencodeEncodedValue,
	encodeDict,
	encodeInteger,
	encodeItem,
	encodeList,
	encodeString,
} from "./encode";

describe("encodeString", () => {
	test("simple string", () => {
		const result = encodeString("test");
		expect(new TextDecoder().decode(result)).toBe("4:test");
	});

	test("empty string", () => {
		const result = encodeString("");
		expect(new TextDecoder().decode(result)).toBe("0:");
	});

	test("longer string", () => {
		const result = encodeString("helloworld");
		expect(new TextDecoder().decode(result)).toBe("10:helloworld");
	});

	test("single character", () => {
		const result = encodeString("a");
		expect(new TextDecoder().decode(result)).toBe("1:a");
	});

	test("preserves exact content", () => {
		const input = "hello world!";
		const result = encodeString(input);
		expect(new TextDecoder().decode(result)).toBe("12:hello world!");
	});

	test("encodes to Uint8Array", () => {
		const result = encodeString("test");
		expect(result).toBeInstanceOf(Uint8Array);
	});
});

describe("encodeInteger", () => {
	test("positive integer", () => {
		const result = encodeInteger(42n);
		expect(new TextDecoder().decode(result)).toBe("i42e");
	});

	test("negative integer", () => {
		const result = encodeInteger(-42n);
		expect(new TextDecoder().decode(result)).toBe("i-42e");
	});

	test("zero", () => {
		const result = encodeInteger(0n);
		expect(new TextDecoder().decode(result)).toBe("i0e");
	});

	test("very large positive integer", () => {
		const result = encodeInteger(9999999999999999999n);
		expect(new TextDecoder().decode(result)).toBe("i9999999999999999999e");
	});

	test("very large negative integer", () => {
		const result = encodeInteger(-9999999999999999999n);
		expect(new TextDecoder().decode(result)).toBe("i-9999999999999999999e");
	});

	test("one", () => {
		const result = encodeInteger(1n);
		expect(new TextDecoder().decode(result)).toBe("i1e");
	});

	test("negative one", () => {
		const result = encodeInteger(-1n);
		expect(new TextDecoder().decode(result)).toBe("i-1e");
	});
});

describe("encodeList", () => {
	test("empty list", () => {
		const result = encodeList([]);
		expect(new TextDecoder().decode(result)).toBe("le");
	});

	test("list with single string", () => {
		const result = encodeList(["spam"]);
		expect(new TextDecoder().decode(result)).toBe("l4:spame");
	});

	test("list with single integer", () => {
		const result = encodeList([42n]);
		expect(new TextDecoder().decode(result)).toBe("li42ee");
	});

	test("list with multiple items", () => {
		const result = encodeList(["spam", 42n]);
		expect(new TextDecoder().decode(result)).toBe("l4:spami42ee");
	});

	test("list with multiple integers", () => {
		const result = encodeList([1n, 2n, 3n]);
		expect(new TextDecoder().decode(result)).toBe("li1ei2ei3ee");
	});

	test("list with multiple strings", () => {
		const result = encodeList(["a", "bb", "ccc"]);
		expect(new TextDecoder().decode(result)).toBe("l1:a2:bb3:ccce");
	});

	test("nested list", () => {
		const result = encodeList([["spam"]]);
		expect(new TextDecoder().decode(result)).toBe("ll4:spamee");
	});

	test("deeply nested list", () => {
		const result = encodeList([[["nested"]]]);
		expect(new TextDecoder().decode(result)).toBe("lll6:nestedeee");
	});

	test("list with empty string", () => {
		const result = encodeList([""]);
		expect(new TextDecoder().decode(result)).toBe("l0:e");
	});

	test("list with zero integer", () => {
		const result = encodeList([0n]);
		expect(new TextDecoder().decode(result)).toBe("li0ee");
	});
});

describe("encodeDict", () => {
	test("empty dictionary", () => {
		const result = encodeDict(new Map());
		expect(new TextDecoder().decode(result)).toBe("de");
	});

	test("dictionary with single string value", () => {
		const dict = new Map<string, BencodeEncodedValue>([["name", "tomy"]]);
		const result = encodeDict(dict);
		expect(new TextDecoder().decode(result)).toBe("d4:name4:tomye");
	});

	test("dictionary with single integer value", () => {
		const dict = new Map<string, BencodeEncodedValue>([["age", 42n]]);
		const result = encodeDict(dict);
		expect(new TextDecoder().decode(result)).toBe("d3:agei42ee");
	});

	test("dictionary with multiple keys", () => {
		const dict = new Map<string, BencodeEncodedValue>([
			["foo", 1n],
			["spam", 42n],
		]);
		const result = encodeDict(dict);
		expect(new TextDecoder().decode(result)).toBe("d3:fooi1e4:spami42ee");
	});

	test("dictionary with list value", () => {
		const dict = new Map<string, BencodeEncodedValue>([["name", ["tom", "jerr"]]]);
		const result = encodeDict(dict);
		expect(new TextDecoder().decode(result)).toBe("d4:namel3:tom4:jerree");
	});

	test("dictionary with nested dictionary", () => {
		const inner = new Map<string, BencodeEncodedValue>([["age", 10n]]);
		const dict = new Map<string, BencodeEncodedValue>([["name", inner]]);
		const result = encodeDict(dict);
		expect(new TextDecoder().decode(result)).toBe("d4:named3:agei10eee");
	});

	test("dictionary keys are sorted lexicographically", () => {
		const dict = new Map<string, BencodeEncodedValue>([
			["zebra", 1n],
			["apple", 2n],
			["mango", 3n],
		]);
		const result = encodeDict(dict);
		expect(new TextDecoder().decode(result)).toBe("d5:applei2e5:mangoi3e5:zebrai1ee");
	});

	test("dictionary with empty string value", () => {
		const dict = new Map<string, BencodeEncodedValue>([["key", ""]]);
		const result = encodeDict(dict);
		expect(new TextDecoder().decode(result)).toBe("d3:key0:e");
	});

	test("dictionary with zero integer value", () => {
		const dict = new Map<string, BencodeEncodedValue>([["count", 0n]]);
		const result = encodeDict(dict);
		expect(new TextDecoder().decode(result)).toBe("d5:counti0ee");
	});

	test("dictionary with empty key", () => {
		const dict = new Map<string, BencodeEncodedValue>([["", "value"]]);
		const result = encodeDict(dict);
		expect(new TextDecoder().decode(result)).toBe("d0:5:valuee");
	});

	test("single key-value pair", () => {
		const dict = new Map<string, BencodeEncodedValue>([["key", "value"]]);
		const result = encodeDict(dict);
		expect(new TextDecoder().decode(result)).toBe("d3:key5:valuee");
	});
});

describe("encodeItem", () => {
	test("encodes string", () => {
		const result = encodeItem("test");
		expect(new TextDecoder().decode(result)).toBe("4:test");
	});

	test("encodes bigint", () => {
		const result = encodeItem(42n);
		expect(new TextDecoder().decode(result)).toBe("i42e");
	});

	test("encodes array", () => {
		const result = encodeItem(["spam", 42n]);
		expect(new TextDecoder().decode(result)).toBe("l4:spami42ee");
	});

	test("encodes Map", () => {
		const dict = new Map<string, BencodeEncodedValue>([["key", "value"]]);
		const result = encodeItem(dict);
		expect(new TextDecoder().decode(result)).toBe("d3:key5:valuee");
	});

	test("throws for unsupported type", () => {
		expect(() => encodeItem(42 as unknown as BencodeEncodedValue)).toThrow();
	});
});

describe("encoding roundtrip", () => {
	test("string roundtrip", () => {
		const original = "hello world";
		const encoded = encodeString(original);
		const decoded = decodeBencodedString(encoded, 0);
		expect(new TextDecoder().decode(decoded.value)).toBe(original);
	});

	test("integer roundtrip", () => {
		const original = 42n;
		const encoded = encodeInteger(original);
		const decoded = decodeBencodedInteger(encoded, 0);
		expect(decoded.value).toBe(original);
	});

	test("negative integer roundtrip", () => {
		const original = -42n;
		const encoded = encodeInteger(original);
		const decoded = decodeBencodedInteger(encoded, 0);
		expect(decoded.value).toBe(original);
	});

	test("zero integer roundtrip", () => {
		const original = 0n;
		const encoded = encodeInteger(original);
		const decoded = decodeBencodedInteger(encoded, 0);
		expect(decoded.value).toBe(original);
	});

	test("list roundtrip", () => {
		const original: BencodeEncodedValue[] = ["spam", 42n];
		const encoded = encodeList(original);
		const decoded = decodeBencodedList(encoded, 0);
		expect(decoded.value).toEqual([toUint8Array("spam"), 42n]);
	});

	test("empty list roundtrip", () => {
		const original: BencodeEncodedValue[] = [];
		const encoded = encodeList(original);
		const decoded = decodeBencodedList(encoded, 0);
		expect(decoded.value).toEqual([]);
	});

	test("nested list roundtrip", () => {
		const original: BencodeEncodedValue[] = [["nested", 1n], "test"];
		const encoded = encodeList(original);
		const decoded = decodeBencodedList(encoded, 0);
		expect(decoded.value).toEqual([[toUint8Array("nested"), 1n], toUint8Array("test")]);
	});

	test("dict roundtrip", () => {
		const original = new Map<string, BencodeEncodedValue>([
			["name", "tomy"],
			["age", 42n],
		]);
		const encoded = encodeDict(original);
		const decoded = decodeBencodedDictionary(encoded, 0);
		expect(decoded.value.size).toBe(2);
	});

	test("empty dict roundtrip", () => {
		const original = new Map<string, BencodeEncodedValue>();
		const encoded = encodeDict(original);
		const decoded = decodeBencodedDictionary(encoded, 0);
		expect(decoded.value).toEqual(new Map());
	});

	test("nested dict roundtrip", () => {
		const inner = new Map<string, BencodeEncodedValue>([["count", 5n]]);
		const original = new Map<string, BencodeEncodedValue>([["data", inner]]);
		const encoded = encodeDict(original);
		const decoded = decodeBencodedDictionary(encoded, 0);
		expect(decoded.value.size).toBe(1);
	});

	test("complex nested structure roundtrip", () => {
		const original = new Map<string, BencodeEncodedValue>([
			["info", new Map<string, BencodeEncodedValue>([["size", 100n]])],
			["files", ["a", "b", "c"]],
			["count", 42n],
		]);
		const encoded = encodeDict(original);
		const decoded = decodeBencodedDictionary(encoded, 0);
		expect(decoded.value.size).toBe(3);
	});
});

describe("encoded output format", () => {
	test("string has correct format", () => {
		const result = encodeString("hello");
		expect(result).toEqual(toUint8Array("5:hello"));
	});

	test("integer has correct format", () => {
		const result = encodeInteger(100n);
		expect(result).toEqual(toUint8Array("i100e"));
	});

	test("list has correct format", () => {
		const result = encodeList(["a", 1n]);
		expect(result).toEqual(toUint8Array("l1:ai1ee"));
	});

	test("dict has correct format", () => {
		const dict = new Map<string, BencodeEncodedValue>([["a", 1n]]);
		const result = encodeDict(dict);
		expect(result).toEqual(toUint8Array("d1:ai1ee"));
	});
});

describe("edge cases", () => {
	test("very long string", () => {
		const longString = "a".repeat(1000);
		const result = encodeString(longString);
		expect(new TextDecoder().decode(result)).toBe(`1000:${longString}`);
	});

	test("list with all types", () => {
		const dict = new Map<string, BencodeEncodedValue>([["key", "value"]]);
		const result = encodeList(["string", 42n, ["nested"], dict]);
		expect(new TextDecoder().decode(result)).toBe("l6:stringi42el6:nesteded3:key5:valueee");
	});

	test("dict with all value types", () => {
		const dict = new Map<string, BencodeEncodedValue>([
			["str", "value"],
			["num", 42n],
			["list", [1n, 2n]],
			["dict", new Map<string, BencodeEncodedValue>([["x", 1n]])],
		]);
		const result = encodeDict(dict);
		const decoded = decodeBencodedDictionary(result, 0);
		expect(decoded.value.size).toBe(4);
	});

	test("special characters", () => {
		const result = encodeString("a:b:c");
		const decoded = decodeBencodedString(result, 0);
		expect(new TextDecoder().decode(decoded.value)).toBe("a:b:c");
	});
});
