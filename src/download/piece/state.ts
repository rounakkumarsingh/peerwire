/**
 * Piece State
 *
 * Defines state machine and types for individual pieces.
 */

import { type SHA1Hash } from "../../torrent/metadata";

export enum PieceStatus {
	Missing = "missing",
	Requested = "requested",
	Downloading = "downloading",
	Complete = "complete",
	Verified = "verified",
}

export interface Block {
	offset: number;
	length: number;
	data: Uint8Array;
	status: "missing" | "requested" | "received";
}

export class Piece {
	readonly index: number;
	readonly length: number;
	readonly expectedHash: SHA1Hash;
	readonly blocks: Block[];
	status: PieceStatus;
	corruptionCount: number;

	/**
	 * Splits the piece into blocks of (last block may be shorter).
	 * All blocks start with `status = "missing"`. Overall piece `status` starts
	 * at `Missing`.
	 */
	constructor(index: number, length: number, expectedHash: SHA1Hash, blockSize: number) {
		this.corruptionCount = 0;
		this.index = index;
		this.length = length;
		this.expectedHash = expectedHash;
		this.blocks = Array.from({ length: Math.ceil(length / blockSize) }, (_, i) => {
			const offset = i * blockSize;
			const blockLength = Math.min(blockSize, length - offset);
			return {
				offset,
				length: blockLength,
				data: new Uint8Array(0),
				status: "missing",
			};
		});
		this.status = PieceStatus.Missing;
	}

	/**
	 * Stores block data at the given offset. Marks the block `"received"`.
	 * Duplicate calls for the same offset are ignored (first write wins).
	 * Transitions piece status: `Missing` → `Downloading` on first block,
	 * and `Downloading` → `Complete` when all blocks are received.
	 */
	addBlock(offset: number, data: Uint8Array): void {
		if (this.status === PieceStatus.Missing) this.status = PieceStatus.Downloading;
		const firstBlock = this.blocks[0];
		if (!firstBlock) return;
		const blockIndex = Math.floor(offset / firstBlock.length);
		const block = this.blocks[blockIndex];
		if (block?.status === "missing") {
			block.data = data;
			block.status = "received";
		}
		if (this.isComplete()) {
			console.log("Download completed");
			this.status = PieceStatus.Complete;
		}
	}

	markBlockRequested(blockIndex: number): void {
		if (this.status === PieceStatus.Missing) this.status = PieceStatus.Requested;
		if (this.blocks[blockIndex] === undefined) {
			throw new Error("Block index out of bounds");
		}
		this.blocks[blockIndex].status = "requested" as const;
	}

	resetBlockRequest(blockIndex: number) {
		if (this.blocks[blockIndex] === undefined) {
			throw new Error("Block index out of bounds");
		}
		this.blocks[blockIndex].status = "missing" as const;
	}

	/**
	 * Returns `true` when every block has `status === "received"`.
	 */
	isComplete(): boolean {
		if (this.blocks.every((v) => v.status === "received")) {
			return true;
		}
		return false;
	}

	/**
	 * Concatenates all received block data in offset order and SHA1-hashes
	 * the result. If the digest matches `expectedHash` the piece status
	 * becomes `Verified` and the method returns `true`. On mismatch the
	 * piece status is set to `Missing` and all block data is cleared so
	 * the piece can be re-downloaded.
	 */

	verify(): boolean {
		if (this.status !== PieceStatus.Complete) {
			console.log("Verification attempted before downloading was completed.");
			return false;
		}
		const hash = new Bun.CryptoHasher("sha1");

		for (const block of this.blocks) {
			hash.update(block.data);
		}

		const generatedHash = hash.digest();

		const isValid = Buffer.from(generatedHash).equals(Buffer.from(this.expectedHash));

		if (!isValid) {
			this.corruptionCount += 1;
			this.reset();
			return false;
		}

		this.status = PieceStatus.Verified;
		return true;
	}

	/**
	 * Clears all received block data (sets `data` to `undefined` and
	 * `status` back to `"missing"`) and resets piece `status` to
	 * `Missing`. Used to retry a failed/corrupted piece.
	 */
	reset(): void {
		for (const block of this.blocks) {
			block.data = new Uint8Array(0);
			block.status = "missing";
		}
		this.status = PieceStatus.Missing;
	}

	/**
	 * Returns all blocks whose `status` is not `"received"` (i.e. blocks
	 * still waiting to be downloaded or requested).
	 */
	getMissingBlocks(): Block[] {
		return this.blocks.filter((v) => v.status !== "received");
	}
}
