export enum PeerMessageType {
	Choke = 0,
	Unchoke = 1,
	Interested = 2,
	NotInterested = 3,
	Have = 4,
	Bitfield = 5,
	Request = 6,
	Piece = 7,
	Cancel = 8,
	Port = 9,
	KeepAlive = 10,
}
export type PeerMessage =
	| { type: PeerMessageType.KeepAlive } // Special case: length 0, no ID byte
	| { type: PeerMessageType.Choke }
	| { type: PeerMessageType.Unchoke }
	| { type: PeerMessageType.Interested }
	| { type: PeerMessageType.NotInterested }
	| { type: PeerMessageType.Have; index: number }
	| { type: PeerMessageType.Bitfield; bitfield: Uint8Array }
	| {
			type: PeerMessageType.Request;
			index: number;
			begin: number;
			length: number;
	  }
	| {
			type: PeerMessageType.Piece;
			index: number;
			begin: number;
			block: Uint8Array;
	  }
	| {
			type: PeerMessageType.Cancel;
			index: number;
			begin: number;
			length: number;
	  }
	| { type: PeerMessageType.Port; port: number };

export function parsePeerMessage(data: Uint8Array): PeerMessage {
	if (data.length < 4) {
		throw new Error("Invalid message: too short");
	}

	const lengthPrefixBuffer = data.slice(0, 4);
	const length = new DataView(lengthPrefixBuffer.buffer).getUint32(0, false);
	if (data.length === 4 && length === 0) {
		// Keep-alive message
		return {
			type: PeerMessageType.KeepAlive,
		};
	}

	if (data.length < 4 + length) {
		throw new Error(
			`Invalid message: expected length ${length} but got ${data.length - 4}`,
		);
	}

	const messageType = data[4] as PeerMessageType;
	switch (messageType) {
		case PeerMessageType.Choke:
		case PeerMessageType.Unchoke:
		case PeerMessageType.Interested:
		case PeerMessageType.NotInterested:
			if (length !== 1) {
				throw new Error(
					`Invalid ${PeerMessageType[messageType].toLowerCase()} message: expected length 1 but got ${length}`,
				);
			}
			return { type: messageType };
		case PeerMessageType.Have: {
			if (length !== 5) {
				throw new Error(
					`Invalid have message: expected length 5 but got ${length}`,
				);
			}

			const pieceIndex = new DataView(
				data.buffer,
				data.byteOffset + 5,
				4,
			).getUint32(0, false);
			return { type: PeerMessageType.Have, index: pieceIndex };
		}
		case PeerMessageType.Bitfield: {
			if (length < 2) {
				throw new Error(
					`Invalid bitfield message: expected length >= 2 but got ${length}`,
				);
			}

			const bitfield = data.slice(5, 5 + length - 1);
			return { type: PeerMessageType.Bitfield, bitfield };
		}
		case PeerMessageType.Request: {
			if (length !== 13) {
				throw new Error(
					`Invalid request message: expected length 13 but got ${length}`,
				);
			}

			const index = new DataView(data.buffer, data.byteOffset + 5, 4).getUint32(
				0,
				false,
			);

			const begin = new DataView(data.buffer, data.byteOffset + 9, 4).getUint32(
				0,
				false,
			);

			const reqLength = new DataView(
				data.buffer,
				data.byteOffset + 13,
				4,
			).getUint32(0, false);

			return {
				type: PeerMessageType.Request,
				index,
				begin,
				length: reqLength,
			};
		}

		case PeerMessageType.Piece: {
			if (length < 9) {
				throw new Error(
					`Invalid request message: expected length >= 9 but got ${length}`,
				);
			}

			const index = new DataView(data.buffer, data.byteOffset + 5, 4).getUint32(
				0,
				false,
			);

			const begin = new DataView(data.buffer, data.byteOffset + 9, 4).getUint32(
				0,
				false,
			);

			const block = data.slice(13, 13 + length - 9);
			return {
				type: PeerMessageType.Piece,
				index,
				begin,
				block,
			};
		}
		case PeerMessageType.Cancel: {
			if (length !== 13) {
				throw new Error(
					`Invalid request message: expected length 13 but got ${length}`,
				);
			}
			const index = new DataView(data.buffer, data.byteOffset + 5, 4).getUint32(
				0,
				false,
			);
			return {
				type: PeerMessageType.Cancel,
				index,
				begin: new DataView(data.buffer, data.byteOffset + 9, 4).getUint32(
					0,
					false,
				),
				length: new DataView(data.buffer, data.byteOffset + 13, 4).getUint32(
					0,
					false,
				),
			};
		}
		case PeerMessageType.Port: {
			if (length !== 3) {
				throw new Error(
					`Invalid port message: expected length 3 but got ${length}`,
				);
			}

			const listenPort = new DataView(
				data.buffer,
				data.byteOffset + 5,
				2,
			).getUint16(0, false);
			return {
				type: PeerMessageType.Port,
				port: listenPort,
			};
		}
		default:
			throw new Error(`Unknown message type: ${messageType}`);
	}
}
