import type { Encoding } from "bun";
import {
	type BencodeDecodedValue,
	decodeBencodedDictionary,
	decodeBencodedItem,
	decodeBencodedString,
} from "../bencode/decode";
import { toUint8Array } from "../utils/toUint8Array";
import type {
	MD5Hex,
	PieceData,
	SHA1Hash,
	TorrentMetadata,
	TorrentMetadataFileEntry,
	TrackerURL,
	UnixTimestamp,
} from "./metadata";

type TypeGuard<T extends BencodeDecodedValue> = (
	value: BencodeDecodedValue,
) => value is T;

function expectKey<T extends BencodeDecodedValue>(
	dict: Map<Uint8Array, BencodeDecodedValue>,
	key: string,
	guard: TypeGuard<T>,
): T {
	const keyBytes = typeof key === "string" ? toUint8Array(key) : key;

	let value: BencodeDecodedValue | undefined;
	for (const [k, v] of dict) {
		if (k.length === keyBytes.length) {
			let equal = true;
			for (let i = 0; i < k.length; i++) {
				if (k[i] !== keyBytes[i]) {
					equal = false;
					break;
				}
			}
			if (equal) {
				value = v;
				break;
			}
		}
	}

	if (value === undefined) {
		throw new Error(`Invalid torrent: missing '${key}'`);
	}
	if (!guard(value)) {
		const got =
			typeof value === "bigint"
				? "bigint"
				: value instanceof Uint8Array
					? "Uint8Array"
					: Array.isArray(value)
						? "array"
						: "Map";
		throw new Error(`Invalid torrent: '${key}' type mismatch, got ${got}`);
	}
	return value;
}

function optKey<T extends BencodeDecodedValue>(
	dict: Map<Uint8Array, BencodeDecodedValue>,
	key: string,
	guard: TypeGuard<T>,
): T | undefined {
	const keyBytes = typeof key === "string" ? toUint8Array(key) : key;

	let value: BencodeDecodedValue | undefined;
	for (const [k, v] of dict) {
		if (k.length === keyBytes.length) {
			let equal = true;
			for (let i = 0; i < k.length; i++) {
				if (k[i] !== keyBytes[i]) {
					equal = false;
					break;
				}
			}
			if (equal) {
				value = v;
				break;
			}
		}
	}
	if (value === undefined) {
		return undefined;
	}
	if (!guard(value)) {
		const got =
			typeof value === "bigint"
				? "bigint"
				: value instanceof Uint8Array
					? "Uint8Array"
					: Array.isArray(value)
						? "array"
						: "Map";
		throw new Error(`Invalid torrent: '${key}' type mismatch, got ${got}`);
	}
	return value;
}

const isUint8Array = (v: BencodeDecodedValue): v is Uint8Array =>
	v instanceof Uint8Array;
const isBigInt = (v: BencodeDecodedValue): v is bigint => typeof v === "bigint";
const isMap = (
	v: BencodeDecodedValue,
): v is Map<Uint8Array, BencodeDecodedValue> => v instanceof Map;
const isArray = (v: BencodeDecodedValue): v is BencodeDecodedValue[] =>
	Array.isArray(v);

function decodeText(bytes: Uint8Array, encoding: Encoding = "utf-8") {
	return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}

function parseUrlFromBytes(bytes: Uint8Array): URL {
	const str = decodeText(bytes);
	try {
		return new URL(str);
	} catch {
		throw new Error(`Invalid URL: ${str}`);
	}
}

function parsePieces(pieces: Uint8Array): SHA1Hash[] {
	if (pieces.length % 20 !== 0) {
		throw new Error(
			`Invalid pieces: length ${pieces.length} not divisible by 20`,
		);
	}
	const hashes: SHA1Hash[] = [];
	for (let i = 0; i < pieces.length; i += 20) {
		hashes.push(pieces.slice(i, i + 20) as SHA1Hash);
	}
	return hashes;
}

function getInfoRange(input: Uint8Array): { start: number; end: number } {
	let currOffset = 1; // skip 'd'
	const LOWERCASE_E = "e".charCodeAt(0);
	while (currOffset < input.length && input[currOffset] !== LOWERCASE_E) {
		const { value: key, nextOffset: afterKeyOffset } = decodeBencodedString(
			input,
			currOffset,
		);
		currOffset = afterKeyOffset;
		const valueStart = currOffset;
		const { nextOffset: afterValueOffset } = decodeBencodedItem(
			input,
			currOffset,
		);
		if (decodeText(key) === "info") {
			return { start: valueStart, end: afterValueOffset };
		}
		currOffset = afterValueOffset;
	}
	throw new Error("info key not found");
}

