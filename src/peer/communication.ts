import type { SHA1Hash, TorrentMetadata } from "../torrent/metadata";
import type { TrackerPeer } from "../tracker/types";
import { toUint8Array } from "../utils/toUint8Array";
import { createPeerMessage, parsePeerMessage, PeerMessageType, type PeerMessage } from "./messages";

type PeerWireSocketData = { peerWire?: PeerWireConnection };

// BitTorrent handshake constants
const HANDSHAKE_PROTOCOL_LEN = 19;
const HANDSHAKE_RESERVED_LEN = 8;
const HANDSHAKE_INFOHASH_LEN = 20;
const HANDSHAKE_PEERID_LEN = 20;
const HANDSHAKE_TOTAL_LEN =
	1 +
	HANDSHAKE_PROTOCOL_LEN +
	HANDSHAKE_RESERVED_LEN +
	HANDSHAKE_INFOHASH_LEN +
	HANDSHAKE_PEERID_LEN;

const BT_PROTOCOL_STRING = "BitTorrent protocol";

// Shared decoder for handshake protocol string parsing
const textDecoder = new TextDecoder();

// Debug logging utility - enabled only in development mode

const debug = (...args: unknown[]) => {
	if (Bun.env.NODE_ENV === "development" || process.env.NODE_ENV === "development") {
		console.log(...args);
	}
};

/**
 * Ring buffer for accumulating TCP stream data until complete messages arrive.
 *
 * This class implements a circular buffer (ring buffer) that efficiently
 * handles streaming data from TCP connections. It allows appending incoming
 * chunks of data and draining complete messages when they become available.
 *
 * The buffer has a fixed capacity of 64 KiB and throws errors if an append
 * operation would exceed available space. It handles wrap-around automatically
 * for both read and write operations.
 */
class ReadBuffer {
	/** The underlying Uint8Array storage for the ring buffer (64 KiB capacity) */
	private buffer = new Uint8Array(64 * 1024); // 64 KiB
	/** Current read position in the buffer */
	head = 0;
	/** Current write position in the buffer */
	tail = 0;
	/** Number of bytes currently stored in the buffer */
	size = 0;

	/**
	 * Appends a chunk of data to the ring buffer.
	 *
	 * The data is copied into the buffer starting at the current tail position,
	 * wrapping around to the beginning of the buffer if necessary. Throws an error
	 * if the chunk is too large to fit in the remaining available space.
	 *
	 * @param chunk - The Uint8Array data to append to the buffer
	 * @throws Error if the chunk is too large for the remaining buffer space
	 */
	append(chunk: Uint8Array): void {
		const chunkLen = chunk.length;
		const capacity = this.buffer.length;

		if (chunkLen > capacity - this.size) {
			throw new Error("Ring buffer overflow: chunk too large for remaining space");
		}

		// Copy chunk into ring buffer, handling wrap-around
		let bytesWritten = 0;
		while (bytesWritten < chunkLen) {
			const spaceToEnd = capacity - this.tail;
			const toWrite = Math.min(chunkLen - bytesWritten, spaceToEnd);

			this.buffer.set(chunk.subarray(bytesWritten, bytesWritten + toWrite), this.tail);

			this.tail = (this.tail + toWrite) % capacity;
			bytesWritten += toWrite;
		}

		this.size += chunkLen;
	}

	/**
	 * Returns the number of bytes currently stored in the buffer.
	 *
	 * @returns The current size of buffered data in bytes
	 */
	length(): number {
		return this.size;
	}

	/**
	 * Peeks at the first n bytes from the buffer without removing them.
	 *
	 * This method reads up to n bytes from the head of the buffer without
	 * modifying the buffer state. If the data wraps around the end of the
	 * underlying array, it is seamlessly reassembled into a contiguous Uint8Array.
	 *
	 * @param n - The number of bytes to peek from the buffer
	 * @returns A new Uint8Array containing the peeked bytes
	 * @throws Error if n exceeds the available data in the buffer
	 */
	peek(n: number): Uint8Array {
		if (n > this.size) {
			throw new Error("Not enough data in buffer to peek");
		}
		const result = new Uint8Array(n);
		let bytesRead = 0;
		let headPos = this.head;
		const capacity = this.buffer.length;

		while (bytesRead < n) {
			const bytesToEnd = capacity - headPos;
			const toRead = Math.min(n - bytesRead, bytesToEnd);

			result.set(this.buffer.subarray(headPos, headPos + toRead), bytesRead);

			headPos = (headPos + toRead) % capacity;
			bytesRead += toRead;
		}

		return result;
	}

