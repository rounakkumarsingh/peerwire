import {
	type BencodeDecodedValue,
	decodeBencodedItem,
} from "../bencode/decode";
import type { SHA1Hash } from "../torrent/metadata";
import { toUint8Array } from "../utils/toUint8Array";
import {
	type Hostname,
	type IPAddr,
	isHostname,
	isIPAddr,
	isPort,
	type PeerId,
	type Port,
	type TrackerPeer,
	type TrackerResponse,
} from "./types";
import {
	createPeerId,
	encodePeerId,
	generatePeerId,
	percentEncodeBytes,
} from "./utils";

export class ClientTracker {
	readonly peerId: PeerId;
	private _lastResponse: TrackerResponse | null = null;
	private _trackerId: string | null = null;

	constructor(peerId?: PeerId) {
		this.peerId = peerId ?? generatePeerId();
	}

	get lastResponse(): TrackerResponse | null {
		return this._lastResponse;
	}

	async announce(params: {
		trackerURL: URL;
		infoHash: SHA1Hash;
		currentHost: IPAddr | Hostname;
		port: Port;
		uploadedBytes: number;
		downloadedBytes: number;
		leftBytes: number;
		event?: "started" | "completed" | "stopped";
		compact?: boolean;
		noPeerId?: boolean;
		numwant?: number;
		key?: string;
	}): Promise<TrackerResponse> {
		const {
			trackerURL,
			infoHash,
			currentHost,
			port,
			uploadedBytes,
			downloadedBytes,
			leftBytes,
			event,
			compact = true,
			noPeerId = false,
			numwant,
			key,
		} = params;

		const url = new URL(trackerURL);
		url.searchParams.set("info_hash", percentEncodeBytes(infoHash));
		url.searchParams.set("peer_id", encodePeerId(this.peerId));
		url.searchParams.set("port", String(port));
		url.searchParams.set("uploaded", String(uploadedBytes));
		url.searchParams.set("downloaded", String(downloadedBytes));
		url.searchParams.set("left", String(leftBytes));
		url.searchParams.set("compact", compact ? "1" : "0");

		url.searchParams.set("ip", currentHost);

		if (event !== undefined) {
			url.searchParams.set("event", event);
		}

		if (noPeerId) {
			url.searchParams.set("no_peer_id", "1");
		}

		if (numwant !== undefined) {
			url.searchParams.set("numwant", String(numwant));
		}

		if (key !== undefined) {
			url.searchParams.set("key", key);
		}

		if (this._trackerId !== null) {
			url.searchParams.set("trackerid", this._trackerId);
		}

		const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) {
			throw new Error(
				`Tracker request failed: ${response.status} ${response.statusText}`,
			);
		}

		const bytes = await response.bytes();
		const parsed = this.#parseResponse(bytes, !noPeerId && !compact);
		this._lastResponse = parsed;

		if (parsed.trackerId !== undefined) {
			this._trackerId = parsed.trackerId;
		}