export async function parseTorrentFile(
	filePath: string | URL,
): Promise<TorrentMetadata> {
	const file = Bun.file(filePath);
	const bytes = await file.bytes();

	const { start, end } = getInfoRange(bytes);
	const infoBytes = bytes.slice(start, end);
	const infoHashBuffer = new Bun.CryptoHasher("sha1")
		.update(infoBytes)
		.digest();
	const infoHash = new Uint8Array(infoHashBuffer) as SHA1Hash;

	const { value: dict } = decodeBencodedDictionary(bytes, 0);

	const announce = expectKey(dict, "announce", isUint8Array);
	const announceURL = parseUrlFromBytes(announce);
	const info = expectKey(dict, "info", isMap);

	const pieceLength = expectKey(info, "piece length", isBigInt);
	const pieces = expectKey(info, "pieces", isUint8Array);
	const parsedPieces = parsePieces(pieces);

	const optAnnounceList = optKey(dict, "announce-list", isArray);
	const optCreationDate = optKey(dict, "creation date", isBigInt);
	const optComment = optKey(dict, "comment", isUint8Array);
	const optCreatedBy = optKey(dict, "created by", isUint8Array);
	const optEncoding = optKey(dict, "encoding", isUint8Array);
	const optPrivate = optKey(info, "private", isBigInt);

	const HAS_LENGTH = optKey(info, "length", isBigInt) !== undefined;
	const HAS_FILES = optKey(info, "files", isArray) !== undefined;
	if (HAS_LENGTH && !HAS_FILES) {
		const name = decodeText(expectKey(info, "name", isUint8Array));
		const length = expectKey(info, "length", isBigInt);
		const optMd5sum = optKey(info, "md5sum", isUint8Array);

		const infoData: TorrentMetadata["info"] = {
			length: Number(length),
			name,
			pieceLength: Number(pieceLength) as PieceData,
			pieces: parsedPieces,
		};

		if (optPrivate !== undefined) {
			infoData.private = Boolean(optPrivate);
		}

		if (optMd5sum !== undefined) {
			infoData.md5sum = decodeText(optMd5sum) as MD5Hex;
		}

		const metadata: TorrentMetadata = {
			announce: announceURL as TrackerURL,
			info: infoData,
			infoHash,
		};

		if (optAnnounceList !== undefined) {
			metadata.announceList = [];
			for (const tier of optAnnounceList) {
				if (!isArray(tier)) {
					throw new Error("Invalid torrent: announce-list tiers must be lists");
				}
				const parsedTier: TrackerURL[] = [];
				for (const url of tier) {
					if (!(url instanceof Uint8Array)) {
						throw new Error(
							"Invalid torrent: announce-list entries must be strings",
						);
					}
					parsedTier.push(parseUrlFromBytes(url) as TrackerURL);
				}
				metadata.announceList.push(parsedTier);
			}
		}

		if (optCreationDate !== undefined) {
			metadata.creationDate = Number(optCreationDate) as UnixTimestamp;
		}

		if (optComment !== undefined) {
			metadata.comment = decodeText(optComment);
		}

		if (optCreatedBy !== undefined) {
			metadata.createdBy = decodeText(optCreatedBy);
		}

		if (optEncoding !== undefined) {
			metadata.encoding = decodeText(optEncoding);
		}

		return metadata;
	} else if (HAS_FILES && !HAS_LENGTH) {
		const name = decodeText(expectKey(info, "name", isUint8Array));
		const files = expectKey(info, "files", isArray);
		const filesList: TorrentMetadataFileEntry[] = [];
		for (const file of files) {
			if (!isMap(file)) {
				throw new Error(
					"Invalid torrent: each file entry must be a bencoded dictionary",
				);
			}
			const fileLength = expectKey(file, "length", isBigInt);
			const filePath = expectKey(file, "path", isArray).map((v) => {
				if (!(v instanceof Uint8Array)) {
					throw new Error(
						"Invalid token: each file path constitutent should be a bencode string",
					);
				}
				return decodeText(v);
			});
			const optFileMd5sum = optKey(file, "md5sum", isUint8Array);

			const entry: TorrentMetadataFileEntry = {
				length: Number(fileLength),
				path: filePath,
			};

			if (optFileMd5sum !== undefined) {
				entry.md5sum = decodeText(optFileMd5sum) as MD5Hex;
			}

			filesList.push(entry);
		}

		const infoData: TorrentMetadata["info"] = {
			name,
			pieceLength: Number(pieceLength) as PieceData,
			pieces: parsedPieces,
			files: filesList,
		};

		if (optPrivate !== undefined) {
			infoData.private = Boolean(optPrivate);
		}

		const metadata: TorrentMetadata = {
			announce: announceURL as TrackerURL,
			info: infoData,
			infoHash,
		};

		if (optAnnounceList) {
			metadata.announceList = [];
			for (const tier of optAnnounceList) {
				if (!isArray(tier)) {
					throw new Error("Invalid torrent: announce-list tiers must be lists");
				}
				const parsedTier: TrackerURL[] = [];
				for (const url of tier) {
					if (!(url instanceof Uint8Array)) {
						throw new Error(
							"Invalid torrent: announce-list entries must be strings",
						);
					}
					parsedTier.push(parseUrlFromBytes(url) as TrackerURL);
				}
				metadata.announceList.push(parsedTier);
			}
		}

		if (optCreationDate !== undefined) {
			metadata.creationDate = Number(optCreationDate) as UnixTimestamp;
		}

		if (optComment !== undefined) {
			metadata.comment = decodeText(optComment);
		}

		if (optCreatedBy !== undefined) {
			metadata.createdBy = decodeText(optCreatedBy);
		}

		if (optEncoding !== undefined) {
			metadata.encoding = decodeText(optEncoding);
		}

		return metadata;
	} else {
		throw new Error(
			"Single file torrent files must have 'name' field in info field and" +
				" Multiple file torrent files must have 'files' field in info 'field'",
		);
	}
}
