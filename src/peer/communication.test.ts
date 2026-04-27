import { beforeEach, describe, expect, mock, test } from "bun:test";
import { PeerMessageType } from "./messages";
import { PeerWireConnection, ReadBuffer } from "./communication";
import type { TrackerPeer } from "../tracker/types";
import type { SHA1Hash, TorrentMetadata } from "../torrent/metadata";

type MockSocket = {
	write: ReturnType<typeof mock>;
	end: ReturnType<typeof mock>;
	reload: ReturnType<typeof mock>;
	data: { peerWire?: PeerWireConnection };
};

type SocketDataHandler = {
	data: (socket: MockSocket, data: Uint8Array) => void;
};

type ConnectOptions = {
	hostname: TrackerPeer["host"];
	port: TrackerPeer["port"];
	socket: {
		binaryType: "uint8array";
		open: (socket: MockSocket) => void;
		data: (socket: MockSocket, data: Uint8Array) => void;
		close?: (socket: MockSocket, error?: Error) => void;
		end?: (socket: MockSocket) => void;
		error?: (socket: MockSocket, error: Error) => void;
	};
};

const HANDSHAKE_TOTAL_LEN = 68;
const BT_PROTOCOL_STRING = "BitTorrent protocol";

function bytes(values: number[]): Uint8Array {
	return new Uint8Array(values);
}

