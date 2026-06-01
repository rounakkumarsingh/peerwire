import type { SHA1Hash, TorrentMetadata } from "../torrent/metadata";
import type { TrackerPeer } from "../tracker/types";
import { toUint8Array } from "../utils/toUint8Array";

type PeerWireSocketData = { peerWire?: PeerWireCommunication };

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

// Ring buffer for accumulating TCP stream data until complete messages arrive
class ReadBuffer {
	private buffer = new Uint8Array(64 * 1024); // 64 KiB
	head = 0; // Read position
	tail = 0; // Write position
	size = 0; // Current data amount

	append(chunk: Uint8Array): void {
		const chunkLen = chunk.length;
		const capacity = this.buffer.length;

		if (chunkLen > capacity - this.size) {
			throw new Error(
				"Ring buffer overflow: chunk too large for remaining space",
			);
		}

		// Copy chunk into ring buffer, handling wrap-around
		let bytesWritten = 0;
		while (bytesWritten < chunkLen) {
			const spaceToEnd = capacity - this.tail;
			const toWrite = Math.min(chunkLen - bytesWritten, spaceToEnd);

			this.buffer.set(
				chunk.subarray(bytesWritten, bytesWritten + toWrite),
				this.tail,
			);

			this.tail = (this.tail + toWrite) % capacity;
			bytesWritten += toWrite;
		}

		this.size += chunkLen;
	}

	length(): number {
		return this.size;
	}

	// Get and remove the first n bytes
	drain(n: number): Uint8Array {
		if (n > this.size) {
			console.error(
				`Attempt to drain ${n} bytes, but only ${this.size} available`,
			);
			throw new Error("Not enough data in buffer to drain");
		}
		const result = new Uint8Array(n);
		let bytesRead = 0;
		const capacity = this.buffer.length;

		while (bytesRead < n) {
			const bytesToEnd = capacity - this.head;
			const toRead = Math.min(n - bytesRead, bytesToEnd);

			result.set(
				this.buffer.subarray(this.head, this.head + toRead),
				bytesRead,
			);

			this.head = (this.head + toRead) % capacity;
			bytesRead += toRead;
		}

		this.size -= n;
		return result;
	}
}

export class PeerWireCommunication {
	readonly peer: TrackerPeer;
	readonly infoHash: SHA1Hash;
	readonly peerId: SHA1Hash;
	readonly torrentMetadata: TorrentMetadata;
	public socket: Bun.Socket<PeerWireSocketData>;

	private readBuffer: ReadBuffer;

	private constructor(
		peer: TrackerPeer,
		infoHash: SHA1Hash,
		peerId: SHA1Hash,
		socket: Bun.Socket<PeerWireSocketData>,
		torrentMetadata: TorrentMetadata,
	) {
		this.peer = peer;
		this.infoHash = infoHash;
		this.peerId = peerId;
		this.socket = socket;
		this.torrentMetadata = torrentMetadata;
		this.readBuffer = new ReadBuffer();
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
		return {
			data(socket: Bun.Socket<PeerWireSocketData>, data: Uint8Array) {
				// TODO: Implement handshake validation logic
				// 1. Append data to buffer
				// 2. Check if we have enough bytes for handshake (HANDSHAKE_TOTAL_LEN)
				// 3. Validate protocol length, protocol string, and info hash
				// 4. If valid, transition to bitfield handler
				console.log("[Handshake Handler] Received data, length:", data.length);

				// Transition to bitfield handler when handshake complete
				// socket.reload(self.createBitfieldHandler());
			},
		};
	}

	private createBitfieldHandler() {
		return {
			data(socket: Bun.Socket<PeerWireSocketData>, data: Uint8Array) {
				// TODO: Implement bitfield handling logic
				// 1. Append data to buffer
				// 2. Parse bitfield message (length prefix + message ID + bitfield payload)
				// 3. Store peer's bitfield
				// 4. Send our bitfield
				// 5. Transition to message handler
				console.log("[Bitfield Handler] Received data, length:", data.length);

				// Transition to message handler when bitfield exchange complete
				// socket.reload(self.createMessageHandler());
			},
		};
	}

	private createMessageHandler() {
		return {
			data(socket: Bun.Socket<PeerWireSocketData>, data: Uint8Array) {
				// TODO: Implement message handling logic
				// 1. Append data to buffer
				// 2. Parse message length prefix
				// 3. Handle different message types:
				//    - 0: choke
				//    - 1: unchoke
				//    - 2: interested
				//    - 3: not interested
				//    - 4: have
				//    - 5: bitfield
				//    - 6: request
				//    - 7: piece
				//    - 8: cancel
				console.log("[Message Handler] Received data, length:", data.length);
			},
		};
	}

	static async connect(
		peer: TrackerPeer,
		infoHash: SHA1Hash,
		peerId: SHA1Hash,
		torrentMetadata: TorrentMetadata,
	): Promise<PeerWireCommunication> {
		const obj = new PeerWireCommunication(
			peer,
			infoHash,
			peerId,
			null as unknown as Bun.Socket<PeerWireSocketData>,
			torrentMetadata,
		);

		const socket = await Bun.connect<PeerWireSocketData>({
			hostname: peer.host,
			port: peer.port,
			socket: {
				binaryType: "uint8array",
				open: (socket) => {
					socket.write(PeerWireCommunication.buildHandshake(infoHash, peerId));
					console.log(
						`Handshake Initiated with peer ${peer.host}:${peer.port}`,
					);
				},
				...obj.createHandshakeHandler(),
			},
		});

		obj.socket = socket;
		socket.data = { peerWire: obj };
		return obj;
	}

	handshakePacket(): Buffer {
		return PeerWireCommunication.buildHandshake(this.infoHash, this.peerId);
	}
}
