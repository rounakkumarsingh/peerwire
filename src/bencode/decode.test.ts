import { describe, expect, test } from "bun:test";
import { toUint8Array } from "../utils/toUint8Array";
import {
	type BencodeDecodedValue,
	decodeBencodedDictionary,
	decodeBencodedInteger,
	decodeBencodedList,
	decodeBencodedString,
} from "./decode";

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
	test("negative zero throws", () => {
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
	test("leading zeros (zeros)", () => {
		const input = toUint8Array("i000e");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing 'i' prefix throws", () => {
		const input = toUint8Array("69e");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing e", () => {
		const input = toUint8Array("i69");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing 'i' and 'e' throws", () => {
		const input = toUint8Array("69");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing 'i' and negative throws", () => {
		const input = toUint8Array("-69e");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing 'e' and negative throws", () => {
		const input = toUint8Array("i-69");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing 'i' & 'e' and negative throws", () => {
		const input = toUint8Array("-69");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing 'i' and zero throws", () => {
		const input = toUint8Array("0e");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing 'e' and zero throws", () => {
		const input = toUint8Array("i0");
		expect(() => decodeBencodedInteger(input, 0)).toThrow();
	});
	test("missing 'i' & 'e' and zero throws", () => {
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

describe("bencoded dictionary", () => {
	const toMap = (
		obj: Record<string, unknown>,
	): Map<Uint8Array, BencodeDecodedValue> => {
		const map = new Map<Uint8Array, BencodeDecodedValue>();
		for (const [key, value] of Object.entries(obj)) {
			map.set(new TextEncoder().encode(key), value as BencodeDecodedValue);
		}
		return map;
	};

	test("valid empty dictionary", () => {
		const input = toUint8Array("de");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(new Map());
		expect(result.nextOffset).toEqual(2);
	});

	test("valid single key-value", () => {
		const input = toUint8Array("d4:spami42ee");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(toMap({ spam: 42n }));
		expect(result.nextOffset).toEqual(12);
	});

	test("valid multiple key-values", () => {
		const input = toUint8Array("d3:fooi1e4:spami42ee");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(toMap({ foo: 1n, spam: 42n }));
		expect(result.nextOffset).toEqual(20);
	});

	test("valid dictionary with string value", () => {
		const input = toUint8Array("d4:name4:tomye");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(toMap({ name: toUint8Array("tomy") }));
		expect(result.nextOffset).toEqual(14);
	});

	test("valid dictionary with list value", () => {
		const input = toUint8Array("d4:namel3:tom4:jerree");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(
			toMap({ name: [toUint8Array("tom"), toUint8Array("jerr")] }),
		);
		expect(result.nextOffset).toEqual(21);
	});

	test("valid nested dictionary", () => {
		const input = toUint8Array("d4:named3:agei10eee");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(toMap({ name: toMap({ age: 10n }) }));
		expect(result.nextOffset).toEqual(19);
	});

	test("valid dictionary with all value types (sorted keys)", () => {
		const input = toUint8Array("d4:listli1ei2ee3:numi42e3:str5:valuee");
		const result = decodeBencodedDictionary(input, 0);

		expect(result.value).toEqual(
			toMap({
				list: [1n, 2n],
				num: 42n,
				str: toUint8Array("value"),
			}),
		);
	});

	test("keys must be strings", () => {
		const input = toUint8Array("di42e4:valee");
		expect(() => decodeBencodedDictionary(input, 0)).toThrow();
	});

	test("missing e throws", () => {
		const input = toUint8Array("d4:spami42");
		expect(() => decodeBencodedDictionary(input, 0)).toThrow();
	});

	test("missing e with multiple keys throws", () => {
		const input = toUint8Array("d4:foo4:bar4:baze");
		expect(() => decodeBencodedDictionary(input, 0)).toThrow();
	});

	test("empty key is valid in bencode", () => {
		const input = toUint8Array("d0:4:valee");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(toMap({ "": toUint8Array("vale") }));
	});

	test("missing value throws", () => {
		const input = toUint8Array("d4:spamee");
		expect(() => decodeBencodedDictionary(input, 0)).toThrow();
	});

	test("extra data after valid dictionary is not consumed", () => {
		const input = toUint8Array("d4:spami42eejunk");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(toMap({ spam: 42n }));
		expect(result.nextOffset).toEqual(12);
	});

	test("parsing from non-zero offset works", () => {
		const input = toUint8Array("xxd4:spami42ee");
		const result = decodeBencodedDictionary(input, 2);
		expect(result.value).toEqual(toMap({ spam: 42n }));
		expect(result.nextOffset).toEqual(14);
	});

	test("missing d throws", () => {
		const input = toUint8Array("4:spami42ee");
		expect(() => decodeBencodedDictionary(input, 0)).toThrow();
	});

	test("EOF during key decoding throws", () => {
		const input = toUint8Array("d4:spami42e4:");
		expect(() => decodeBencodedDictionary(input, 0)).toThrow();
	});

	test("EOF during value decoding throws", () => {
		const input = toUint8Array("d4:spam4:");
		expect(() => decodeBencodedDictionary(input, 0)).toThrow();
	});

	test("deeply nested dictionary", () => {
		const input = toUint8Array("d1:ad1:bd1:cd1:ddeeeee");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(
			toMap({ a: toMap({ b: toMap({ c: toMap({ d: new Map() }) }) }) }),
		);

		expect(result.nextOffset).toBe(input.length);
	});

	test("dictionary with zero-length string value (prefix)", () => {
		const input = toUint8Array("d3:key0:eEXTRA");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(toMap({ key: toUint8Array("") }));
		expect(result.nextOffset).toBe("d4:key0:e".length);
	});

	test("single character key and value", () => {
		const input = toUint8Array("d1:a1:be");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(toMap({ a: toUint8Array("b") }));
		expect(result.nextOffset).toEqual(8);
	});

	test("dictionary with integer value zero", () => {
		const input = toUint8Array("d4:zeroi0ee");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(toMap({ zero: 0n }));
	});

	test("dictionary with negative integer value", () => {
		const input = toUint8Array("d3:negi-10ee");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(toMap({ neg: -10n }));
	});

	test("dictionary with negative zero throws", () => {
		const input = toUint8Array("d4:negi-0ee");
		expect(() => decodeBencodedDictionary(input, 0)).toThrow();
	});

	test("only d throws", () => {
		const input = toUint8Array("d");
		expect(() => decodeBencodedDictionary(input, 0)).toThrow();
	});

	test("only de is valid empty dictionary", () => {
		const input = toUint8Array("de");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(new Map());
		expect(result.nextOffset).toEqual(2);
	});

	test("very long key", () => {
		const longKey = "a".repeat(1000);
		const input = toUint8Array(`d${longKey.length}:${longKey}i1ee`);

		const result = decodeBencodedDictionary(input, 0);

		expect(result.value.size).toEqual(1);
		expect(result.nextOffset).toBe(input.length);
	});

	test("simple valid dictionary d3:key5:valuee", () => {
		const input = toUint8Array("d3:key5:valuee");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(toMap({ key: toUint8Array("value") }));
		expect(result.nextOffset).toEqual(14);
	});

	test("multiple key-value pairs d3:bar4:spam3:fooi42ee", () => {
		const input = toUint8Array("d3:bar4:spam3:fooi42ee");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value).toEqual(
			toMap({ bar: toUint8Array("spam"), foo: 42n }),
		);
	});

	test("dictionary inside list ld3:key5:valueee", () => {
		const input = toUint8Array("ld3:key5:valueee");
		const result = decodeBencodedList(input, 0);
		expect(result.value).toEqual([toMap({ key: toUint8Array("value") })]);
	});

	test("binary key is preserved", () => {
		const input = new Uint8Array([
			100, 50, 58, 255, 0, 53, 58, 118, 97, 108, 117, 101, 101,
		]);
		const result = decodeBencodedDictionary(input, 0);
		const keys = Array.from(result.value.keys());
		expect(keys[0]).toEqual(new Uint8Array([255, 0]));
	});

	test("binary value is preserved", () => {
		// d3:key4:\x00\xff\x01\x02e
		const input = new Uint8Array([
			100, 51, 58, 107, 101, 121, 52, 58, 0, 255, 1, 2, 101,
		]);
		const result = decodeBencodedDictionary(input, 0);
		const values = Array.from(result.value.values());
		expect(values[0]).toEqual(new Uint8Array([0, 255, 1, 2]));
	});

	test("key is not a string throws", () => {
		const input = toUint8Array("di42e3:fooe");
		expect(() => decodeBencodedDictionary(input, 0)).toThrow();
	});

	test("unexpected e immediately after key throws", () => {
		const input = toUint8Array("d3:keye3:valee");
		expect(() => decodeBencodedDictionary(input, 0)).toThrow();
	});

	test("keys sorted lexicographically - valid canonical form", () => {
		const input = toUint8Array("d3:bari1e3:fooi2ee");
		const result = decodeBencodedDictionary(input, 0);
		expect(result.value.size).toEqual(2);
	});

	test("duplicate keys - throws error", () => {
		const input = toUint8Array("d3:fooi1e3:fooi2ee");
		expect(() => decodeBencodedDictionary(input, 0)).toThrow();
	});

	test("dictionary keys must be byte-wise lexicographically sorted", () => {
		const input = toUint8Array("d2:aai1e4:10:ai2ee");

		expect(() => {
			decodeBencodedDictionary(input, 0);
		}).toThrow();
	});

	test("unsorted large dictionary should throw", () => {
		let dict = "d";

		for (let i = 0; i < 100; i++) {
			const key = `k${i}`; // not padded
			dict += `${key.length}:${key}1:x`;
		}

		dict += "e";

		const input = toUint8Array(dict);

		expect(() => decodeBencodedDictionary(input, 0)).toThrow();
	});

	test("unsorted dictionary should throw (k2 before k10)", () => {
		const dict =
			"d" +
			"2:k21:x" + // key = "k2"
			"3:k101:x" + // key = "k10"
			"e";

		const input = toUint8Array(dict);

		expect(() => decodeBencodedDictionary(input, 0)).toThrow();
	});
});
