import type { PeerId } from "../../tracker/types";

export class BitfieldTracker {
	GlobalRarityCounter: Uint32Array;
	peerBitfields: Map<PeerId, Uint8Array>;
	reverseIndex: Array<Set<PeerId>>;
	private pieceCount: number;

	constructor(pieceCount: number) {
		this.pieceCount = pieceCount;
		this.GlobalRarityCounter = new Uint32Array(pieceCount);
		this.peerBitfields = new Map<PeerId, Uint8Array>();
		this.reverseIndex = Array.from({ length: pieceCount }, () => new Set<PeerId>());
	}

	private getPiecesFromBitfield(bitfield: Uint8Array): Set<number> {
		const pieces = new Set<number>();
		for (let i = 0; i < bitfield.length; i++) {
			const byte = bitfield[i]!;
			for (let j = 0; j < 8; j++) {
				if (byte & (1 << (7 - j))) {
					pieces.add(i * 8 + j);
				}
			}
		}
		return pieces;
	}

	addPeerBitfield(peerId: PeerId, bitfield: Uint8Array) {
		const pieces = this.getPiecesFromBitfield(bitfield);
		this.peerBitfields.set(peerId, bitfield);
		for (const piece of pieces) {
			this.GlobalRarityCounter[piece]! += 1;
			this.reverseIndex[piece]?.add(peerId);
		}
	}

	updatePeerHave(peerId: PeerId, pieceIndex: number) {
		this.GlobalRarityCounter[pieceIndex]! += 1;
		this.reverseIndex[pieceIndex]?.add(peerId);
	}

	updatePeerBitfield(peerId: PeerId, bitfield: Uint8Array) {
		const oldBitfield = this.peerBitfields.get(peerId);
		if (oldBitfield === undefined) {
			this.addPeerBitfield(peerId, bitfield);
			return;
		}

		const len = Math.max(oldBitfield.length, bitfield.length);
		for (let i = 0; i < len; i++) {
			const oldByte = i < oldBitfield.length ? oldBitfield[i]! : 0;
			const newByte = i < bitfield.length ? bitfield[i]! : 0;
			const diff = oldByte ^ newByte;
			if (diff === 0) continue;

			for (let j = 0; j < 8; j++) {
				const mask = 1 << (7 - j);
				if (diff & mask) {
					const pieceIndex = i * 8 + j;
					if (pieceIndex >= this.pieceCount) continue;

					if (newByte & mask) {
						this.GlobalRarityCounter[pieceIndex]! += 1;
						this.reverseIndex[pieceIndex]!.add(peerId);
					} else {
						this.GlobalRarityCounter[pieceIndex]! -= 1;
						this.reverseIndex[pieceIndex]!.delete(peerId);
					}
				}
			}
		}

		this.peerBitfields.set(peerId, bitfield);
	}

	removePeer(peerId: PeerId) {
		const peerBitfield = this.peerBitfields.get(peerId);
		if (peerBitfield === undefined) {
			return false;
		}
		const pieces = this.getPiecesFromBitfield(peerBitfield);
		for (const piece of pieces) {
			this.GlobalRarityCounter[piece]! -= 1;
			this.reverseIndex[piece]?.delete(peerId);
		}
		this.peerBitfields.delete(peerId);
		return true;
	}

	getRarity(pieceIndex: number) {
		return this.GlobalRarityCounter[pieceIndex];
	}

	getPeersWithPiece(pieceIndex: number) {
		return this.reverseIndex[pieceIndex];
	}

	hasPiece(peerId: PeerId, pieceIndex: number): boolean {
		const bitfield = this.peerBitfields.get(peerId);
		if (bitfield === undefined) return false;
		const byteIndex = Math.floor(pieceIndex / 8);
		if (byteIndex >= bitfield.length) return false;
		const mask = 1 << (7 - (pieceIndex % 8));
		return (bitfield[byteIndex]! & mask) !== 0;
	}

	getPiecesForPeer(peerId: PeerId): Set<number> {
		const bitfield = this.peerBitfields.get(peerId);
		if (bitfield === undefined) return new Set<number>();
		return this.getPiecesFromBitfield(bitfield);
	}

	getRarestPieces(maxCount?: number): number[] {
		const pieces: { index: number; rarity: number }[] = [];
		for (let i = 0; i < this.GlobalRarityCounter.length; i++) {
			const rarity = this.GlobalRarityCounter[i]!;
			if (rarity === 0) continue;
			pieces.push({ index: i, rarity });
		}
		pieces.sort((a, b) => a.rarity - b.rarity);
		return pieces.slice(0, maxCount).map((p) => p.index);
	}

	getAvailablePieces(peerId: PeerId, ourPieces: Set<number>): Set<number> {
		const peerPieces = this.getPiecesForPeer(peerId);
		const available = new Set<number>();
		for (const piece of peerPieces) {
			if (!ourPieces.has(piece)) {
				available.add(piece);
			}
		}
		return available;
	}

	getPeerCount(): number {
		return this.peerBitfields.size;
	}

	getTotalPieces(): number {
		return this.pieceCount;
	}

	clear(): void {
		this.pieceCount = 0;
		this.GlobalRarityCounter = new Uint32Array();
		this.peerBitfields = new Map<PeerId, Uint8Array>();
		this.reverseIndex = [];
	}

	generateOurBitfield(ourPieces: Set<number>): Uint8Array {
		const byteLen = Math.ceil(this.pieceCount / 8);
		const bitfield = new Uint8Array(byteLen);
		for (const piece of ourPieces) {
			if (piece >= this.pieceCount) continue;
			const byteIndex = Math.floor(piece / 8);
			const mask = 1 << (7 - (piece % 8));
			bitfield[byteIndex]! |= mask;
		}
		return bitfield;
	}

	handlePeerDisconnect(peerId: PeerId): boolean {
		console.log("Peer disconnected:", peerId);
		const result = this.removePeer(peerId);
		console.log("Removed peer from bitfield traker:", peerId);
		return result;
	}
}