		return parsed;
	}

	#parseResponse(bytes: Uint8Array, wantPeerId: boolean): TrackerResponse {
		const { value } = decodeBencodedItem(bytes, 0);

		if (!(value instanceof Map)) {
			throw new Error("Tracker response is not a dictionary");
		}

		const failure = this.#optString(value, "failure reason");
		const warning = this.#optString(value, "warning message");
		const interval = this.#expectInteger(value, "interval");
		const trackerId = this.#optString(value, "tracker id");
		const minInterval = this.#optInteger(value, "min interval");
		const complete = this.#optInteger(value, "complete");
		const incomplete = this.#optInteger(value, "incomplete");
		const peersRaw = value.get(toUint8Array("peers"));

		if (failure !== undefined) {
			throw new Error(`Tracker failure: ${failure}`);
		}

		const peers = this.#parsePeers(peersRaw, wantPeerId);

		return {
			interval,
			warning,
			trackerId,
			minInterval,
			complete,
			incomplete,
			peers,
		};
	}

	#parsePeers(
		raw: BencodeDecodedValue | undefined,
		wantPeerId: boolean,
	): TrackerPeer[] {
		if (raw === undefined) {
			throw new Error("Tracker response missing 'peers'");
		}

		if (raw instanceof Uint8Array) {
			return this.#parseCompactPeers(raw);
		}

		if (Array.isArray(raw)) {
			return this.#parseDictionaryPeers(raw, wantPeerId);
		}

		throw new Error("Tracker response 'peers' must be a string or list");
	}

	#parseCompactPeers(bytes: Uint8Array): TrackerPeer[] {
		const peers: TrackerPeer[] = [];
		let offset = 0;

		while (offset + 6 <= bytes.length) {
			const ipBytes = bytes.slice(offset, offset + 4);
			const portBytes = bytes.slice(offset + 4, offset + 6);
			const ipStr = `${ipBytes[0]}.${ipBytes[1]}.${ipBytes[2]}.${ipBytes[3]}`;
			if (isIPAddr(ipStr)) {
				// biome-ignore lint/style/noNonNullAssertion: portBytes.length === 2
				const port = (portBytes[0]! << 8) | portBytes[1]!;
				if (isPort(port) && port !== 0) {
					peers.push({ host: ipStr as IPAddr, port: port as Port });
				}
			}

			offset += 6;
		}

		return peers;
	}

	#parseDictionaryPeers(
		peersList: BencodeDecodedValue[],
		wantPeerId: boolean,
	): TrackerPeer[] {
		const peers: TrackerPeer[] = [];

		for (const entry of peersList) {
			if (!(entry instanceof Map)) {
				throw new Error("Peer entry in tracker response is not a dictionary");
			}

			let peerId: PeerId | undefined;
			if (wantPeerId) {
				const peerIdBytes = this.#optBytes(entry, "peer id");
				if (peerIdBytes !== undefined) {
					peerId = createPeerId(peerIdBytes);
				}
			}

			const ipBytes = this.#expectBytes(entry, "ip");
			const ip = new TextDecoder().decode(ipBytes);

			if (!isIPAddr(ip) && !isHostname(ip)) {
				continue;
			}

			const port = this.#expectInteger(entry, "port");
			if (!isPort(Number(port)) || port === 0n) {
				continue;
			}

			peers.push({
				peerId,
				host: ip as IPAddr | Hostname,
				port: Number(port) as Port,
			});
		}

		return peers;
	}

	#get(
		dict: Map<Uint8Array, BencodeDecodedValue>,
		key: string,
	): BencodeDecodedValue | undefined {
		return dict.get(new TextEncoder().encode(key));
	}

	#expectInteger(
		dict: Map<Uint8Array, BencodeDecodedValue>,
		key: string,
	): bigint {
		const val = this.#get(dict, key);
		if (val === undefined) {
			throw new Error(`Tracker response missing '${key}'`);
		}
		if (typeof val !== "bigint") {
			throw new Error(`Tracker response '${key}' is not an integer`);
		}
		return val;
	}

	#optInteger(
		dict: Map<Uint8Array, BencodeDecodedValue>,
		key: string,
	): bigint | undefined {
		const val = this.#get(dict, key);
		if (val === undefined) return undefined;
		if (typeof val !== "bigint") {
			throw new Error(`Tracker response '${key}' is not an integer`);
		}
		return val;
	}

	#expectBytes(
		dict: Map<Uint8Array, BencodeDecodedValue>,
		key: string,
	): Uint8Array {
		const val = this.#get(dict, key);
		if (val === undefined) {
			throw new Error(`Tracker response missing '${key}'`);
		}
		if (!(val instanceof Uint8Array)) {
			throw new Error(`Tracker response '${key}' is not a bencoded string`);
		}
		return val;
	}

	#optBytes(
		dict: Map<Uint8Array, BencodeDecodedValue>,
		key: string,
	): Uint8Array | undefined {
		const val = this.#get(dict, key);
		if (val === undefined) return undefined;
		if (!(val instanceof Uint8Array)) {
			throw new Error(`Tracker response '${key}' is not a bencoded string`);
		}
		return val;
	}

	#optString(
		dict: Map<Uint8Array, BencodeDecodedValue>,
		key: string,
	): string | undefined {
		const val = this.#get(dict, key);
		if (val === undefined) return undefined;
		if (!(val instanceof Uint8Array)) {
			throw new Error(`Tracker response '${key}' is not a bencoded string`);
		}
		return new TextDecoder().decode(val);
	}
}
