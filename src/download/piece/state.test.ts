import { describe, expect, test } from "bun:test";
import { Piece, PieceStatus } from "./state";
import { type SHA1Hash } from "../../torrent/metadata";

describe("Piece", () => {
	const pieceLength = 48;
	const blockSize = 16;
	const dummyData = new Uint8Array(pieceLength).fill(0x42);
	const hasher = new Bun.CryptoHasher("sha1");
	hasher.update(dummyData);
	const expectedHash = new Uint8Array(hasher.digest()) as SHA1Hash;

	test("initializes with missing blocks", () => {
		const piece = new Piece(0, pieceLength, expectedHash, blockSize);
		expect(piece.status).toBe(PieceStatus.Missing);
		expect(piece.blocks.length).toBe(3);
		expect(piece.getMissingBlocks().length).toBe(3);
	});

	test("blocks can arrive in order", () => {
		const piece = new Piece(0, pieceLength, expectedHash, blockSize);
		piece.addBlock(0, dummyData.subarray(0, 16));
		piece.addBlock(16, dummyData.subarray(16, 32));
		piece.addBlock(32, dummyData.subarray(32, 48));

		expect(piece.isComplete()).toBe(true);
		expect(piece.status).toBe(PieceStatus.Complete);
		expect(piece.verify()).toBe(true);
		expect(piece.status).toBe(PieceStatus.Verified);
	});

	test("blocks can arrive out of order", () => {
		const piece = new Piece(0, pieceLength, expectedHash, blockSize);
		piece.addBlock(32, dummyData.subarray(32, 48));
		piece.addBlock(0, dummyData.subarray(0, 16));
		piece.addBlock(16, dummyData.subarray(16, 32));

		expect(piece.isComplete()).toBe(true);
		expect(piece.verify()).toBe(true);
	});

	test("duplicate blocks do not corrupt the piece", () => {
		const piece = new Piece(0, pieceLength, expectedHash, blockSize);
		piece.addBlock(0, dummyData.subarray(0, 16));
		piece.addBlock(0, dummyData.subarray(0, 16)); // Duplicate
		piece.addBlock(16, dummyData.subarray(16, 32));
		piece.addBlock(32, dummyData.subarray(32, 48));

		expect(piece.isComplete()).toBe(true);
		expect(piece.verify()).toBe(true);
	});

	test("missing blocks keep the piece incomplete", () => {
		const piece = new Piece(0, pieceLength, expectedHash, blockSize);
		piece.addBlock(0, dummyData.subarray(0, 16));
		piece.addBlock(32, dummyData.subarray(32, 48));

		expect(piece.isComplete()).toBe(false);
		expect(piece.status).toBe(PieceStatus.Downloading);
	});

	test("bad bytes fail verification and reset state", () => {
		const piece = new Piece(0, pieceLength, expectedHash, blockSize);
		piece.addBlock(0, dummyData.subarray(0, 16));
		piece.addBlock(16, new Uint8Array(16).fill(0xff)); // Bad data
		piece.addBlock(32, dummyData.subarray(32, 48));

		expect(piece.isComplete()).toBe(true);
		expect(piece.verify()).toBe(false);
		expect(piece.status).toBe(PieceStatus.Missing);
		expect(piece.getMissingBlocks().length).toBe(3);
	});
});
