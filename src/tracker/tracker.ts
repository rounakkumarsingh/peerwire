import { dns } from "bun";
import {
	type BencodeDecodedValue,
	decodeBencodedItem,
} from "../bencode/decode";
import type { SHA1Hash } from "../torrent/metadata";
import {
	createPeerId,
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
import { encodePeerId, generatePeerId, percentEncodeBytes } from "./utils";

/** Timeout for tracker HTTP requests in milliseconds */
const TRACKER_TIMEOUT_MS = 30_000;

/** Number of bits per byte for port calculations */
const BITS_PER_BYTE = 8;

/** Size of compact peer entry in bytes (4 bytes IP + 2 bytes port) */
const COMPACT_PEER_SIZE = 6;

/** Default User-Agent for tracker requests */
const DEFAULT_USER_AGENT = "PeerWire/0.1.0";

/** Shared text encoder/decoder for efficiency */
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * ClientTracker manages communication with BitTorrent HTTP trackers.
 * Handles announce requests and parses tracker responses to discover peers.
 */
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

	/**
	 * Send an announce request to a tracker to register this peer and discover other peers.
	 *
	 * @param params - Announce request parameters
	 * @returns Tracker response containing peer list and interval information
	 * @throws Error if the tracker request fails
	 */
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
		/** Enable verbose logging for debugging */
		verbose?: boolean;
	}) {
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
			verbose = false,
		} = params;

		// Validate port before making request
		if (!isPort(port)) {
			throw new Error(`Invalid port: ${port}`);
		}

		// Prefetch DNS for faster connection
		try {
			dns.prefetch(trackerURL.host);
		} catch {
			// Non-fatal, just a performance optimization
		}

		// Build query string with proper encoding
		const queryString = this.#buildQueryString({
			infoHash,
			port,
			uploadedBytes,
			downloadedBytes,
			leftBytes,
			compact,
			currentHost,
			event,
			noPeerId,
			numwant,
			key,
		});

		// Preserve any existing search params from the tracker URL
		const url = new URL(trackerURL);
		url.search = queryString;
		const urlString = url.toString();

		const response = await fetch(urlString, {
			signal: AbortSignal.timeout(TRACKER_TIMEOUT_MS),
			verbose,
			headers: {
				"User-Agent": DEFAULT_USER_AGENT,
				Accept: "*/*",
			},
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "Unable to read body");
			throw new Error(
				`Tracker request failed: ${response.status} ${response.statusText}\nBody: ${body}`,
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

	/**
	 * Build query string for announce request.
	 * Uses manual encoding for binary fields to avoid double-encoding issues.
	 */
	#buildQueryString(params: {
		infoHash: SHA1Hash;
		port: Port;
		uploadedBytes: number;
		downloadedBytes: number;
		leftBytes: number;
		compact: boolean;
		currentHost: IPAddr | Hostname;
		event?: "started" | "completed" | "stopped";
		noPeerId: boolean;
		numwant?: number;
		key?: string;
	}): string {
		const parts: string[] = [
			`info_hash=${percentEncodeBytes(params.infoHash)}`,
			`peer_id=${encodePeerId(this.peerId)}`,
			`port=${params.port}`,
			`uploaded=${params.uploadedBytes}`,
			`downloaded=${params.downloadedBytes}`,
			`left=${params.leftBytes}`,
			`compact=${params.compact ? "1" : "0"}`,
			`ip=${encodeURIComponent(params.currentHost)}`,
		];

		if (params.event) {
			parts.push(`event=${encodeURIComponent(params.event)}`);
		}
		if (params.noPeerId) {
			parts.push("no_peer_id=1");
		}
		if (params.numwant !== undefined) {
			parts.push(`numwant=${params.numwant}`);
		}
		if (params.key) {
			parts.push(`key=${encodeURIComponent(params.key)}`);
		}
		if (this._trackerId) {
			parts.push(`trackerid=${encodeURIComponent(this._trackerId)}`);
		}

		return parts.join("&");
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
		const peersRaw = this.#get(value, "peers");

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

		while (offset + COMPACT_PEER_SIZE <= bytes.length) {
			const ipBytes = bytes.slice(offset, offset + 4);
			const portBytes = bytes.slice(offset + 4, offset + 6);
			const ipStr = `${ipBytes[0]}.${ipBytes[1]}.${ipBytes[2]}.${ipBytes[3]}`;
			if (isIPAddr(ipStr)) {
				// biome-ignore lint/style/noNonNullAssertion: portBytes.length === 2
				const port = (portBytes[0]! << BITS_PER_BYTE) | portBytes[1]!;
				if (isPort(port) && port !== 0) {
					peers.push({ host: ipStr as IPAddr, port: port as Port });
				}
			}

			offset += COMPACT_PEER_SIZE;
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
					try {
						peerId = createPeerId(peerIdBytes);
					} catch {
						// Skip peers with invalid peer IDs
						continue;
					}
				}
			}

			const ipBytes = this.#expectBytes(entry, "ip");
			const ip = TEXT_DECODER.decode(ipBytes);

			if (!isIPAddr(ip) && !isHostname(ip)) {
				continue;
			}

			const port = this.#expectInteger(entry, "port");
			const portNum = Number(port);
			if (!Number.isSafeInteger(portNum) || !isPort(portNum) || portNum === 0) {
				continue;
			}

			peers.push({
				peerId,
				host: ip as IPAddr | Hostname,
				port: portNum as Port,
			});
		}

		return peers;
	}

	#get(
		dict: Map<Uint8Array, BencodeDecodedValue>,
		key: string,
	): BencodeDecodedValue | undefined {
		const keyBytes = TEXT_ENCODER.encode(key);
		for (const [k, v] of dict) {
			if (
				k.length === keyBytes.length &&
				k.every((b, i) => b === keyBytes[i])
			) {
				return v;
			}
		}
		return undefined;
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
		return TEXT_DECODER.decode(val);
	}
}