	/**
	 * Removes and returns the first n bytes from the buffer.
	 *
	 * This method reads up to n bytes from the head of the buffer, removing them
	 * from the buffer. If the data wraps around the end of the underlying array,
	 * it is seamlessly reassembled into a contiguous Uint8Array.
	 *
	 * @param n - The number of bytes to drain from the buffer
	 * @returns A new Uint8Array containing the drained bytes
	 * @throws Error if n exceeds the available data in the buffer
	 */
	drain(n: number): Uint8Array {
		if (n > this.size) {
			console.error(`Attempt to drain ${n} bytes, but only ${this.size} available`);
			throw new Error("Not enough data in buffer to drain");
		}
		const result = new Uint8Array(n);
		let bytesRead = 0;
		const capacity = this.buffer.length;

		while (bytesRead < n) {
			const bytesToEnd = capacity - this.head;
			const toRead = Math.min(n - bytesRead, bytesToEnd);

			result.set(this.buffer.subarray(this.head, this.head + toRead), bytesRead);

			this.head = (this.head + toRead) % capacity;
			bytesRead += toRead;
		}

		this.size -= n;
		return result;
	}
}

export class PeerWireConnection {
	readonly peer: TrackerPeer;
	readonly infoHash: SHA1Hash;
	readonly peerId: SHA1Hash;
	readonly torrentMetadata: TorrentMetadata;
	readonly state = {
		isChokedByPeer: true,
		isInterestedInPeer: false,
		hasChokedPeer: true,
		isPeerInterestedInUs: false,
	};
	public socket: Bun.Socket<PeerWireSocketData>;
	private peerBitfield: Uint8Array;

	private readBuffer: ReadBuffer = new ReadBuffer();

	readonly handlePiece: (pieceIndex: number, pieceOffset: number, pieceData: Uint8Array) => void;
	readonly handleCancel: (pieceIndex: number, pieceOffset: number, pieceLength: number) => void;
	private constructor(
		peer: TrackerPeer,
		infoHash: SHA1Hash,
		peerId: SHA1Hash,
		socket: Bun.Socket<PeerWireSocketData>,
		torrentMetadata: TorrentMetadata,
		handlePiece: (pieceIndex: number, pieceOffset: number, pieceData: Uint8Array) => void,
		handleCancel: (pieceIndex: number, pieceOffset: number, pieceLength: number) => void,
	) {
		this.peer = peer;
		this.infoHash = infoHash;
		this.peerId = peerId;
		this.socket = socket;
		this.torrentMetadata = torrentMetadata;
		this.peerBitfield = new Uint8Array(torrentMetadata.info.pieces.length);
		this.readBuffer = new ReadBuffer();
		this.handlePiece = handlePiece;
		this.handleCancel = handleCancel;
	}

	private static buildHandshake(infoHash: SHA1Hash, peerId: SHA1Hash): Buffer {
		return Buffer.concat([
			new Uint8Array([HANDSHAKE_PROTOCOL_LEN]),
			toUint8Array(BT_PROTOCOL_STRING),
			new Uint8Array(HANDSHAKE_RESERVED_LEN),
			infoHash,
			peerId,
		]);
	}