function uint32Bytes(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function uint16Bytes(value: number): number[] {
	return [(value >>> 8) & 0xff, value & 0xff];
}

function buildMessage(type: number, payload: number[] | Uint8Array = []): Uint8Array {
	const payloadBytes = payload instanceof Uint8Array ? payload : bytes(payload);
	const length = 1 + payloadBytes.length;
	const buffer = new Uint8Array(4 + length);
	const view = new DataView(buffer.buffer);
	view.setUint32(0, length, false);
	buffer[4] = type;
	buffer.set(payloadBytes, 5);
	return buffer;
}

function buildKeepAlive(): Uint8Array {
	const buffer = new Uint8Array(4);
	new DataView(buffer.buffer).setUint32(0, 0, false);
	return buffer;
}

function buildPieceMessage(
	index: number,
	begin: number,
	blockData: number[] | Uint8Array,
): Uint8Array {
	const block = blockData instanceof Uint8Array ? blockData : bytes(blockData);
	const payload = bytes([...uint32Bytes(index), ...uint32Bytes(begin), ...Array.from(block)]);
	return buildMessage(PeerMessageType.Piece, payload);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

function makeHash(seed: number): SHA1Hash {
	return Uint8Array.from({ length: 20 }, (_, index) => (seed + index) & 0xff) as SHA1Hash;
}

function makePeer(): TrackerPeer {
	return {
		host: "127.0.0.1" as TrackerPeer["host"],
		port: 6881 as TrackerPeer["port"],
	};
}

function makeMetadata(pieceCount = 32): TorrentMetadata {
	return {
		infoHash: makeHash(1),
		announce: new URL("http://tracker.example/announce") as TorrentMetadata["announce"],
		info: {
			name: "test.bin",
			length: pieceCount * 16,
			pieceLength: 16 as TorrentMetadata["info"]["pieceLength"],
			pieces: Array.from({ length: pieceCount }, (_, index) => makeHash(index)),
		},
	};
}

function makeSocket(writes: Uint8Array[] = []): MockSocket {
	return {
		write: mock((data: Uint8Array) => {
			writes.push(data);
		}),
		end: mock(() => {}),
		reload: mock(() => {}),
		data: {},
	};
}

function makeConnection(
	options: {
		socket?: MockSocket;
		metadata?: TorrentMetadata;
		handlePiece?: (pieceIndex: number, pieceOffset: number, pieceData: Uint8Array) => void;
		handleCancel?: (pieceIndex: number, pieceOffset: number, pieceLength: number) => void;
	} = {},
): PeerWireConnection {
	const socket = options.socket ?? makeSocket();
	const metadata = options.metadata ?? makeMetadata();
	const Ctor = PeerWireConnection as unknown as new (
		peer: TrackerPeer,
		infoHash: SHA1Hash,
		peerId: SHA1Hash,
		socket: MockSocket,
		torrentMetadata: TorrentMetadata,
		handlePiece: (pieceIndex: number, pieceOffset: number, pieceData: Uint8Array) => void,
		handleCancel: (pieceIndex: number, pieceOffset: number, pieceLength: number) => void,
	) => PeerWireConnection;
	const connection = new Ctor(
		makePeer(),
		metadata.infoHash,
		makeHash(100),
		socket,
		metadata,
		options.handlePiece ?? (() => {}),
		options.handleCancel ?? (() => {}),
	);
	socket.data.peerWire = connection;
	return connection;
}

function feedMessage(connection: PeerWireConnection, data: Uint8Array): void {
	(connection as unknown as { createMessageHandler: () => SocketDataHandler })
		.createMessageHandler()
		.data(connection.socket as unknown as MockSocket, data);
}

function expectWritten(writes: Uint8Array[], expected: Uint8Array): void {
	expect(writes.length).toBe(1);
	expect(Array.from(writes[0]!)).toEqual(Array.from(expected));
}

describe("ReadBuffer", () => {
	test("append/drain roundtrip", () => {
		const buffer = new ReadBuffer();
		buffer.append(bytes([1, 2, 3, 4]));

		expect(buffer.length()).toBe(4);
		expect(Array.from(buffer.drain(4))).toEqual([1, 2, 3, 4]);
		expect(buffer.length()).toBe(0);
	});

	test("wraps around at buffer boundary", () => {
		const buffer = new ReadBuffer();
		const first = Uint8Array.from({ length: 65530 }, (_, index) => index & 0xff);
		const second = Uint8Array.from({ length: 20 }, (_, index) => 200 + index);

		buffer.append(first);
		expect(buffer.drain(65520).length).toBe(65520);
		buffer.append(second);

		const drained = buffer.drain(30);
		expect(Array.from(drained.slice(0, 10))).toEqual(Array.from(first.slice(65520)));
		expect(Array.from(drained.slice(10))).toEqual(Array.from(second));
	});

	test("peek does not drain data", () => {
		const buffer = new ReadBuffer();
		buffer.append(bytes([9, 8, 7, 6]));

		expect(Array.from(buffer.peek(2))).toEqual([9, 8]);
		expect(buffer.length()).toBe(4);
		expect(Array.from(buffer.drain(4))).toEqual([9, 8, 7, 6]);
	});

	test("throws on overflow", () => {
		const buffer = new ReadBuffer();
		buffer.append(new Uint8Array(65536));

		expect(() => buffer.append(bytes([1]))).toThrow("Ring buffer overflow");
	});

	test("throws on underflow", () => {
		const buffer = new ReadBuffer();
		buffer.append(bytes([1, 2, 3]));

		expect(() => buffer.drain(4)).toThrow("Not enough data in buffer to drain");
		expect(() => buffer.peek(4)).toThrow("Not enough data in buffer to peek");
	});

	test("handles multiple small appends followed by one large drain", () => {
		const buffer = new ReadBuffer();
		for (let i = 0; i < 100; i++) {
			buffer.append(bytes([i, i + 1]));
		}

		expect(buffer.length()).toBe(200);
		expect(Array.from(buffer.drain(6))).toEqual([0, 1, 1, 2, 2, 3]);
		expect(buffer.length()).toBe(194);
	});

	test("handles a large append spanning the wrap boundary", () => {
		const buffer = new ReadBuffer();
		const prefix = new Uint8Array(65500);
		const wrapped = Uint8Array.from({ length: 64 }, (_, index) => (index * 3) & 0xff);

		buffer.append(prefix);
		buffer.drain(65480);
		buffer.append(wrapped);

		const drained = buffer.drain(84);
		expect(Array.from(drained.slice(20))).toEqual(Array.from(wrapped));
	});

	test("handles exact buffer capacity with wrap-around", () => {
		const buffer = new ReadBuffer();
		const first = new Uint8Array(65530);
		const second = new Uint8Array(10);

		buffer.append(first);
		buffer.drain(65520);
		buffer.append(second);

		const drained = buffer.drain(20);
		expect(drained.length).toBe(20);
		expect(Array.from(drained.slice(10))).toEqual(Array.from(second));
	});
});

describe("PeerWireConnection", () => {
	let writes: Uint8Array[];
	let socket: MockSocket;
	let connection: PeerWireConnection;

	beforeEach(() => {
		writes = [];
		socket = makeSocket(writes);
		connection = makeConnection({ socket });
	});

	describe("connect", () => {
		test("connect establishes TCP connection and initiates handshake", async () => {
			const originalConnect = Bun.connect;
			const mockSocket = makeSocket(writes);
			let connectOptions: ConnectOptions | undefined;
			const connectMock = mock((options: ConnectOptions) => {
				connectOptions = options;
				return Promise.resolve(mockSocket);
			});

			(Bun as unknown as { connect: typeof connectMock }).connect = connectMock;
			try {
				const metadata = makeMetadata();
				const peer = makePeer();
				const infoHash = metadata.infoHash;
				const peerId = makeHash(120);

				const connected = await PeerWireConnection.connect(
					peer,
					infoHash,
					peerId,
					metadata,
				);

				expect(connectMock).toHaveBeenCalledTimes(1);
				expect(connectOptions?.hostname).toBe(peer.host);
				expect(connectOptions?.port).toBe(peer.port);
				expect(connectOptions?.socket.binaryType).toBe("uint8array");
				expect(typeof connectOptions?.socket.open).toBe("function");
				expect(typeof connectOptions?.socket.data).toBe("function");
				expect(mockSocket.data.peerWire).toBe(connected);

				connectOptions?.socket.open(mockSocket);
				expectWritten(writes, connected.handshakePacket());
			} finally {
				(Bun as unknown as { connect: typeof originalConnect }).connect = originalConnect;
			}
		});

		test("connect socket data handler processes handshake responses", async () => {
			const originalConnect = Bun.connect;
			const mockSocket = makeSocket(writes);
			let connectOptions: ConnectOptions | undefined;
			const connectMock = mock((options: ConnectOptions) => {
				connectOptions = options;
				return Promise.resolve(mockSocket);
			});

			(Bun as unknown as { connect: typeof connectMock }).connect = connectMock;
			try {
				const metadata = makeMetadata();
				const connected = await PeerWireConnection.connect(
					makePeer(),
					metadata.infoHash,
					makeHash(130),
					metadata,
				);

				connectOptions?.socket.data(mockSocket, connected.handshakePacket());

				expect(mockSocket.reload).toHaveBeenCalledTimes(1);
				expect(mockSocket.end).not.toHaveBeenCalled();
			} finally {
				(Bun as unknown as { connect: typeof originalConnect }).connect = originalConnect;
			}
		});

		test("connect rejects on connection failure", async () => {
			const originalConnect = Bun.connect;
			const connectMock = mock(() => Promise.reject(new Error("Connection refused")));

			(Bun as unknown as { connect: typeof connectMock }).connect = connectMock;
			try {
				const metadata = makeMetadata();
				try {
					await PeerWireConnection.connect(
						makePeer(),
						metadata.infoHash,
						makeHash(1),
						metadata,
					);
					throw new Error("Expected connect to reject");
				} catch (error) {
					if (!(error instanceof Error)) {
						throw error;
					}
					expect(error.message).toBe("Connection refused");
				}
			} finally {
				(Bun as unknown as { connect: typeof originalConnect }).connect = originalConnect;
			}
		});

		test("connect accepts and uses custom callbacks", async () => {
			const originalConnect = Bun.connect;
			const mockSocket = makeSocket(writes);
			const handlePiece = mock(() => {});
			const handleCancel = mock(() => {});
			const connectMock = mock((_options: ConnectOptions) => {
				return Promise.resolve(mockSocket);
			});

			(Bun as unknown as { connect: typeof connectMock }).connect = connectMock;
			try {
				const metadata = makeMetadata();
				const connected = await PeerWireConnection.connect(
					makePeer(),
					metadata.infoHash,
					makeHash(140),
					metadata,
					handlePiece,
					handleCancel,
				);
				connected.state.hasChokedPeer = false;
				connected.state.isPeerInterestedInUs = true;

				feedMessage(connected, buildPieceMessage(6, 4096, bytes([0xaa, 0xbb])));
				feedMessage(
					connected,
					buildMessage(PeerMessageType.Cancel, [
						...uint32Bytes(6),
						...uint32Bytes(4096),
						...uint32Bytes(16384),
					]),
				);

				expect(handlePiece).toHaveBeenCalledWith(6, 4096, bytes([0xaa, 0xbb]));
				expect(handleCancel).toHaveBeenCalledWith(6, 4096, 16384);
			} finally {
				(Bun as unknown as { connect: typeof originalConnect }).connect = originalConnect;
			}
		});

		test("emits close event when peer disconnects", async () => {
			const originalConnect = Bun.connect;
			const mockSocket = makeSocket(writes);
			let connectOptions: ConnectOptions | undefined;
			const connectMock = mock((options: ConnectOptions) => {
				connectOptions = options;
				return Promise.resolve(mockSocket);
			});

			(Bun as unknown as { connect: typeof connectMock }).connect = connectMock;
			try {
				const metadata = makeMetadata();
				const connected = await PeerWireConnection.connect(
					makePeer(),
					metadata.infoHash,
					makeHash(150),
					metadata,
				);
				const onClose = mock(() => {});

				connected.on("close", onClose);
				expect(connected.isClosed).toBe(false);

				connectOptions?.socket.end?.(mockSocket);

				expect(connected.isClosed).toBe(true);
				expect(onClose).toHaveBeenCalledTimes(1);
			} finally {
				(Bun as unknown as { connect: typeof originalConnect }).connect = originalConnect;
			}
		});

		test("emits close event with error when socket close reports one", async () => {
			const originalConnect = Bun.connect;
			const mockSocket = makeSocket(writes);
			let connectOptions: ConnectOptions | undefined;
			const connectMock = mock((options: ConnectOptions) => {
				connectOptions = options;
				return Promise.resolve(mockSocket);
			});

			(Bun as unknown as { connect: typeof connectMock }).connect = connectMock;
			try {
				const metadata = makeMetadata();
				const connected = await PeerWireConnection.connect(
					makePeer(),
					metadata.infoHash,
					makeHash(151),
					metadata,
				);
				const onClose = mock(() => {});
				const closeError = new Error("Remote reset");

				connected.on("close", onClose);
				connectOptions?.socket.close?.(mockSocket, closeError);

				expect(connected.isClosed).toBe(true);
				expect(onClose).toHaveBeenCalledWith(closeError);
			} finally {
				(Bun as unknown as { connect: typeof originalConnect }).connect = originalConnect;
			}
		});

		test("emits error event and marks closed when socket errors", async () => {
			const originalConnect = Bun.connect;
			const mockSocket = makeSocket(writes);
			let connectOptions: ConnectOptions | undefined;
			const connectMock = mock((options: ConnectOptions) => {
				connectOptions = options;
				return Promise.resolve(mockSocket);
			});

			(Bun as unknown as { connect: typeof connectMock }).connect = connectMock;
			try {
				const metadata = makeMetadata();
				const connected = await PeerWireConnection.connect(
					makePeer(),
					metadata.infoHash,
					makeHash(152),
					metadata,
				);
				const onError = mock(() => {});
				const onClose = mock(() => {});
				const socketError = new Error("ECONNRESET");

				connected.on("error", onError);
				connected.on("close", onClose);
				connectOptions?.socket.error?.(mockSocket, socketError);

				expect(connected.isClosed).toBe(true);
				expect(onError).toHaveBeenCalledWith(socketError);
				expect(onClose).toHaveBeenCalledWith(socketError);
			} finally {
				(Bun as unknown as { connect: typeof originalConnect }).connect = originalConnect;
			}
		});
	});

	describe("handshake", () => {
		test("builds a correct 68-byte handshake packet", () => {
			const handshake = connection.handshakePacket();

			expect(handshake.length).toBe(HANDSHAKE_TOTAL_LEN);
			expect(handshake[0]).toBe(19);
			expect(new TextDecoder().decode(handshake.subarray(1, 20))).toBe(BT_PROTOCOL_STRING);
			expect(Array.from(handshake.subarray(20, 28))).toEqual(
				Array.from({ length: 8 }, () => 0),
			);
			expect(Array.from(handshake.subarray(28, 48))).toEqual(Array.from(connection.infoHash));
			expect(Array.from(handshake.subarray(48, 68))).toEqual(Array.from(connection.peerId));
		});

		test("processes a valid fragmented handshake and reloads to message handler", () => {
			const handler = (
				connection as unknown as { createHandshakeHandler: () => SocketDataHandler }
			).createHandshakeHandler();
			const handshake = connection.handshakePacket();

			handler.data(socket, handshake.subarray(0, 10));
			expect(socket.reload).not.toHaveBeenCalled();
			handler.data(socket, handshake.subarray(10));

			expect(socket.reload).toHaveBeenCalledTimes(1);
			expect(socket.end).not.toHaveBeenCalled();
		});

		test("ends the socket for an invalid handshake info hash", () => {
			const handler = (
				connection as unknown as { createHandshakeHandler: () => SocketDataHandler }
			).createHandshakeHandler();
			const handshake = new Uint8Array(connection.handshakePacket());
			handshake[28] = handshake[28]! ^ 0xff;

			handler.data(socket, handshake);

			expect(socket.end).toHaveBeenCalledTimes(1);
			expect(socket.reload).not.toHaveBeenCalled();
		});

		test("invalid protocol string ends socket", () => {
			const handler = (
				connection as unknown as { createHandshakeHandler: () => SocketDataHandler }
			).createHandshakeHandler();
			const handshake = new Uint8Array(connection.handshakePacket());
			handshake.set(new TextEncoder().encode("NotTorrent protocol"), 1);

			handler.data(socket, handshake);

			expect(socket.end).toHaveBeenCalledTimes(1);
			expect(socket.reload).not.toHaveBeenCalled();
		});

		test("invalid protocol length ends socket", () => {
			const handler = (
				connection as unknown as { createHandshakeHandler: () => SocketDataHandler }
			).createHandshakeHandler();
			const handshake = new Uint8Array(connection.handshakePacket());
			handshake[0] = 18;

			handler.data(socket, handshake);

			expect(socket.end).toHaveBeenCalledTimes(1);
			expect(socket.reload).not.toHaveBeenCalled();
		});

		test("nonzero reserved bytes are accepted and logged only", () => {
			const handler = (
				connection as unknown as { createHandshakeHandler: () => SocketDataHandler }
			).createHandshakeHandler();
			const handshake = new Uint8Array(connection.handshakePacket());
			handshake.set(bytes([1, 2, 3, 4, 5, 6, 7, 8]), 20);

			handler.data(socket, handshake);

			expect(socket.reload).toHaveBeenCalledTimes(1);
			expect(socket.end).not.toHaveBeenCalled();
		});
	});

	describe("message handling", () => {
		test("accumulates a length prefix split across socket events", () => {
			const interested = buildMessage(PeerMessageType.Interested);

			feedMessage(connection, interested.subarray(0, 2));
			expect(connection.state.isPeerInterestedInUs).toBe(false);
			feedMessage(connection, interested.subarray(2, 4));
			expect(connection.state.isPeerInterestedInUs).toBe(false);
			feedMessage(connection, interested.subarray(4));

			expect(connection.state.isPeerInterestedInUs).toBe(true);
		});

		test("processes multiple complete messages from one data chunk", () => {
			const chunk = concatBytes(
				buildMessage(PeerMessageType.Unchoke),
				buildMessage(PeerMessageType.Interested),
			);

			feedMessage(connection, chunk);

			expect(connection.state.isChokedByPeer).toBe(false);
			expect(connection.state.isPeerInterestedInUs).toBe(true);
		});

		test("processes multiple partial messages across data events", () => {
			const chunk = concatBytes(
				buildMessage(PeerMessageType.Unchoke),
				buildMessage(PeerMessageType.Interested),
				buildMessage(PeerMessageType.NotInterested),
			);

			feedMessage(connection, chunk.subarray(0, 7));
			expect(connection.state.isChokedByPeer).toBe(false);
			expect(connection.state.isPeerInterestedInUs).toBe(false);

			feedMessage(connection, chunk.subarray(7, 12));
			expect(connection.state.isPeerInterestedInUs).toBe(true);

			feedMessage(connection, chunk.subarray(12));
			expect(connection.state.isPeerInterestedInUs).toBe(false);
		});

		test("waits for a complete length-prefixed message before processing it", () => {
			const unchoke = buildMessage(PeerMessageType.Unchoke);

			feedMessage(connection, unchoke.subarray(0, 2));
			expect(connection.state.isChokedByPeer).toBe(true);

			feedMessage(connection, unchoke.subarray(2));
			expect(connection.state.isChokedByPeer).toBe(false);
		});

		test("choke and unchoke update choked state", () => {
			feedMessage(connection, buildMessage(PeerMessageType.Unchoke));
			expect(connection.state.isChokedByPeer).toBe(false);

			feedMessage(connection, buildMessage(PeerMessageType.Choke));
			expect(connection.state.isChokedByPeer).toBe(true);
		});

		test("interested and not_interested update peer interest state", () => {
			feedMessage(connection, buildMessage(PeerMessageType.Interested));
			expect(connection.state.isPeerInterestedInUs).toBe(true);

			feedMessage(connection, buildMessage(PeerMessageType.NotInterested));
			expect(connection.state.isPeerInterestedInUs).toBe(false);
		});

		test("have sets the correct packed bit in the peer bitfield", () => {
			feedMessage(connection, buildMessage(PeerMessageType.Have, uint32Bytes(9)));

			expect(connection.hasPiece(9)).toBe(true);
			expect(connection.hasPiece(1)).toBe(false);
			expect(Array.from(connection.getPeerBitfield().slice(0, 2))).toEqual([0x00, 0x40]);
		});

		test("bitfield replaces the entire peer bitfield", () => {
			feedMessage(connection, buildMessage(PeerMessageType.Have, uint32Bytes(0)));
			feedMessage(connection, buildMessage(PeerMessageType.Bitfield, [0xa0, 0x01]));

			expect(Array.from(connection.getPeerBitfield())).toEqual([0xa0, 0x01]);
			expect(connection.hasPiece(0)).toBe(true);
			expect(connection.hasPiece(2)).toBe(true);
			expect(connection.hasPiece(15)).toBe(true);
			expect(connection.hasPiece(1)).toBe(false);
		});

		test("piece calls the handlePiece callback", () => {
			const handlePiece = mock(() => {});
			connection = makeConnection({ socket, handlePiece });
			connection.state.hasChokedPeer = false;
			connection.state.isPeerInterestedInUs = true;
			const block = bytes([0xde, 0xad, 0xbe, 0xef]);

			feedMessage(connection, buildPieceMessage(3, 4096, block));

			expect(handlePiece).toHaveBeenCalledTimes(1);
			expect(handlePiece).toHaveBeenCalledWith(3, 4096, block);
		});

		test("piece callback is NOT invoked when peer is choked", () => {
			const handlePiece = mock(() => {});
			connection = makeConnection({ socket, handlePiece });
			connection.state.hasChokedPeer = true;
			connection.state.isPeerInterestedInUs = true;

			feedMessage(connection, buildPieceMessage(0, 0, bytes([0xde, 0xad, 0xbe, 0xef])));

			expect(handlePiece).not.toHaveBeenCalled();
			expect(socket.end).not.toHaveBeenCalled();
		});

		test("request messages parse without closing the socket", () => {
			connection.state.hasChokedPeer = false;
			connection.state.isPeerInterestedInUs = true;
			const payload = [...uint32Bytes(2), ...uint32Bytes(1024), ...uint32Bytes(16384)];

			feedMessage(connection, buildMessage(PeerMessageType.Request, payload));

			expect(socket.end).not.toHaveBeenCalled();
		});

		test("cancel calls the handleCancel callback", () => {
			const handleCancel = mock(() => {});
			connection = makeConnection({ socket, handleCancel });
			connection.state.hasChokedPeer = false;
			connection.state.isPeerInterestedInUs = true;
			const payload = [...uint32Bytes(4), ...uint32Bytes(2048), ...uint32Bytes(8192)];

			feedMessage(connection, buildMessage(PeerMessageType.Cancel, payload));

			expect(handleCancel).toHaveBeenCalledTimes(1);
			expect(handleCancel).toHaveBeenCalledWith(4, 2048, 8192);
		});

		test("socket ends when handlePiece callback throws", () => {
			const handlePiece = mock(() => {
				throw new Error("Disk full");
			});
			connection = makeConnection({ socket, handlePiece });
			connection.state.hasChokedPeer = false;
			connection.state.isPeerInterestedInUs = true;

			feedMessage(connection, buildPieceMessage(0, 0, bytes([0xde, 0xad])));

			expect(socket.end).toHaveBeenCalledTimes(1);
		});

		test("socket ends when handleCancel callback throws", () => {
			const handleCancel = mock(() => {
				throw new Error("Invalid cancel");
			});
			connection = makeConnection({ socket, handleCancel });
			connection.state.hasChokedPeer = false;
			connection.state.isPeerInterestedInUs = true;
			const payload = [...uint32Bytes(0), ...uint32Bytes(0), ...uint32Bytes(16384)];

			feedMessage(connection, buildMessage(PeerMessageType.Cancel, payload));

			expect(socket.end).toHaveBeenCalledTimes(1);
		});

		test("keep-alive messages are accepted without changing state", () => {
			feedMessage(connection, buildKeepAlive());

			expect(connection.state).toEqual({
				isChokedByPeer: true,
				isInterestedInPeer: false,
				hasChokedPeer: true,
				isPeerInterestedInUs: false,
			});
			expect(socket.end).not.toHaveBeenCalled();
		});

		test("malformed and unknown messages end the socket", () => {
			feedMessage(connection, buildMessage(99, [0]));

			expect(socket.end).toHaveBeenCalledTimes(1);
		});

		test("malformed message closes socket", () => {
			const invalidChoke = bytes([0, 0, 0, 2, PeerMessageType.Choke, 0]);

			feedMessage(connection, invalidChoke);

			expect(socket.end).toHaveBeenCalledTimes(1);
		});

		test("port message throws unimplemented error and closes socket", () => {
			feedMessage(connection, buildMessage(PeerMessageType.Port, uint16Bytes(6881)));

			expect(socket.end).toHaveBeenCalledTimes(1);
		});

		test("request is actually ignored when peer is choked or not interested", () => {
			connection.state.hasChokedPeer = true;
			connection.state.isPeerInterestedInUs = false;
			const payload = [...uint32Bytes(2), ...uint32Bytes(1024), ...uint32Bytes(16384)];

			feedMessage(connection, buildMessage(PeerMessageType.Request, payload));

			expect(socket.end).not.toHaveBeenCalled();
			expect(connection.state.hasChokedPeer).toBe(true);
			expect(connection.state.isPeerInterestedInUs).toBe(false);
		});

		test("closes socket on excessive length prefix", () => {
			const evilMessage = bytes([0xff, 0xff, 0xff, 0xff]);

			feedMessage(connection, evilMessage);

			expect(socket.end).toHaveBeenCalledTimes(1);
		});
	});

	describe("outbound messages", () => {
		test("sendChoke writes <len=1><id=0> and updates state", () => {
			connection.sendChoke();

			expectWritten(writes, bytes([0, 0, 0, 1, PeerMessageType.Choke]));
			expect(connection.state.hasChokedPeer).toBe(true);
		});

		test("sendUnchoke writes <len=1><id=1> and updates state", () => {
			connection.sendUnchoke();

			expectWritten(writes, bytes([0, 0, 0, 1, PeerMessageType.Unchoke]));
			expect(connection.state.hasChokedPeer).toBe(false);
		});

		test("sendInterested writes <len=1><id=2> and updates state", () => {
			connection.sendInterested();

			expectWritten(writes, bytes([0, 0, 0, 1, PeerMessageType.Interested]));
			expect(connection.state.isInterestedInPeer).toBe(true);
		});

		test("sendNotInterested writes <len=1><id=3> and updates state", () => {
			connection.sendInterested();
			writes = [];
			socket.write = mock((data: Uint8Array) => {
				writes.push(data);
			});

			connection.sendNotInterested();

			expectWritten(writes, bytes([0, 0, 0, 1, PeerMessageType.NotInterested]));
			expect(connection.state.isInterestedInPeer).toBe(false);
		});

		test("sendHave writes <len=5><id=4><piece_index>", () => {
			connection.sendHave(258);

			expectWritten(writes, bytes([0, 0, 0, 5, PeerMessageType.Have, 0, 0, 1, 2]));
		});

		test("sendBitfield writes <len=1+N><id=5><bitfield>", () => {
			connection.sendBitfield(bytes([0x80, 0x01]));

			expectWritten(writes, bytes([0, 0, 0, 3, PeerMessageType.Bitfield, 0x80, 0x01]));
		});

		test("sendRequest writes <len=13><id=6><index><begin><length>", () => {
			connection.sendRequest(1, 16384, 32768);

			expectWritten(
				writes,
				bytes([
					0,
					0,
					0,
					13,
					PeerMessageType.Request,
					...uint32Bytes(1),
					...uint32Bytes(16384),
					...uint32Bytes(32768),
				]),
			);
		});

		test("sendPiece writes <len=9+N><id=7><index><begin><block>", () => {
			connection.sendPiece(2, 4096, bytes([1, 2, 3]));

			expectWritten(
				writes,
				bytes([
					0,
					0,
					0,
					12,
					PeerMessageType.Piece,
					...uint32Bytes(2),
					...uint32Bytes(4096),
					1,
					2,
					3,
				]),
			);
		});

		test("sendCancel writes <len=13><id=8><index><begin><length>", () => {
			connection.sendCancel(3, 8192, 16384);

			expectWritten(
				writes,
				bytes([
					0,
					0,
					0,
					13,
					PeerMessageType.Cancel,
					...uint32Bytes(3),
					...uint32Bytes(8192),
					...uint32Bytes(16384),
				]),
			);
		});

		test("sendPort writes <len=3><id=9><port>", () => {
			connection.sendPort(6881);

			expectWritten(writes, bytes([0, 0, 0, 3, PeerMessageType.Port, ...uint16Bytes(6881)]));
		});

		test("sendKeepAlive writes a zero length prefix", () => {
			connection.sendKeepAlive();

			expectWritten(writes, bytes([0, 0, 0, 0]));
		});

		test("send methods throw on socket write failure", () => {
			socket.write = mock(() => {
				throw new Error("Socket closed");
			});

			expect(() => connection.sendChoke()).toThrow("Socket closed");
			expect(() => connection.sendRequest(0, 0, 16384)).toThrow("Socket closed");
		});

		test("close ends the socket", () => {
			connection.close();

			expect(socket.end).toHaveBeenCalledTimes(1);
		});
	});

	describe("state tracking", () => {
		test("tracks outbound and inbound state changes together", () => {
			connection.sendInterested();
			connection.sendUnchoke();
			feedMessage(connection, buildMessage(PeerMessageType.Unchoke));
			feedMessage(connection, buildMessage(PeerMessageType.Interested));

			expect(connection.state).toEqual({
				isChokedByPeer: false,
				isInterestedInPeer: true,
				hasChokedPeer: false,
				isPeerInterestedInUs: true,
			});
		});

		test("hasPiece returns correct values after bitfield and have messages", () => {
			feedMessage(connection, buildMessage(PeerMessageType.Bitfield, [0x80]));
			feedMessage(connection, buildMessage(PeerMessageType.Have, uint32Bytes(7)));

			expect(connection.hasPiece(0)).toBe(true);
			expect(connection.hasPiece(7)).toBe(true);
			expect(connection.hasPiece(8)).toBe(false);
			expect(connection.hasPiece(10_000)).toBe(false);
		});

		test("hasPiece handles byte boundary piece indexes", () => {
			const boundaryConnection = makeConnection({
				socket,
				metadata: makeMetadata(1),
			});
			feedMessage(boundaryConnection, buildMessage(PeerMessageType.Have, uint32Bytes(7)));
			feedMessage(boundaryConnection, buildMessage(PeerMessageType.Have, uint32Bytes(8)));

			expect(boundaryConnection.hasPiece(7)).toBe(true);
			expect(boundaryConnection.hasPiece(8)).toBe(false);
			expect(boundaryConnection.hasPiece(0)).toBe(false);
		});

		test("hasPiece correctly handles all 8 bit positions", () => {
			for (let bit = 0; bit < 8; bit++) {
				const testConnection = makeConnection({ metadata: makeMetadata(1) });
				feedMessage(testConnection, buildMessage(PeerMessageType.Have, uint32Bytes(bit)));

				for (let check = 0; check < 8; check++) {
					expect(testConnection.hasPiece(check)).toBe(check === bit);
				}
			}
		});

		test("hasPiece returns false for out-of-range piece indexes", () => {
			feedMessage(connection, buildMessage(PeerMessageType.Have, uint32Bytes(1000)));

			expect(connection.hasPiece(1000)).toBe(false);
			expect(connection.hasPiece(-1)).toBe(false);
			expect(socket.end).not.toHaveBeenCalled();
		});

		test("tracks multiple sequential state changes", () => {
			feedMessage(connection, buildMessage(PeerMessageType.Unchoke));
			feedMessage(connection, buildMessage(PeerMessageType.Choke));
			feedMessage(connection, buildMessage(PeerMessageType.Unchoke));
			feedMessage(connection, buildMessage(PeerMessageType.Interested));
			feedMessage(connection, buildMessage(PeerMessageType.NotInterested));
			connection.sendInterested();
			connection.sendNotInterested();

			expect(connection.state).toEqual({
				isChokedByPeer: false,
				isInterestedInPeer: false,
				hasChokedPeer: true,
				isPeerInterestedInUs: false,
			});
		});

		test("handles rapid choke/unchoke toggling", () => {
			const messages: Uint8Array[] = [];
			for (let i = 0; i <= 100; i++) {
				messages.push(
					buildMessage(i % 2 === 0 ? PeerMessageType.Choke : PeerMessageType.Unchoke),
				);
			}

			feedMessage(connection, concatBytes(...messages));

			expect(connection.state.isChokedByPeer).toBe(true);
		});

		test("getPeerBitfield returns a copy", () => {
			feedMessage(connection, buildMessage(PeerMessageType.Bitfield, [0x80]));

			const copy = connection.getPeerBitfield();
			copy[0] = 0;

			expect(connection.hasPiece(0)).toBe(true);
			expect(Array.from(connection.getPeerBitfield())).toEqual([0x80]);
		});
	});
});
