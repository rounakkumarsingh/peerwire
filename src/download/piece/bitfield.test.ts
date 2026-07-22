import { describe, expect, test } from "bun:test";
import { BitfieldTracker } from "./bitfield";
import { createPeerId } from "../../tracker/types";

describe("BitfieldTracker", () => {
	const createPeer = (id: number) => createPeerId(new Uint8Array(20).fill(id));
	const pieceCount = 16;

	describe("constructor", () => {
		test("initializes with zero rarity counters", () => {
			const tracker = new BitfieldTracker(pieceCount);
			expect(tracker.GlobalRarityCounter.length).toBe(pieceCount);
			expect(tracker.GlobalRarityCounter.every((v) => v === 0)).toBe(true);
		});

		test("initializes empty peer maps", () => {
			const tracker = new BitfieldTracker(pieceCount);
			expect(tracker.peerBitfields.size).toBe(0);
			expect(tracker.reverseIndex.length).toBe(pieceCount);
		});
	});

	describe("hasPiece", () => {
		test("returns false for untracked peer", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			expect(tracker.hasPiece(peer, 0)).toBe(false);
		});

		test("returns true when peer has the piece", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			// Bitfield with piece 0 set: MSB of first byte = 1
			const bitfield = new Uint8Array([0x80, 0x00]);
			tracker.addPeerBitfield(peer, bitfield);
			expect(tracker.hasPiece(peer, 0)).toBe(true);
		});

		test("returns false when peer doesn't have the piece", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			const bitfield = new Uint8Array([0x80, 0x00]);
			tracker.addPeerBitfield(peer, bitfield);
			expect(tracker.hasPiece(peer, 1)).toBe(false);
		});

		test("returns false for out-of-range piece index", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			expect(tracker.hasPiece(peer, 100)).toBe(false);
		});
	});

	describe("getPiecesForPeer", () => {
		test("returns empty set for untracked peer", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const pieces = tracker.getPiecesForPeer(createPeer(1));
			expect(pieces.size).toBe(0);
		});

		test("returns correct pieces from bitfield", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			// Pieces 0 and 3 set: 10010000 = 0x90
			const bitfield = new Uint8Array([0x90, 0x00]);
			tracker.addPeerBitfield(peer, bitfield);
			const pieces = tracker.getPiecesForPeer(peer);
			expect(pieces.has(0)).toBe(true);
			expect(pieces.has(3)).toBe(true);
			expect(pieces.has(1)).toBe(false);
		});
	});

	describe("getRarestPieces", () => {
		test("returns empty array when no peers", () => {
			const tracker = new BitfieldTracker(pieceCount);
			expect(tracker.getRarestPieces()).toEqual([]);
		});

		test("returns pieces sorted by rarity", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer1 = createPeer(1);
			const peer2 = createPeer(2);

			// Peer 1 has pieces 0, 1, 2
			tracker.addPeerBitfield(peer1, new Uint8Array([0xe0, 0x00]));
			// Peer 2 has pieces 1, 2
			tracker.addPeerBitfield(peer2, new Uint8Array([0x60, 0x00]));

			const rarest = tracker.getRarestPieces();
			// Piece 0 has rarity 1, pieces 1,2 have rarity 2
			expect(rarest[0]).toBe(0);
			expect(rarest.includes(1)).toBe(true);
			expect(rarest.includes(2)).toBe(true);
		});

		test("respects maxCount parameter", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer1 = createPeer(1);
			const peer2 = createPeer(2);
			const peer3 = createPeer(3);

			tracker.addPeerBitfield(peer1, new Uint8Array([0x80, 0x00]));
			tracker.addPeerBitfield(peer2, new Uint8Array([0x40, 0x00]));
			tracker.addPeerBitfield(peer3, new Uint8Array([0x20, 0x00]));

			const rarest = tracker.getRarestPieces(2);
			expect(rarest.length).toBe(2);
		});

		test("excludes pieces with zero peers", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			tracker.addPeerBitfield(peer, new Uint8Array([0x80, 0x00]));

			const rarest = tracker.getRarestPieces();
			expect(rarest.every((p) => p === 0)).toBe(true);
		});
	});

	describe("getAvailablePieces", () => {
		test("returns empty set for untracked peer", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const available = tracker.getAvailablePieces(createPeer(1), new Set());
			expect(available.size).toBe(0);
		});

		test("returns pieces peer has that we don't", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			// Peer has pieces 0, 1, 2
			tracker.addPeerBitfield(peer, new Uint8Array([0xe0, 0x00]));

			// We already have piece 0
			const available = tracker.getAvailablePieces(peer, new Set([0]));
			expect(available.has(0)).toBe(false);
			expect(available.has(1)).toBe(true);
			expect(available.has(2)).toBe(true);
		});

		test("returns empty set when we have all peer's pieces", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			tracker.addPeerBitfield(peer, new Uint8Array([0x80, 0x00]));

			const available = tracker.getAvailablePieces(peer, new Set([0]));
			expect(available.size).toBe(0);
		});
	});

	describe("getPeerCount", () => {
		test("returns 0 initially", () => {
			const tracker = new BitfieldTracker(pieceCount);
			expect(tracker.getPeerCount()).toBe(0);
		});

		test("increments when peers are added", () => {
			const tracker = new BitfieldTracker(pieceCount);
			tracker.addPeerBitfield(createPeer(1), new Uint8Array([0x80]));
			tracker.addPeerBitfield(createPeer(2), new Uint8Array([0x40]));
			expect(tracker.getPeerCount()).toBe(2);
		});

		test("decrements when peers are removed", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer1 = createPeer(1);
			const peer2 = createPeer(2);
			tracker.addPeerBitfield(peer1, new Uint8Array([0x80]));
			tracker.addPeerBitfield(peer2, new Uint8Array([0x40]));
			tracker.removePeer(peer1);
			expect(tracker.getPeerCount()).toBe(1);
		});
	});

	describe("getTotalPieces", () => {
		test("returns the piece count from constructor", () => {
			expect(new BitfieldTracker(10).getTotalPieces()).toBe(10);
			expect(new BitfieldTracker(100).getTotalPieces()).toBe(100);
		});
	});

	describe("clear", () => {
		test("resets all state", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			tracker.addPeerBitfield(peer, new Uint8Array([0x80, 0x00]));

			tracker.clear();

			expect(tracker.getPeerCount()).toBe(0);
			expect(tracker.GlobalRarityCounter.every((v) => v === 0)).toBe(true);
			expect(tracker.getRarestPieces()).toEqual([]);
		});
	});

	describe("generateOurBitfield", () => {
		test("creates correct bitfield from piece set", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const bitfield = tracker.generateOurBitfield(new Set([0, 3]));

			// Piece 0 = bit 7 of byte 0, Piece 3 = bit 4 of byte 0
			// 10010000 = 0x90
			expect(bitfield[0]).toBe(0x90);
		});

		test("creates multi-byte bitfield", () => {
			const tracker = new BitfieldTracker(pieceCount);
			// Pieces 0 and 8
			const bitfield = tracker.generateOurBitfield(new Set([0, 8]));

			expect(bitfield.length).toBe(2);
			expect(bitfield[0]).toBe(0x80);
			expect(bitfield[1]).toBe(0x80);
		});

		test("creates empty bitfield for empty set", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const bitfield = tracker.generateOurBitfield(new Set());

			expect(bitfield.length).toBe(Math.ceil(pieceCount / 8));
			expect(bitfield.every((b) => b === 0)).toBe(true);
		});
	});

	describe("updatePeerBitfield", () => {
		test("adds peer when not previously tracked", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			tracker.updatePeerBitfield(peer, new Uint8Array([0x80, 0x00]));

			expect(tracker.getPeerCount()).toBe(1);
			expect(tracker.getRarity(0)).toBe(1);
		});

		test("increments rarity for newly acquired pieces", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			// Peer initially has piece 0
			tracker.addPeerBitfield(peer, new Uint8Array([0x80, 0x00]));
			expect(tracker.getRarity(0)).toBe(1);
			expect(tracker.getRarity(1)).toBe(0);

			// Peer now also has piece 1
			tracker.updatePeerBitfield(peer, new Uint8Array([0xc0, 0x00]));
			expect(tracker.getRarity(0)).toBe(1);
			expect(tracker.getRarity(1)).toBe(1);
		});

		test("decrements rarity for lost pieces", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			// Peer has pieces 0 and 1
			tracker.addPeerBitfield(peer, new Uint8Array([0xc0, 0x00]));
			expect(tracker.getRarity(0)).toBe(1);
			expect(tracker.getRarity(1)).toBe(1);

			// Peer loses piece 1
			tracker.updatePeerBitfield(peer, new Uint8Array([0x80, 0x00]));
			expect(tracker.getRarity(0)).toBe(1);
			expect(tracker.getRarity(1)).toBe(0);
		});

		test("updates reverse index correctly", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer1 = createPeer(1);
			const peer2 = createPeer(2);

			tracker.addPeerBitfield(peer1, new Uint8Array([0x80, 0x00]));
			tracker.addPeerBitfield(peer2, new Uint8Array([0x80, 0x00]));

			expect(tracker.getPeersWithPiece(0)!.size).toBe(2);

			// peer1 loses piece 0
			tracker.updatePeerBitfield(peer1, new Uint8Array([0x00, 0x00]));
			expect(tracker.getPeersWithPiece(0)!.size).toBe(1);
			expect(tracker.getPeersWithPiece(0)!.has(peer2)).toBe(true);
			expect(tracker.getPeersWithPiece(0)!.has(peer1)).toBe(false);
		});

		test("unchanged bytes are not processed", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			tracker.addPeerBitfield(peer, new Uint8Array([0x80, 0x00]));

			// Update with same bitfield — no changes expected
			tracker.updatePeerBitfield(peer, new Uint8Array([0x80, 0x00]));
			expect(tracker.getRarity(0)).toBe(1);
			expect(tracker.getRarity(1)).toBe(0);
		});

		test("handles multiple bit changes in single update", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			// Peer has pieces 0, 1, 2 (0xe0 = 11100000)
			tracker.addPeerBitfield(peer, new Uint8Array([0xe0, 0x00]));

			// Peer loses pieces 0, 1, 2 and gains pieces 3, 4 (0x18 = 00011000)
			tracker.updatePeerBitfield(peer, new Uint8Array([0x18, 0x00]));
			expect(tracker.getRarity(0)).toBe(0);
			expect(tracker.getRarity(1)).toBe(0);
			expect(tracker.getRarity(2)).toBe(0);
			expect(tracker.getRarity(3)).toBe(1);
			expect(tracker.getRarity(4)).toBe(1);
		});
	});

	describe("handlePeerDisconnect", () => {
		test("returns false for unknown peer", () => {
			const tracker = new BitfieldTracker(pieceCount);
			expect(tracker.handlePeerDisconnect(createPeer(1))).toBe(false);
		});

		test("returns true and removes peer", () => {
			const tracker = new BitfieldTracker(pieceCount);
			const peer = createPeer(1);
			tracker.addPeerBitfield(peer, new Uint8Array([0x80]));

			expect(tracker.handlePeerDisconnect(peer)).toBe(true);
			expect(tracker.getPeerCount()).toBe(0);
		});
	});
});