	private createHandshakeHandler() {
		const processHandshake = (instance: PeerWireConnection) => {
			if (instance.readBuffer.length() < HANDSHAKE_TOTAL_LEN) {
				throw new Error(
					`Not enough data for handshake: ${instance.readBuffer.length()} bytes available, but ${HANDSHAKE_TOTAL_LEN} required`,
				);
			}

			const handshake = instance.readBuffer.drain(HANDSHAKE_TOTAL_LEN);
			const protocolLen = handshake[0];

			if (protocolLen !== HANDSHAKE_PROTOCOL_LEN) {
				throw new Error(
					`Invalid protocol length: ${protocolLen}, expected: ${HANDSHAKE_PROTOCOL_LEN}`,
				);
			}

			const protocolStr = textDecoder.decode(handshake.subarray(1, 1 + protocolLen));

			if (protocolStr !== BT_PROTOCOL_STRING) {
				throw new Error(
					`Invalid protocol string: "${protocolStr}", expected: "${BT_PROTOCOL_STRING}"`,
				);
			}

			const reserved = handshake.subarray(
				1 + protocolLen,
				1 + protocolLen + HANDSHAKE_RESERVED_LEN,
			);
			const receivedInfoHash = handshake.subarray(
				1 + protocolLen + HANDSHAKE_RESERVED_LEN,
				1 + protocolLen + HANDSHAKE_RESERVED_LEN + HANDSHAKE_INFOHASH_LEN,
			);
			const receivedPeerId = handshake.subarray(
				1 + protocolLen + HANDSHAKE_RESERVED_LEN + HANDSHAKE_INFOHASH_LEN,
				1 +
					protocolLen +
					HANDSHAKE_RESERVED_LEN +
					HANDSHAKE_INFOHASH_LEN +
					HANDSHAKE_PEERID_LEN,
			);

			if (!receivedInfoHash.every((byte, index) => byte === instance.infoHash[index])) {
				throw new Error("Info hash mismatch - peer doesn't have the same torrent");
			}

			debug(
				`[Handshake Handler] Handshake successful from peer ${Buffer.from(receivedPeerId).toString("hex")}`,
			);
			debug(`[Handshake Handler] Reserved bytes: ${Buffer.from(reserved).toString("hex")}`);
		};

		return {
			data(socket: Bun.Socket<PeerWireSocketData>, data: Uint8Array) {
				const instance = socket.data.peerWire;
				if (instance === undefined) {
					throw new Error("PeerWireCommunication instance not found in socket data");
				}

				try {
					instance.readBuffer.append(data);
					debug("[Handshake Handler] Received data, length:", data.length);
					if (instance.readBuffer.length() < HANDSHAKE_TOTAL_LEN) {
						return; // Wait for more data to arrive
					}
					processHandshake(instance);
					socket.reload({ socket: instance.createMessageHandler() });
				} catch (error) {
					console.error(
						"[Handshake Handler] Handshake failed:",
						error instanceof Error ? error.message : error,
					);
					socket.end();
				}
			},
		};
	}

	private processMessage(message: PeerMessage): void {
		debug("[Message Handler] Processing message:", message);
		switch (message.type) {
			case PeerMessageType.Choke:
				this.state.isChokedByPeer = true;
				break;
			case PeerMessageType.Unchoke:
				this.state.isChokedByPeer = false;
				break;

			case PeerMessageType.Interested:
				this.state.isPeerInterestedInUs = true;
				break;

			case PeerMessageType.NotInterested:
				this.state.isPeerInterestedInUs = false;
				break;

			case PeerMessageType.Have: {
				// BitTorrent bitfields are packed arrays of BITS, not bytes
				// Each byte contains 8 piece flags (MSB = piece 0 of that byte)
				const pieceIndex = message.index;
				const byteIndex = Math.floor(pieceIndex / 8);
				const bitIndex = pieceIndex % 8;
				const bitMask = 1 << (7 - bitIndex); // MSB-first order per BitTorrent spec

				if (byteIndex < this.peerBitfield.length) {
					this.peerBitfield[byteIndex]! |= bitMask;
				}
				break;
			}
			case PeerMessageType.Bitfield:
				this.peerBitfield = message.bitfield;
				break;
			case PeerMessageType.Request:
				if (!(this.state.isPeerInterestedInUs && !this.state.hasChokedPeer)) {
					debug("[Message Handler] Peer not interested or choked, ignoring request");
				}
				debug(
					"[Message Handler] Request for piece",
					message.index,
					"with length",
					message.length,
				);
				break;
			case PeerMessageType.Piece: {
				if (!(this.state.isPeerInterestedInUs && !this.state.hasChokedPeer)) {
					debug("[Message Handler] Peer not interested or choked, ignoring piece");
				}
				const pieceIndex = message.index;
				const pieceOffset = message.begin;
				const pieceData = message.block;
				this.handlePiece(pieceIndex, pieceOffset, pieceData);
				break;
			}
			case PeerMessageType.Cancel: {
				if (!(this.state.isPeerInterestedInUs && !this.state.hasChokedPeer)) {
					debug("[Message Handler] Peer not interested or choked, ignoring piece");
				}
				const pieceIndex = message.index;
				const pieceOffset = message.begin;
				const pieceLength = message.length;
				this.handleCancel(pieceIndex, pieceOffset, pieceLength);
				break;
			}
			case PeerMessageType.Port: {
				throw new Error("Not implemented yet: PeerMessageType.Port case");
			}
			case PeerMessageType.KeepAlive: {
				debug("[Message Handler] Received keep-alive message");
			}
		}
	}

