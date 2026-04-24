import { describe, expect, test } from "bun:test";
import { PeerMessageType, parsePeerMessage } from "./messages";

/**
 * Helper to build peer wire protocol messages with the 4-byte big-endian length prefix.
 * @param type - The message type byte (PeerMessageType enum value)
 * @param payload - Array of bytes to append after the type byte
 * @returns Uint8Array ready for parsePeerMessage
 */
function buildMessage(type: number, payload: number[] = []): Uint8Array {
	const length = 1 + payload.length;
	const buffer = new Uint8Array(4 + length);
	const view = new DataView(buffer.buffer);
	view.setUint32(0, length, false); // big-endian length prefix
	buffer[4] = type;
	for (let i = 0; i < payload.length; i++) {
		buffer[5 + i] = payload[i]!;
	}
	return buffer;
}

/**
 * Helper to build a big-endian 4-byte Uint8Array from a number.
 * Used for piece indices, offsets, and lengths.
 */
function uint32Bytes(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/**
 * Helper to build a big-endian 2-byte Uint8Array from a number.
 * Used for port numbers.
 */
function uint16Bytes(value: number): number[] {
	return [(value >>> 8) & 0xff, value & 0xff];
}

/**
 * Helper to create a KeepAlive message (just 4 zero bytes for length prefix)
 */
function buildKeepAlive(): Uint8Array {
	const buffer = new Uint8Array(4);
	new DataView(buffer.buffer).setUint32(0, 0, false);
	return buffer;
}

describe("parsePeerMessage", () => {
	describe("KeepAlive message", () => {
		test("parses keep-alive (length prefix of 0)", () => {
			const data = buildKeepAlive();
			const result = parsePeerMessage(data);
			expect(result).toEqual({ type: PeerMessageType.KeepAlive });
		});

		test("keep-alive with extra data throws", () => {
			const buffer = new Uint8Array(5);
			new DataView(buffer.buffer).setUint32(0, 0, false);
			buffer[4] = 0;
			expect(() => parsePeerMessage(buffer)).toThrow();
		});
	});

	describe("Simple messages (Choke, Unchoke, Interested, NotInterested)", () => {
		test("parses Choke message", () => {
			const data = buildMessage(PeerMessageType.Choke);
			const result = parsePeerMessage(data);
			expect(result).toEqual({ type: PeerMessageType.Choke });
		});

		test("parses Unchoke message", () => {
			const data = buildMessage(PeerMessageType.Unchoke);
			const result = parsePeerMessage(data);
			expect(result).toEqual({ type: PeerMessageType.Unchoke });
		});

		test("parses Interested message", () => {
			const data = buildMessage(PeerMessageType.Interested);
			const result = parsePeerMessage(data);
			expect(result).toEqual({ type: PeerMessageType.Interested });
		});

		test("parses NotInterested message", () => {
			const data = buildMessage(PeerMessageType.NotInterested);
			const result = parsePeerMessage(data);
			expect(result).toEqual({ type: PeerMessageType.NotInterested });
		});

		test("choke with wrong length throws", () => {
			// Length says 2 but type byte is 0 (Choke)
			const buffer = new Uint8Array(6);
			new DataView(buffer.buffer).setUint32(0, 2, false);
			buffer[4] = PeerMessageType.Choke;
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid choke message: expected length 1 but got 2",
			);
		});

		test("unchoke with wrong length throws", () => {
			// Need buffer large enough to pass general length check (4+2=6 bytes)
			// but type validation expects length 1
			const buffer = new Uint8Array(6);
			new DataView(buffer.buffer).setUint32(0, 2, false);
			buffer[4] = PeerMessageType.Unchoke;
			buffer[5] = 0;
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid unchoke message: expected length 1 but got 2",
			);
		});

		test("interested with extra payload throws", () => {
			const data = buildMessage(PeerMessageType.Interested, [0x00]);
			expect(() => parsePeerMessage(data)).toThrow(
				"Invalid interested message: expected length 1 but got 2",
			);
		});

		test("not_interested with too short length throws", () => {
			// Actually this won't be validated because the length check happens after
			// we read the length prefix. Let's test the actual validation.
			const buffer = new Uint8Array(4); // Just length prefix, no message type
			new DataView(buffer.buffer).setUint32(0, 1, false);
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid message: expected length 1 but got 0",
			);
		});
	});

	describe("Have message", () => {
		test("parses Have with piece index 0", () => {
			const data = buildMessage(PeerMessageType.Have, uint32Bytes(0));
			const result = parsePeerMessage(data);
			expect(result).toEqual({ type: PeerMessageType.Have, index: 0 });
		});

		test("parses Have with small piece index", () => {
			const data = buildMessage(PeerMessageType.Have, uint32Bytes(42));
			const result = parsePeerMessage(data);
			expect(result).toEqual({ type: PeerMessageType.Have, index: 42 });
		});

		test("parses Have with max 32-bit index", () => {
			const data = buildMessage(PeerMessageType.Have, uint32Bytes(0xffffffff));
			const result = parsePeerMessage(data);
			expect(result).toEqual({
				type: PeerMessageType.Have,
				index: 0xffffffff,
			});
		});

		test("Have with wrong length (too short) throws", () => {
			const buffer = new Uint8Array(8);
			new DataView(buffer.buffer).setUint32(0, 4, false); // length = 4 (too short, should be 5)
			buffer[4] = PeerMessageType.Have;
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid have message: expected length 5 but got 4",
			);
		});

		test("Have with wrong length (too long) throws", () => {
			const buffer = new Uint8Array(10);
			new DataView(buffer.buffer).setUint32(0, 6, false); // length = 6 (too long, should be 5)
			buffer[4] = PeerMessageType.Have;
			buffer[5] = 0;
			buffer[6] = 0;
			buffer[7] = 0;
			buffer[8] = 0;
			buffer[9] = 0;
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid have message: expected length 5 but got 6",
			);
		});
	});

	describe("Bitfield message", () => {
		test("parses Bitfield with minimum payload (1 byte)", () => {
			const data = buildMessage(PeerMessageType.Bitfield, [0xff]);
			const result = parsePeerMessage(data);
			expect(result.type).toBe(PeerMessageType.Bitfield);
			expect(result).toHaveProperty("bitfield");
			if ("bitfield" in result) {
				expect(result.bitfield).toBeInstanceOf(Uint8Array);
				expect(result.bitfield.length).toBe(1);
				expect(result.bitfield[0]).toBe(0xff);
			}
		});

		test("parses Bitfield with multiple bytes", () => {
			const bitfieldData = [0xff, 0x80, 0x00, 0x01];
			const data = buildMessage(PeerMessageType.Bitfield, bitfieldData);
			const result = parsePeerMessage(data);
			expect(result.type).toBe(PeerMessageType.Bitfield);
			if ("bitfield" in result) {
				expect(result.bitfield.length).toBe(4);
				expect(Array.from(result.bitfield)).toEqual(bitfieldData);
			}
		});

		test("parses Bitfield with empty bitfield (length exactly 1)", () => {
			// This should fail because bitfield must be at least 1 byte (length >= 2)
			const data = buildMessage(PeerMessageType.Bitfield, []);
			expect(() => parsePeerMessage(data)).toThrow(
				"Invalid bitfield message: expected length >= 2 but got 1",
			);
		});

		test("Bitfield with length < 2 throws", () => {
			const buffer = new Uint8Array(5);
			new DataView(buffer.buffer).setUint32(0, 1, false); // length = 1 (too short)
			buffer[4] = PeerMessageType.Bitfield;
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid bitfield message: expected length >= 2 but got 1",
			);
		});

		test("parses large Bitfield payload", () => {
			const bitfieldData = Array.from({ length: 100 }, () => 0x55);
			const data = buildMessage(PeerMessageType.Bitfield, bitfieldData);
			const result = parsePeerMessage(data);
			expect(result.type).toBe(PeerMessageType.Bitfield);
			if ("bitfield" in result) {
				expect(result.bitfield.length).toBe(100);
				expect(Array.from(result.bitfield)).toEqual(bitfieldData);
			}
		});
	});

	describe("Request message", () => {
		test("parses Request with minimum values", () => {
			const payload = [
				...uint32Bytes(0), // index
				...uint32Bytes(0), // begin
				...uint32Bytes(0), // length
			];
			const data = buildMessage(PeerMessageType.Request, payload);
			const result = parsePeerMessage(data);
			expect(result).toEqual({
				type: PeerMessageType.Request,
				index: 0,
				begin: 0,
				length: 0,
			});
		});

		test("parses Request with typical values", () => {
			const payload = [
				...uint32Bytes(5), // index
				...uint32Bytes(0), // begin
				...uint32Bytes(16384), // length (16KB standard block)
			];
			const data = buildMessage(PeerMessageType.Request, payload);
			const result = parsePeerMessage(data);
			expect(result).toEqual({
				type: PeerMessageType.Request,
				index: 5,
				begin: 0,
				length: 16384,
			});
		});

		test("parses Request with max values", () => {
			const payload = [
				...uint32Bytes(0xffffffff), // max index
				...uint32Bytes(0xffffffff), // max begin
				...uint32Bytes(0xffffffff), // max length
			];
			const data = buildMessage(PeerMessageType.Request, payload);
			const result = parsePeerMessage(data);
			expect(result).toEqual({
				type: PeerMessageType.Request,
				index: 0xffffffff,
				begin: 0xffffffff,
				length: 0xffffffff,
			});
		});

		test("Request with wrong length (too short) throws", () => {
			const buffer = new Uint8Array(16);
			new DataView(buffer.buffer).setUint32(0, 12, false); // length = 12 (too short)
			buffer[4] = PeerMessageType.Request;
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid request message: expected length 13 but got 12",
			);
		});

		test("Request with wrong length (too long) throws", () => {
			const buffer = new Uint8Array(18);
			new DataView(buffer.buffer).setUint32(0, 14, false); // length = 14 (too long)
			buffer[4] = PeerMessageType.Request;
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid request message: expected length 13 but got 14",
			);
		});
	});

	describe("Piece message", () => {
		test("parses Piece with minimum payload", () => {
			const payload = [
				...uint32Bytes(0), // index
				...uint32Bytes(0), // begin
				0x01, // 1 byte block
			];
			const data = buildMessage(PeerMessageType.Piece, payload);
			const result = parsePeerMessage(data);
			expect(result.type).toBe(PeerMessageType.Piece);
			expect(result).toHaveProperty("index", 0);
			expect(result).toHaveProperty("begin", 0);
			if ("block" in result) {
				expect(result.block).toBeInstanceOf(Uint8Array);
				expect(result.block.length).toBe(1);
				expect(result.block[0]).toBe(0x01);
			}
		});

		test("parses Piece with typical block data", () => {
			const blockData = Array.from({ length: 16384 }, () => 0xab);
			const payload = [
				...uint32Bytes(3), // index
				...uint32Bytes(32768), // begin (offset into piece)
				...blockData,
			];
			const data = buildMessage(PeerMessageType.Piece, payload);
			const result = parsePeerMessage(data);
			expect(result.type).toBe(PeerMessageType.Piece);
			expect(result).toHaveProperty("index", 3);
			expect(result).toHaveProperty("begin", 32768);
			if ("block" in result) {
				expect(result.block.length).toBe(16384);
				expect(Array.from(result.block)).toEqual(blockData);
			}
		});

		test("parses Piece with max index and begin", () => {
			const payload = [
				...uint32Bytes(0xffffffff), // max index
				...uint32Bytes(0xffffffff), // max begin
				0x00,
				0x01,
				0x02, // small block
			];
			const data = buildMessage(PeerMessageType.Piece, payload);
			const result = parsePeerMessage(data);
			expect(result.type).toBe(PeerMessageType.Piece);
			expect(result).toHaveProperty("index", 0xffffffff);
			expect(result).toHaveProperty("begin", 0xffffffff);
		});

		test("Piece with length < 9 throws", () => {
			const buffer = new Uint8Array(12);
			new DataView(buffer.buffer).setUint32(0, 8, false); // length = 8 (too short, need at least 9)
			buffer[4] = PeerMessageType.Piece;
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid request message: expected length >= 9 but got 8",
			);
		});

		test("Piece with empty block (length exactly 8) throws", () => {
			const buffer = new Uint8Array(12);
			new DataView(buffer.buffer).setUint32(0, 8, false);
			buffer[4] = PeerMessageType.Piece;
			buffer[5] = 0;
			buffer[6] = 0;
			buffer[7] = 0;
			buffer[8] = 0;
			buffer[9] = 0;
			buffer[10] = 0;
			buffer[11] = 0;
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid request message: expected length >= 9 but got 8",
			);
		});

		test("Piece with length = 9 (exact minimum) works", () => {
			const payload = [
				...uint32Bytes(1), // index
				...uint32Bytes(0), // begin
				0x00, // 1 byte block
			];
			const data = buildMessage(PeerMessageType.Piece, payload);
			const result = parsePeerMessage(data);
			expect(result.type).toBe(PeerMessageType.Piece);
			if ("block" in result) {
				expect(result.block.length).toBe(1);
			}
		});
	});

	describe("Cancel message", () => {
		test("parses Cancel with minimum values", () => {
			const payload = [
				...uint32Bytes(0), // index
				...uint32Bytes(0), // begin
				...uint32Bytes(0), // length
			];
			const data = buildMessage(PeerMessageType.Cancel, payload);
			const result = parsePeerMessage(data);
			expect(result).toEqual({
				type: PeerMessageType.Cancel,
				index: 0,
				begin: 0,
				length: 0,
			});
		});

		test("parses Cancel with typical values", () => {
			const payload = [
				...uint32Bytes(7), // index
				...uint32Bytes(16384), // begin
				...uint32Bytes(32768), // length
			];
			const data = buildMessage(PeerMessageType.Cancel, payload);
			const result = parsePeerMessage(data);
			expect(result).toEqual({
				type: PeerMessageType.Cancel,
				index: 7,
				begin: 16384,
				length: 32768,
			});
		});

		test("parses Cancel with max values", () => {
			const payload = [
				...uint32Bytes(0xffffffff),
				...uint32Bytes(0xffffffff),
				...uint32Bytes(0xffffffff),
			];
			const data = buildMessage(PeerMessageType.Cancel, payload);
			const result = parsePeerMessage(data);
			expect(result).toEqual({
				type: PeerMessageType.Cancel,
				index: 0xffffffff,
				begin: 0xffffffff,
				length: 0xffffffff,
			});
		});

		test("Cancel with wrong length (too short) throws", () => {
			const buffer = new Uint8Array(16);
			new DataView(buffer.buffer).setUint32(0, 12, false);
			buffer[4] = PeerMessageType.Cancel;
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid request message: expected length 13 but got 12",
			);
		});

		test("Cancel with wrong length (too long) throws", () => {
			const buffer = new Uint8Array(18);
			new DataView(buffer.buffer).setUint32(0, 14, false);
			buffer[4] = PeerMessageType.Cancel;
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid request message: expected length 13 but got 14",
			);
		});
	});

	describe("Port message", () => {
		test("parses Port with port 0", () => {
			const data = buildMessage(PeerMessageType.Port, uint16Bytes(0));
			const result = parsePeerMessage(data);
			expect(result).toEqual({ type: PeerMessageType.Port, port: 0 });
		});

		test("parses Port with common port", () => {
			const data = buildMessage(PeerMessageType.Port, uint16Bytes(6881));
			const result = parsePeerMessage(data);
			expect(result).toEqual({ type: PeerMessageType.Port, port: 6881 });
		});

		test("parses Port with max 16-bit port", () => {
			const data = buildMessage(PeerMessageType.Port, uint16Bytes(65535));
			const result = parsePeerMessage(data);
			expect(result).toEqual({ type: PeerMessageType.Port, port: 65535 });
		});

		test("Port with wrong length (too short) throws", () => {
			const buffer = new Uint8Array(6);
			new DataView(buffer.buffer).setUint32(0, 2, false);
			buffer[4] = PeerMessageType.Port;
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid port message: expected length 3 but got 2",
			);
		});

		test("Port with wrong length (too long) throws", () => {
			// Need buffer large enough to pass general length check (4+4=8 bytes)
			// but type validation expects length 3
			const buffer = new Uint8Array(8);
			new DataView(buffer.buffer).setUint32(0, 4, false);
			buffer[4] = PeerMessageType.Port;
			buffer[5] = 0;
			buffer[6] = 0;
			buffer[7] = 0;
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid port message: expected length 3 but got 4",
			);
		});
	});

	describe("Error cases", () => {
		test("data less than 4 bytes throws", () => {
			expect(() => parsePeerMessage(new Uint8Array(0))).toThrow("Invalid message: too short");
			expect(() => parsePeerMessage(new Uint8Array([0x00]))).toThrow(
				"Invalid message: too short",
			);
			expect(() => parsePeerMessage(new Uint8Array([0x00, 0x00, 0x00]))).toThrow(
				"Invalid message: too short",
			);
		});

		test("actual data shorter than length prefix claims throws", () => {
			const buffer = new Uint8Array(7);
			new DataView(buffer.buffer).setUint32(0, 10, false); // claims length 10
			buffer[4] = PeerMessageType.Choke;
			// But only 7 bytes total, 3 after prefix
			expect(() => parsePeerMessage(buffer)).toThrow(
				"Invalid message: expected length 10 but got 3",
			);
		});

		test("unknown message type throws", () => {
			const buffer = new Uint8Array(6);
			new DataView(buffer.buffer).setUint32(0, 2, false);
			buffer[4] = 99; // Unknown type
			buffer[5] = 0;
			expect(() => parsePeerMessage(buffer)).toThrow("Unknown message type: 99");
		});

		test("edge case: message type at boundary (10)", () => {
			// Type 10 is KeepAlive, but keep-alive is handled specially with length 0
			// If length > 0 with type 10, it's treated as KeepAlive which returns early
			// Actually, KeepAlive is only returned when data.length === 4 && length === 0
			// So type 10 in the switch would hit default (unknown)
			const buffer = new Uint8Array(6);
			new DataView(buffer.buffer).setUint32(0, 2, false);
			buffer[4] = 10; // This is KeepAlive enum value but not a valid wire message type
			buffer[5] = 0;
			expect(() => parsePeerMessage(buffer)).toThrow(
				`Invalid keep-alive message: expected length 0 but got 2`,
			);
		});

		test("negative length prefix (as unsigned) interpreted correctly", () => {
			// Setting a large unsigned value that would be negative as signed
			const buffer = new Uint8Array(4);
			new DataView(buffer.buffer).setUint32(0, 0xffffffff, false); // Max uint32
			// This is a huge length claim that won't match actual data
			expect(() => parsePeerMessage(buffer)).toThrow(/Invalid message: expected length/);
		});
	});

	describe("Byte offset handling", () => {
		test("handles sliced Uint8Array correctly", () => {
			// Create a larger buffer and slice into it
			const largeBuffer = new Uint8Array(100);
			const view = new DataView(largeBuffer.buffer);

			// Write at offset 10
			view.setUint32(10, 5, false); // length = 5 (1 + 4 for Have)
			largeBuffer[14] = PeerMessageType.Have;
			view.setUint32(15, 12345, false); // piece index

			const sliced = largeBuffer.slice(10, 19); // Just the message bytes
			const result = parsePeerMessage(sliced);
			expect(result).toEqual({
				type: PeerMessageType.Have,
				index: 12345,
			});
		});

		test("handles subarray view correctly", () => {
			// Same as above but using subarray which shares buffer
			const largeBuffer = new Uint8Array(100);
			const view = new DataView(largeBuffer.buffer);

			view.setUint32(20, 1, false); // length = 1 (simple message)
			largeBuffer[24] = PeerMessageType.Interested;

			const subarray = largeBuffer.subarray(20, 25);
			const result = parsePeerMessage(subarray);
			expect(result).toEqual({ type: PeerMessageType.Interested });
		});
	});

	describe("Enum value verification", () => {
		test("PeerMessageType enum values match protocol spec", () => {
			expect(PeerMessageType.Choke).toBe(0);
			expect(PeerMessageType.Unchoke).toBe(1);
			expect(PeerMessageType.Interested).toBe(2);
			expect(PeerMessageType.NotInterested).toBe(3);
			expect(PeerMessageType.Have).toBe(4);
			expect(PeerMessageType.Bitfield).toBe(5);
			expect(PeerMessageType.Request).toBe(6);
			expect(PeerMessageType.Piece).toBe(7);
			expect(PeerMessageType.Cancel).toBe(8);
			expect(PeerMessageType.Port).toBe(9);
			expect(PeerMessageType.KeepAlive).toBe(10);
		});
	});
});