	private createMessageHandler() {
		return {
			data(socket: Bun.Socket<PeerWireSocketData>, data: Uint8Array) {
				const instance = socket.data.peerWire;
				if (instance === undefined) {
					throw new Error("PeerWireCommunication instance not found in socket data");
				}

				// Append incoming data to the read buffer
				instance.readBuffer.append(data);
				debug("[Message Handler] Received data, length:", data.length);

				// Process messages while we have enough data
				// Need at least 4 bytes to read the length prefix
				if (instance.readBuffer.length() < 4) {
					return; // Wait for more data
				}

				// Peek at the length prefix without draining
				const lengthPrefix = instance.readBuffer.peek(4);
				const messageLength = new DataView(
					lengthPrefix.buffer,
					lengthPrefix.byteOffset,
					4,
				).getUint32(0, false);

				// Check if we have enough data for the complete message
				// Message = 4 bytes length prefix + messageLength bytes payload
				const totalMessageSize = 4 + messageLength;
				if (instance.readBuffer.length() < totalMessageSize) {
					return; // Wait for more data
				}

				// Drain the complete message (length prefix + payload)
				const messageBytes = instance.readBuffer.drain(totalMessageSize);

				try {
					// Parse the message using parsePeerMessage
					const parsedMessage = parsePeerMessage(messageBytes);

					// Process the parsed message
					instance.processMessage(parsedMessage);
				} catch (error) {
					console.error(
						"[Message Handler] Failed to parse message:",
						error instanceof Error ? error.message : error,
					);
					socket.end();
					return;
				}
			},
		};
	}

	static async connect(
		peer: TrackerPeer,
		infoHash: SHA1Hash,
		peerId: SHA1Hash,
		torrentMetadata: TorrentMetadata,
	): Promise<PeerWireConnection> {
		const socket = await Bun.connect<PeerWireSocketData>({
			hostname: peer.host,
			port: peer.port,
			socket: {
				binaryType: "uint8array",
				open: (socket) => {
					socket.write(PeerWireConnection.buildHandshake(infoHash, peerId));
					debug(`Handshake Initiated with peer ${peer.host}:${peer.port}`);
				},
				data: (socket, data) => {
					const instance = socket.data.peerWire;
					if (instance === undefined) {
						throw new Error("PeerWireCommunication instance not found in socket data");
					}
					// This initial handler will only process the handshake response. Once the handshake is complete, it will transition to the bitfield handler, and then to the message handler.
					instance.createHandshakeHandler().data(socket, data);
				},
			},
		});

		const instance = new PeerWireConnection(
			peer,
			infoHash,
			peerId,
			socket,
			torrentMetadata,
			() => {},
			() => {},
		);
		instance.socket.data = { peerWire: instance };
		return instance;
	}

	handshakePacket(): Buffer {
		return PeerWireConnection.buildHandshake(this.infoHash, this.peerId);
	}

	// ============================================================================
	// Outbound Message Methods
	// ============================================================================

	/**
	 * Send a choke message to the peer.
	 * Indicates we are choking them and will not respond to their requests.
	 */
	sendChoke(): void {
		const message = createPeerMessage({ type: PeerMessageType.Choke });
		this.socket.write(message);
		this.state.hasChokedPeer = true;
		debug(`[Peer ${this.peer.host}:${this.peer.port}] Sent: Choke`);
	}

	/**
	 * Send an unchoke message to the peer.
	 * Indicates we are willing to upload to them.
	 */
	sendUnchoke(): void {
		const message = createPeerMessage({ type: PeerMessageType.Unchoke });
		this.socket.write(message);
		this.state.hasChokedPeer = false;
		debug(`[Peer ${this.peer.host}:${this.peer.port}] Sent: Unchoke`);
	}

	/**
	 * Send an interested message to the peer.
	 * Indicates we want to download pieces from them.
	 */
	sendInterested(): void {
		const message = createPeerMessage({ type: PeerMessageType.Interested });
		this.socket.write(message);
		this.state.isInterestedInPeer = true;
		debug(`[Peer ${this.peer.host}:${this.peer.port}] Sent: Interested`);
	}

	/**
	 * Send a not interested message to the peer.
	 * Indicates we don't want to download from them right now.
	 */
	sendNotInterested(): void {
		const message = createPeerMessage({ type: PeerMessageType.NotInterested });
		this.socket.write(message);
		this.state.isInterestedInPeer = false;
		debug(`[Peer ${this.peer.host}:${this.peer.port}] Sent: NotInterested`);
	}

	/**
	 * Send a have message to the peer.
	 * Notifies the peer that we have completed downloading a piece.
	 *
	 * @param index - The piece index we have completed
	 */
	sendHave(index: number): void {
		const message = createPeerMessage({ type: PeerMessageType.Have, index });
		this.socket.write(message);
		debug(`[Peer ${this.peer.host}:${this.peer.port}] Sent: Have(${index})`);
	}

	/**
	 * Send our bitfield to the peer.
	 * Typically sent immediately after handshake to show which pieces we have.
	 *
	 * @param bitfield - Bitfield where each bit represents a piece (1 = have, 0 = don't have)
	 */
	sendBitfield(bitfield: Uint8Array): void {
		const message = createPeerMessage({ type: PeerMessageType.Bitfield, bitfield });
		this.socket.write(message);
		debug(
			`[Peer ${this.peer.host}:${this.peer.port}] Sent: Bitfield(${bitfield.length} bytes)`,
		);
	}

	/**
	 * Send a request message to the peer.
	 * Requests a specific block of a piece.
	 *
	 * @param index - The piece index
	 * @param begin - The byte offset within the piece
	 * @param length - The number of bytes requested (typically 16KB = 16384)
	 */
	sendRequest(index: number, begin: number, length: number): void {
		const message = createPeerMessage({
			type: PeerMessageType.Request,
			index,
			begin,
			length,
		});
		this.socket.write(message);
		debug(
			`[Peer ${this.peer.host}:${this.peer.port}] Sent: Request(piece=${index}, begin=${begin}, length=${length})`,
		);
	}

	/**
	 * Send a piece message to the peer.
	 * Used when seeding/uploading to fulfill a peer's request.
	 *
	 * @param index - The piece index
	 * @param begin - The byte offset within the piece
	 * @param block - The block data to send
	 */
	sendPiece(index: number, begin: number, block: Uint8Array): void {
		const message = createPeerMessage({
			type: PeerMessageType.Piece,
			index,
			begin,
			block,
		});
		this.socket.write(message);
		debug(
			`[Peer ${this.peer.host}:${this.peer.port}] Sent: Piece(piece=${index}, begin=${begin}, length=${block.length})`,
		);
	}

	/**
	 * Send a cancel message to the peer.
	 * Cancels a previously sent request.
	 *
	 * @param index - The piece index
	 * @param begin - The byte offset within the piece
	 * @param length - The number of bytes in the original request
	 */
	sendCancel(index: number, begin: number, length: number): void {
		const message = createPeerMessage({
			type: PeerMessageType.Cancel,
			index,
			begin,
			length,
		});
		this.socket.write(message);
		debug(
			`[Peer ${this.peer.host}:${this.peer.port}] Sent: Cancel(piece=${index}, begin=${begin}, length=${length})`,
		);
	}

	/**
	 * Send a port message to the peer.
	 * Indicates the port we're listening on for DHT/peer discovery.
	 *
	 * @param port - The listen port number
	 */
	sendPort(port: number): void {
		const message = createPeerMessage({ type: PeerMessageType.Port, port });
		this.socket.write(message);
		debug(`[Peer ${this.peer.host}:${this.peer.port}] Sent: Port(${port})`);
	}

	/**
	 * Send a keep-alive message to the peer.
	 * Keeps the connection alive when there's no other activity.
	 * Should be sent every ~2 minutes of inactivity.
	 */
	sendKeepAlive(): void {
		const message = createPeerMessage({ type: PeerMessageType.KeepAlive });
		this.socket.write(message);
		debug(`[Peer ${this.peer.host}:${this.peer.port}] Sent: KeepAlive`);
	}

	// ============================================================================
	// Peer State Query Methods
	// ============================================================================

	/**
	 * Check if the peer has a specific piece.
	 *
	 * @param pieceIndex - The piece index to check
	 * @returns true if the peer has this piece, false otherwise
	 */
	hasPiece(pieceIndex: number): boolean {
		const byteIndex = Math.floor(pieceIndex / 8);
		if (byteIndex >= this.peerBitfield.length) {
			return false;
		}
		const bitIndex = pieceIndex % 8;
		const bitMask = 1 << (7 - bitIndex);
		return (this.peerBitfield[byteIndex]! & bitMask) !== 0;
	}

	/**
	 * Get the peer's complete bitfield.
	 * Note: this is a copy - modifications won't affect the internal state.
	 */
	getPeerBitfield(): Uint8Array {
		return new Uint8Array(this.peerBitfield);
	}

	/**
	 * Close the peer connection gracefully.
	 */
	close(): void {
		this.socket.end();
		debug(`[Peer ${this.peer.host}:${this.peer.port}] Connection closed`);
	}
}
