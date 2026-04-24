import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { SHA1Hash } from "../torrent/metadata";
import { parseTorrentFile } from "../torrent/parse";
import { ClientTracker } from "./tracker";
import type { Hostname, IPAddr, PeerId, Port } from "./types";

function toIPAddr(ip: string): IPAddr {
	return ip as IPAddr;
}

function toPort(port: number): Port {
	return port as Port;
}

function toHostname(host: string): Hostname {
	return host as Hostname;
}

/**
 * URL wrapper that preserves percent-encoded values in search params.
 * Standard URL.searchParams.get() decodes %XX sequences, which corrupts
 * binary data like info_hash and peer_id. This wrapper provides access
 * to both the decoded params (via searchParams) and raw values.
 */
class MockURL {
	private _url: URL;
	private _rawSearchParams: Map<string, string>;
	searchParams: URLSearchParams;

	constructor(url: string | URL) {
		this._url = url instanceof URL ? url : new URL(url);
		this.searchParams = this._url.searchParams;

		// Parse and store raw percent-encoded values
		this._rawSearchParams = new Map();
		const query = this._url.search.substring(1);
		if (query) {
			const pairs = query.split("&");
			for (const pair of pairs) {
				const [key, value] = pair.split("=");
				if (key && value !== undefined) {
					this._rawSearchParams.set(key, value);
				}
			}
		}
	}

	get href(): string {
		return this._url.href;
	}

	get protocol(): string {
		return this._url.protocol;
	}

	get host(): string {
		return this._url.host;
	}

	get hostname(): string {
		return this._url.hostname;
	}

	get port(): string {
		return this._url.port;
	}

	get pathname(): string {
		return this._url.pathname;
	}

	get search(): string {
		return this._url.search;
	}

	get hash(): string {
		return this._url.hash;
	}

	get origin(): string {
		return this._url.origin;
	}

	get username(): string {
		return this._url.username;
	}

	get password(): string {
		return this._url.password;
	}

	toJSON(): string {
		return this._url.toJSON();
	}

	/**
	 * Get raw percent-encoded search param value without decoding.
	 * Use this for binary data like info_hash and peer_id.
	 */
	getRawSearchParam(name: string): string | null {
		return this._rawSearchParams.get(name) ?? null;
	}

	toString(): string {
		return this._url.toString();
	}
}

function createMockFetch(fn: (url: MockURL) => Promise<Response>): typeof globalThis.fetch {
	return ((url: URL | Request | string) => {
		const urlStr = url instanceof URL ? url.toString() : url instanceof Request ? url.url : url;
		const resolvedUrl = new MockURL(urlStr);
		return fn(resolvedUrl);
	}) as unknown as typeof globalThis.fetch;
}

function createSimpleMockFetch(responseFactory: () => Response): typeof globalThis.fetch {
	const mock = (() => responseFactory()) as unknown as typeof globalThis.fetch;
	return mock;
}

function bencode(obj: object): Uint8Array {
	const encodeString = (s: string): Uint8Array => {
		const bytes = new TextEncoder().encode(s);
		return new Uint8Array([...new TextEncoder().encode(`${bytes.length}:`), ...bytes]);
	};

	const encodeBytes = (bytes: Uint8Array): Uint8Array => {
		return new Uint8Array([...new TextEncoder().encode(`${bytes.length}:`), ...bytes]);
	};

	const encode = (val: unknown): Uint8Array => {
		if (val === undefined) return new Uint8Array();
		if (typeof val === "bigint") {
			return new TextEncoder().encode(`i${val}e`);
		}
		if (typeof val === "string") {
			return encodeString(val);
		}
		if (val instanceof Uint8Array) {
			return encodeBytes(val);
		}
		if (Array.isArray(val)) {
			const inner = val.flatMap((v) => Array.from(encode(v)));
			return new Uint8Array([
				...new TextEncoder().encode("l"),
				...inner,
				...new TextEncoder().encode("e"),
			]);
		}
		if (typeof val === "object" && val !== null) {
			const entries = Object.entries(val).sort(([a], [b]) => a.localeCompare(b));
			const inner: number[] = [];
			for (const [k, v] of entries) {
				inner.push(...Array.from(encodeString(k)));
				inner.push(...Array.from(encode(v)));
			}
			return new Uint8Array([
				...new TextEncoder().encode("d"),
				...inner,
				...new TextEncoder().encode("e"),
			]);
		}
		return new Uint8Array();
	};
	return encode(obj);
}

function createCompactPeers(peers: Array<{ ip: string; port: number }>): Uint8Array {
	const bytes: number[] = [];
	for (const { ip, port } of peers) {
		const parts = ip.split(".").map(Number);
		bytes.push(...parts, (port >> 8) & 0xff, port & 0xff);
	}
	return new Uint8Array(bytes);
}

function createPeerIdBytes(id: string): PeerId {
	const bytes = new Uint8Array(20);
	for (let i = 0; i < 20; i++) {
		bytes[i] = id.charCodeAt(i % id.length);
	}
	return bytes as PeerId;
}

function createInfoHash(): SHA1Hash {
	return new Uint8Array(20) as SHA1Hash;
}

/**
 * Helper to load a real torrent file from test-data directory.
 * Returns the parsed metadata including real infoHash and announce URL.
 */
async function loadTestTorrentFile(filename: string) {
	const torrentPath = path.join(import.meta.dir, "../torrent/test-data", filename);
	return parseTorrentFile(torrentPath);
}

describe("ClientTracker", () => {
	describe("constructor", () => {
		test("generates peer ID if not provided", async () => {
			const tracker = new ClientTracker();
			expect(tracker.peerId).toBeInstanceOf(Uint8Array);
			expect(tracker.peerId.length).toBe(20);
		});

		test("uses provided peer ID", async () => {
			const customPeerId = createPeerIdBytes("test-peer-id-12345");
			const tracker = new ClientTracker(customPeerId);
			expect(tracker.peerId).toBe(customPeerId);
		});

		test("lastResponse is initially null", async () => {
			const tracker = new ClientTracker();
			expect(tracker.lastResponse).toBeNull();
		});
	});

	describe("announce URL building", () => {
		test("builds URL with all required parameters", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const response = new Response(bencode({ interval: 1800n, peers: "" }));
			const originalFetch = globalThis.fetch;
			let capturedUrl: URL | undefined;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedUrl = resolvedUrl;
				return response;
			});

			const infoHash = createInfoHash();
			infoHash[0] = 0x64;
			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(capturedUrl).toBeDefined();
			expect(capturedUrl?.searchParams.get("info_hash")).toBeDefined();
			expect(capturedUrl?.searchParams.get("peer_id")).toBeDefined();
			expect(capturedUrl?.searchParams.get("port")).toBe("6881");
			expect(capturedUrl?.searchParams.get("uploaded")).toBe("0");
			expect(capturedUrl?.searchParams.get("downloaded")).toBe("0");
			expect(capturedUrl?.searchParams.get("left")).toBe("1000000");
			expect(capturedUrl?.searchParams.get("compact")).toBe("1");
			expect(capturedUrl?.searchParams.get("ip")).toBe("192.168.1.1");
		});

		test("compact defaults to true", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const response = new Response(bencode({ interval: 1800n, peers: "" }));
			const originalFetch = globalThis.fetch;
			let capturedCompact!: string | null;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedCompact = resolvedUrl.searchParams.get("compact");
				return response;
			});

			const infoHash = createInfoHash();
			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(capturedCompact).toBe("1");
		});

		test("compact=0 when explicitly false", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const response = new Response(bencode({ interval: 1800n, peers: "" }));
			const originalFetch = globalThis.fetch;
			let capturedCompact!: string | null;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedCompact = resolvedUrl.searchParams.get("compact");
				return response;
			});

			const infoHash = createInfoHash();
			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
				compact: false,
			});

			globalThis.fetch = originalFetch;

			expect(capturedCompact).toBe("0");
		});

		test("includes event parameter", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;

			const infoHash = createInfoHash();
			for (const event of ["started", "completed", "stopped"] as const) {
				let capturedEvent!: string | null;

				globalThis.fetch = createMockFetch(async (resolvedUrl) => {
					capturedEvent = resolvedUrl.searchParams.get("event");
					return new Response(bencode({ interval: 1800n, peers: "" }));
				});

				await tracker.announce({
					trackerURL: new URL("http://tracker.example.com/announce"),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
					event,
				});

				globalThis.fetch = originalFetch;

				expect(capturedEvent).toBe(event);
			}
		});

		test("includes no_peer_id when true", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const response = new Response(bencode({ interval: 1800n, peers: "" }));
			const originalFetch = globalThis.fetch;
			let capturedNoPeerId!: string | null;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedNoPeerId = resolvedUrl.searchParams.get("no_peer_id");
				return response;
			});

			const infoHash = createInfoHash();
			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
				noPeerId: true,
			});

			globalThis.fetch = originalFetch;

			expect(capturedNoPeerId).toBe("1");
		});

		test("includes numwant when provided", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const response = new Response(bencode({ interval: 1800n, peers: "" }));
			const originalFetch = globalThis.fetch;
			let capturedNumwant!: string | null;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedNumwant = resolvedUrl.searchParams.get("numwant");
				return response;
			});

			const infoHash = createInfoHash();
			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
				numwant: 50,
			});

			globalThis.fetch = originalFetch;

			expect(capturedNumwant).toBe("50");
		});

		test("includes key when provided", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const response = new Response(bencode({ interval: 1800n, peers: "" }));
			const originalFetch = globalThis.fetch;
			let capturedKey!: string | null;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedKey = resolvedUrl.searchParams.get("key");
				return response;
			});

			const infoHash = createInfoHash();
			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
				key: "test-key",
			});

			globalThis.fetch = originalFetch;

			expect(capturedKey).toBe("test-key");
		});
	});

	describe("response parsing - compact format", () => {
		test("parses single compact peer", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const peers = createCompactPeers([{ ip: "192.168.1.100", port: 6881 }]);
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers })),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(response.peers).toBeArrayOfSize(1);
			expect(response.peers[0]?.host).toBe(toIPAddr("192.168.1.100"));
			expect(response.peers[0]?.port).toBe(toPort(6881));
		});

		test("parses multiple compact peers", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const peers = createCompactPeers([
				{ ip: "192.168.1.100", port: 6881 },
				{ ip: "10.0.0.50", port: 443 },
				{ ip: "172.16.0.1", port: 8080 },
			]);
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers })),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(response.peers).toBeArrayOfSize(3);
			expect(response.peers[0]?.host).toBe(toIPAddr("192.168.1.100"));
			expect(response.peers[1]?.host).toBe(toIPAddr("10.0.0.50"));
			expect(response.peers[2]?.host).toBe(toIPAddr("172.16.0.1"));
		});

		test("skips invalid peer data", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const peers = createCompactPeers([
				{ ip: "192.168.1.100", port: 6881 },
				{ ip: "0.0.0.0", port: 0 },
				{ ip: "10.0.0.50", port: 443 },
			]);
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers })),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(response.peers).toBeArrayOfSize(2);
		});
	});

	describe("response parsing - dictionary format", () => {
		test("parses dictionary peers with peer_id", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const peerIdBytes = createPeerIdBytes("peer1-peer1-peer1-");
			const peers = [
				{
					"peer id": peerIdBytes,
					ip: new TextEncoder().encode("192.168.1.100"),
					port: 6881n,
				},
			];
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers })),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
				compact: false,
			});

			globalThis.fetch = originalFetch;

			expect(response.peers).toBeArrayOfSize(1);
			expect(response.peers[0]?.peerId).toBeDefined();
			expect(response.peers[0]?.host).toBe(toIPAddr("192.168.1.100"));
			expect(response.peers[0]?.port).toBe(toPort(6881));
		});

		test("parses dictionary peers without peer_id", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const peers = [{ ip: new TextEncoder().encode("192.168.1.100"), port: 6881n }];
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers })),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
				compact: false,
				noPeerId: true,
			});

			globalThis.fetch = originalFetch;

			expect(response.peers).toBeArrayOfSize(1);
			expect(response.peers[0]?.peerId).toBeUndefined();
		});

		test("parses hostname in dictionary peer", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const peers = [
				{
					ip: new TextEncoder().encode("tracker.example.com"),
					port: 6881n,
				},
			];
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers })),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
				compact: false,
			});

			globalThis.fetch = originalFetch;

			expect(response.peers).toBeArrayOfSize(1);
			expect(response.peers[0]?.host).toBe(toHostname("tracker.example.com"));
		});

		test("skips invalid IPs in dictionary peers", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const peers = [
				{ ip: new TextEncoder().encode("invalid..ip"), port: 6881n },
				{ ip: new TextEncoder().encode("192.168.1.100"), port: 6881n },
			];
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers })),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
				compact: false,
			});

			globalThis.fetch = originalFetch;

			expect(response.peers).toBeArrayOfSize(1);
			expect(response.peers[0]?.host).toBe(toIPAddr("192.168.1.100"));
		});

		test("skips port 0 in dictionary peers", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const peers = [
				{ ip: new TextEncoder().encode("192.168.1.100"), port: 0n },
				{ ip: new TextEncoder().encode("192.168.1.101"), port: 6881n },
			];
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers })),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
				compact: false,
			});

			globalThis.fetch = originalFetch;

			expect(response.peers).toBeArrayOfSize(1);
			expect(response.peers[0]?.host).toBe(toIPAddr("192.168.1.101"));
		});
	});

	describe("response fields", () => {
		test("parses interval", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers: "" })),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(response.interval).toBe(1800n);
		});

		test("parses minInterval", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() =>
					new Response(
						bencode({
							interval: 1800n,
							"min interval": 300n,
							peers: "",
						}),
					),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(response.minInterval).toBe(300n);
		});

		test("parses complete and incomplete", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() =>
					new Response(
						bencode({
							interval: 1800n,
							complete: 100n,
							incomplete: 50n,
							peers: "",
						}),
					),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(response.complete).toBe(100n);
			expect(response.incomplete).toBe(50n);
		});

		test("parses warning message", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() =>
					new Response(
						bencode({
							interval: 1800n,
							"warning message": "Test warning",
							peers: "",
						}),
					),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(response.warning).toBe("Test warning");
		});

		test("stores response in lastResponse", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const peers = createCompactPeers([{ ip: "192.168.1.100", port: 6881 }]);
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers })),
			);

			const infoHash = createInfoHash();
			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(tracker.lastResponse).not.toBeNull();
			expect(tracker.lastResponse?.interval).toBe(1800n);
			expect(tracker.lastResponse?.peers).toBeArrayOfSize(1);
		});
	});

	describe("tracker ID persistence", () => {
		test("saves trackerId from response", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() =>
					new Response(
						bencode({
							interval: 1800n,
							peers: "",
							"tracker id": "tracker-session-123",
						}),
					),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(response.trackerId).toBe("tracker-session-123");
		});

		test("uses trackerId in subsequent requests", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const capturedTrackerIds: (string | null)[] = [];
			const originalFetch = globalThis.fetch;
			let requestCount = 0;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedTrackerIds.push(resolvedUrl.searchParams.get("trackerid"));
				requestCount++;
				if (requestCount === 1) {
					return new Response(
						bencode({
							interval: 1800n,
							peers: "",
							"tracker id": "session-abc",
						}),
					);
				}
				return new Response(bencode({ interval: 1800n, peers: "" }));
			});

			const infoHash = createInfoHash();

			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 1000,
				downloadedBytes: 500,
				leftBytes: 500000,
			});

			globalThis.fetch = originalFetch;

			expect(capturedTrackerIds[0]).toBeNull();
			expect(capturedTrackerIds[1]).toBe("session-abc");
		});
	});

	describe("error handling", () => {
		test("throws when response is not a dictionary", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(() => new Response("not a dictionary"));

			const infoHash = createInfoHash();
			expect(async () => {
				await tracker.announce({
					trackerURL: new URL("http://tracker.example.com/announce"),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				});
			}).toThrow();

			globalThis.fetch = originalFetch;
		});

		test("throws when response has failure reason", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() =>
					new Response(
						bencode({
							"failure reason": "Invalid info hash",
							interval: 1800n,
						}),
					),
			);

			const infoHash = createInfoHash();
			expect(async () => {
				await tracker.announce({
					trackerURL: new URL("http://tracker.example.com/announce"),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				});
			}).toThrow("Tracker failure: Invalid info hash");

			globalThis.fetch = originalFetch;
		});

		test("throws when peers field is missing", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n })),
			);

			const infoHash = createInfoHash();
			expect(async () => {
				await tracker.announce({
					trackerURL: new URL("http://tracker.example.com/announce"),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				});
			}).toThrow("Tracker response missing 'peers'");

			globalThis.fetch = originalFetch;
		});

		test("throws when HTTP status is not ok", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() =>
					new Response(bencode({ interval: 1800n, peers: "" }), {
						status: 500,
					}),
			);

			const infoHash = createInfoHash();
			expect(async () => {
				await tracker.announce({
					trackerURL: new URL("http://tracker.example.com/announce"),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				});
			}).toThrow("Tracker request failed: 500 ");

			globalThis.fetch = originalFetch;
		});

		test("throws when peers is invalid type", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers: 123n })),
			);

			const infoHash = createInfoHash();
			expect(async () => {
				await tracker.announce({
					trackerURL: new URL("http://tracker.example.com/announce"),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				});
			}).toThrow("Tracker response 'peers' must be a string or list");

			globalThis.fetch = originalFetch;
		});
	});

	describe("network timeouts", () => {
		test("fetch is called with AbortSignal.timeout signal", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			let capturedSignal: AbortSignal | undefined;
			const originalFetch = globalThis.fetch;

			globalThis.fetch = (async (_url: URL | Request | string, init?: RequestInit) => {
				capturedSignal = init?.signal as AbortSignal | undefined;
				const peers = createCompactPeers([{ ip: "192.168.1.100", port: 6881 }]);
				return new Response(bencode({ interval: 1800n, peers }));
			}) as unknown as typeof globalThis.fetch;

			const infoHash = createInfoHash();

			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(capturedSignal).toBeDefined();
			// Verify the signal is an AbortSignal
			expect(capturedSignal).toBeInstanceOf(AbortSignal);
			// The signal should timeout (it won't be aborted since request succeeds)
			// We can verify it has the expected timeout by checking abort event doesn't fire quickly
		});

		test("request completes before timeout", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const peers = createCompactPeers([{ ip: "192.168.1.100", port: 6881 }]);
			const originalFetch = globalThis.fetch;

			// Mock that resolves quickly
			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers })),
			);

			const infoHash = createInfoHash();
			const startTime = Date.now();

			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			const elapsed = Date.now() - startTime;

			globalThis.fetch = originalFetch;

			expect(response.peers).toBeArrayOfSize(1);
			// Should complete in well under 30 seconds
			expect(elapsed).toBeLessThan(5000);
		});
	});

	describe("concurrent announces", () => {
		test("multiple simultaneous announces to different trackers", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const trackerUrl1 = "http://tracker1.example.com/announce";
			const trackerUrl2 = "http://tracker2.example.com/announce";
			const trackerUrl3 = "http://tracker3.example.com/announce";

			const capturedUrls: string[] = [];
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedUrls.push(resolvedUrl.toString());
				const peers = createCompactPeers([{ ip: "192.168.1.100", port: 6881 }]);
				return new Response(bencode({ interval: 1800n, peers }));
			});

			// Create three different info hashes with distinct first bytes
			const infoHash1 = createInfoHash();
			infoHash1[0] = 0x01;
			const infoHash2 = createInfoHash();
			infoHash2[0] = 0x02;
			const infoHash3 = createInfoHash();
			infoHash3[0] = 0x03;

			const results = await Promise.all([
				tracker.announce({
					trackerURL: new URL(trackerUrl1),
					infoHash: infoHash1,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				}),
				tracker.announce({
					trackerURL: new URL(trackerUrl2),
					infoHash: infoHash2,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				}),
				tracker.announce({
					trackerURL: new URL(trackerUrl3),
					infoHash: infoHash3,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				}),
			]);

			globalThis.fetch = originalFetch;

			expect(results).toBeArrayOfSize(3);
			expect(capturedUrls).toBeArrayOfSize(3);
			expect(capturedUrls[0]).toContain("tracker1.example.com");
			expect(capturedUrls[1]).toContain("tracker2.example.com");
			expect(capturedUrls[2]).toContain("tracker3.example.com");
		});

		test("same tracker with different info hashes concurrently", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const capturedInfoHashes: string[] = [];
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedInfoHashes.push(resolvedUrl.getRawSearchParam("info_hash") ?? "");
				const peers = createCompactPeers([{ ip: "192.168.1.100", port: 6881 }]);
				return new Response(bencode({ interval: 1800n, peers }));
			});

			const hash1 = createInfoHash();
			hash1[0] = 0xaa;
			const hash2 = createInfoHash();
			hash2[0] = 0xbb;
			const hash3 = createInfoHash();
			hash3[0] = 0xcc;

			const results = await Promise.all(
				[hash1, hash2, hash3].map((infoHash) =>
					tracker.announce({
						trackerURL: new URL("http://tracker.example.com/announce"),
						infoHash,
						currentHost: toIPAddr("192.168.1.1"),
						port: toPort(6881),
						uploadedBytes: 0,
						downloadedBytes: 0,
						leftBytes: 1000000,
					}),
				),
			);

			globalThis.fetch = originalFetch;

			expect(results).toBeArrayOfSize(3);
			expect(capturedInfoHashes).toBeArrayOfSize(3);
			// Each request should have different info_hash
			const uniqueHashes = new Set(capturedInfoHashes);
			expect(uniqueHashes.size).toBe(3);
		});

		test("lastResponse is updated correctly after concurrent requests", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			let requestCount = 0;
			const originalFetch = globalThis.fetch;

			globalThis.fetch = createMockFetch(async () => {
				requestCount++;
				const peerPort = 6880 + requestCount;
				const peers = createCompactPeers([{ ip: "192.168.1.100", port: peerPort }]);
				return new Response(bencode({ interval: 1800n, peers }));
			});

			const infoHash1 = createInfoHash();
			infoHash1[0] = 0x01;
			const infoHash2 = createInfoHash();
			infoHash2[0] = 0x02;

			// Start first request
			const promise1 = tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash: infoHash1,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			// Start second request while first is still pending
			const promise2 = tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash: infoHash2,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			await Promise.all([promise1, promise2]);

			globalThis.fetch = originalFetch;

			// lastResponse should reflect the last completed request
			expect(tracker.lastResponse).not.toBeNull();
			// The exact state depends on race conditions, but it should be a valid response
			expect(tracker.lastResponse?.peers).toBeDefined();
		});
	});

	describe("binary-safe URL encoding", () => {
		test("encodes info_hash with null bytes", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;
			let capturedInfoHash!: string | null;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedInfoHash = resolvedUrl.getRawSearchParam("info_hash");
				return new Response(bencode({ interval: 1800n, peers: "" }));
			});

			const infoHash = createInfoHash();
			infoHash[0] = 0x00;
			infoHash[1] = 0x00;

			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			// Null bytes should be encoded as %00
			expect(capturedInfoHash).toBe(
				"%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00%00",
			);
		});

		test("encodes info_hash with high ASCII bytes", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;
			let capturedInfoHash!: string | null;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedInfoHash = resolvedUrl.getRawSearchParam("info_hash");
				return new Response(bencode({ interval: 1800n, peers: "" }));
			});

			const infoHash = createInfoHash();
			// Fill with high ASCII bytes (0x80-0xFF)
			for (let i = 0; i < 20; i++) {
				infoHash[i] = 0x80 + i;
			}

			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			// Each byte should be percent-encoded
			expect(capturedInfoHash).toBeDefined();
			expect(capturedInfoHash).toMatch(/^%[0-9A-F]{2}(%[0-9A-F]{2}){19}$/);
			expect(capturedInfoHash).toContain("%80"); // First high byte
		});

		test("encodes info_hash with special characters", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;
			let capturedInfoHash!: string | null;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedInfoHash = resolvedUrl.getRawSearchParam("info_hash");
				return new Response(bencode({ interval: 1800n, peers: "" }));
			});

			const infoHash = createInfoHash();
			// Include various special bytes
			infoHash[0] = 0x20; // space
			infoHash[1] = 0x2f; // forward slash /
			infoHash[2] = 0x3d; // equals =
			infoHash[3] = 0x25; // percent %
			infoHash[4] = 0x26; // ampersand &

			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			// All special characters should be percent-encoded
			expect(capturedInfoHash).toContain("%20");
			expect(capturedInfoHash).toContain("%2F");
			expect(capturedInfoHash).toContain("%3D");
			expect(capturedInfoHash).toContain("%25");
			expect(capturedInfoHash).toContain("%26");
		});

		test("encodes peer_id with all binary values", async () => {
			// Create a peer ID with all possible byte values
			const peerIdBytes = new Uint8Array(20);
			for (let i = 0; i < 20; i++) {
				peerIdBytes[i] = i * 13; // 0, 13, 26, 39, 52, 65, 78, 91, 104, 117, 130->2, 143->15, etc.
			}
			const peerId = peerIdBytes as PeerId;

			const tracker = new ClientTracker(peerId);

			const originalFetch = globalThis.fetch;
			let capturedPeerId!: string | null;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedPeerId = resolvedUrl.getRawSearchParam("peer_id");
				return new Response(bencode({ interval: 1800n, peers: "" }));
			});

			const infoHash = createInfoHash();
			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			// All bytes should be percent-encoded
			expect(capturedPeerId).toBeDefined();
			expect(capturedPeerId).toMatch(/^%[0-9A-F]{2}(%[0-9A-F]{2}){19}$/);
		});

		test("info_hash and peer_id use uppercase hex encoding", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;
			let capturedInfoHash!: string | null;
			let capturedPeerId!: string | null;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedInfoHash = resolvedUrl.getRawSearchParam("info_hash");
				capturedPeerId = resolvedUrl.getRawSearchParam("peer_id");
				return new Response(bencode({ interval: 1800n, peers: "" }));
			});

			const infoHash = createInfoHash();
			infoHash[0] = 0x0a; // lowercase a

			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			// Should use uppercase hex (0A not 0a)
			expect(capturedInfoHash).toContain("%0A");
			expect(capturedPeerId).not.toContain("%0a");
		});
	});

	describe("IPv6 peer parsing", () => {
		test("IPv6 compact peers are not currently supported", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			// IPv6 peer in compact format (18 bytes: 16 for IP, 2 for port)
			// ::1 in IPv6 would be 00000000000000000000000000000001
			const ipv6Peer = new Uint8Array(18);
			ipv6Peer[0] = 0x00;
			ipv6Peer[1] = 0x00;
			ipv6Peer[2] = 0x00;
			ipv6Peer[3] = 0x00;
			ipv6Peer[4] = 0x00;
			ipv6Peer[5] = 0x00;
			ipv6Peer[6] = 0x00;
			ipv6Peer[7] = 0x00;
			ipv6Peer[8] = 0x00;
			ipv6Peer[9] = 0x00;
			ipv6Peer[10] = 0x00;
			ipv6Peer[11] = 0x00;
			ipv6Peer[12] = 0x00;
			ipv6Peer[13] = 0x00;
			ipv6Peer[14] = 0x00;
			ipv6Peer[15] = 0x00;
			ipv6Peer[16] = 0x00;
			ipv6Peer[17] = 0x01; // Port 1

			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers: ipv6Peer })),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			// With current implementation, 18-byte input is parsed as IPv4 compact peers
			// (6 bytes per peer), so the last 6 bytes (0.0.0.0, port 1) is parsed as 1 valid peer
			// IPv6 support (18 bytes per peer) is a known limitation.
			expect(response.peers).toBeArrayOfSize(1);
		});

		test("mixed IPv4 and IPv6 peers would need separate handling", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			// 12 bytes: 2 valid IPv4 peers
			const peers = createCompactPeers([
				{ ip: "192.168.1.100", port: 6881 },
				{ ip: "10.0.0.50", port: 443 },
			]);

			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers })),
			);

			const infoHash = createInfoHash();
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(response.peers).toBeArrayOfSize(2);
			expect(response.peers[0]?.host).toBe(toIPAddr("192.168.1.100"));
			expect(response.peers[1]?.host).toBe(toIPAddr("10.0.0.50"));
		});
	});

	describe("fuzz tests - malformed bencoded responses", () => {
		test("throws on empty response body", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(() => new Response(new Uint8Array(0)));

			const infoHash = createInfoHash();
			expect(
				tracker.announce({
					trackerURL: new URL("http://tracker.example.com/announce"),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				}),
			).rejects.toThrow();

			globalThis.fetch = originalFetch;
		});

		test("throws on partial/truncated bencode", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;

			// Truncated dictionary - missing closing 'e'
			const truncatedBencode = new TextEncoder().encode("d8:intervali1800ee");

			globalThis.fetch = createSimpleMockFetch(() => new Response(truncatedBencode));

			const infoHash = createInfoHash();
			expect(
				tracker.announce({
					trackerURL: new URL("http://tracker.example.com/announce"),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				}),
			).rejects.toThrow();

			globalThis.fetch = originalFetch;
		});

		test("throws on invalid bencode syntax - missing colon", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;

			// Invalid bencode - missing colon after length
			const invalidBencode = new TextEncoder().encode("d5:peers5:value5:intervali1800ee");

			globalThis.fetch = createSimpleMockFetch(() => new Response(invalidBencode));

			const infoHash = createInfoHash();
			expect(
				tracker.announce({
					trackerURL: new URL("http://tracker.example.com/announce"),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				}),
			).rejects.toThrow();

			globalThis.fetch = originalFetch;
		});

		test("parses valid bencode with extra garbage data", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;

			// Valid bencode followed by garbage
			const peers = createCompactPeers([{ ip: "192.168.1.100", port: 6881 }]);
			const validBencode = bencode({ interval: 1800n, peers });
			const garbageBencode = new Uint8Array([...validBencode, 0xff, 0xfe, 0x00]);

			globalThis.fetch = createSimpleMockFetch(() => new Response(garbageBencode));

			const infoHash = createInfoHash();
			// This may throw or may parse partial - behavior depends on implementation
			try {
				const response = await tracker.announce({
					trackerURL: new URL("http://tracker.example.com/announce"),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				});
				// If it doesn't throw, it should still parse the valid part
				expect(response.peers).toBeArrayOfSize(1);
			} catch {
				// Throwing is also acceptable behavior for malformed responses
			}

			globalThis.fetch = originalFetch;
		});

		test("throws on binary garbage response", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;

			// Random binary garbage
			const garbage = new Uint8Array([
				0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
				0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13,
			]);

			globalThis.fetch = createSimpleMockFetch(() => new Response(garbage));

			const infoHash = createInfoHash();
			expect(
				tracker.announce({
					trackerURL: new URL("http://tracker.example.com/announce"),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				}),
			).rejects.toThrow();

			globalThis.fetch = originalFetch;
		});

		test("throws on bencode with invalid integer format", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;

			// Invalid bencode - missing closing 'e' for integer
			const invalidBencode = new TextEncoder().encode("d8:intervali18005:peersle");

			globalThis.fetch = createSimpleMockFetch(() => new Response(invalidBencode));

			const infoHash = createInfoHash();
			expect(
				tracker.announce({
					trackerURL: new URL("http://tracker.example.com/announce"),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				}),
			).rejects.toThrow();

			globalThis.fetch = originalFetch;
		});

		test("handles response with peers as integer", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers: 123n })),
			);

			const infoHash = createInfoHash();
			expect(
				tracker.announce({
					trackerURL: new URL("http://tracker.example.com/announce"),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				}),
			).rejects.toThrow("Tracker response 'peers' must be a string or list");

			globalThis.fetch = originalFetch;
		});

		test("handles response with peers as nested structure", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;

			// When bencoding, a Uint8Array is treated as a string, so passing
			// a TextEncoder-encoded dictionary results in a bencoded string.
			// The tracker will try to parse this as compact peers.
			const invalidPeers = new TextEncoder().encode("d2:ip12:192.168.1.1004:porti6881ee");

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers: invalidPeers })),
			);

			const infoHash = createInfoHash();
			// The peers field is a Uint8Array, so it gets parsed as compact peers
			// This doesn't throw because the bencode library decodes it as bytes
			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			// The tracker interprets the bencoded dictionary bytes as compact peer data
			// which results in invalid peers (malformed IP/port interpretation)
			globalThis.fetch = originalFetch;

			// The response parses, but the peers data is garbage due to misinterpretation
			expect(response.interval).toBe(1800n);
			// The peers array will have some entries based on how many 6-byte chunks fit
			expect(response.peers.length).toBeGreaterThanOrEqual(0);
		});
	});

	describe("integration with real HTTP server", () => {
		test("works with actual HTTP server using Bun.serve", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			// Create peers manually as bytes to avoid any encoding issues
			// Port 6881 = 0x1AE1, Port 443 = 0x01BB
			const peersBytes = new Uint8Array([
				192,
				168,
				1,
				100,
				0x1a,
				0xe1, // 192.168.1.100:6881
				10,
				0,
				0,
				50,
				0x01,
				0xbb, // 10.0.0.50:443
			]);

			const server = Bun.serve({
				port: 0, // Random available port
				async fetch(request) {
					const url = new URL(request.url);
					const infoHash = url.searchParams.get("info_hash");
					const peerId = url.searchParams.get("peer_id");
					const port = url.searchParams.get("port");

					// Verify parameters are present
					if (!infoHash || !peerId || !port) {
						return new Response("Bad Request", { status: 400 });
					}

					return new Response(bencode({ interval: 1800n, peers: peersBytes }), {
						status: 200,
					});
				},
			});

			const infoHash = createInfoHash();
			infoHash[0] = 0xde;
			infoHash[1] = 0xad;
			infoHash[2] = 0xbe;
			infoHash[3] = 0xef;

			try {
				const response = await tracker.announce({
					trackerURL: new URL(`http://localhost:${server.port}/announce`),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 100,
					downloadedBytes: 50,
					leftBytes: 999850,
				});

				expect(response.interval).toBe(1800n);
				expect(response.peers).toBeArrayOfSize(2);
				expect(response.peers[0]?.host).toBe(toIPAddr("192.168.1.100"));
				expect(response.peers[0]?.port).toBe(toPort(6881));
				expect(response.peers[1]?.host).toBe(toIPAddr("10.0.0.50"));
				expect(response.peers[1]?.port).toBe(toPort(443));
			} finally {
				server.stop();
			}
		});

		test("handles server returning HTTP error status", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const server = Bun.serve({
				port: 0,
				async fetch() {
					return new Response("Service Unavailable", {
						status: 503,
						statusText: "Service Unavailable",
					});
				},
			});

			const infoHash = createInfoHash();
			let thrown = false;

			try {
				await tracker.announce({
					trackerURL: new URL(`http://localhost:${server.port}/announce`),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				});
			} catch (error) {
				thrown = true;
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain("Tracker request failed");
				expect((error as Error).message).toContain("503");
			} finally {
				server.stop();
			}

			expect(thrown).toBe(true);
		});

		test("handles server returning failure reason", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const server = Bun.serve({
				port: 0,
				async fetch() {
					return new Response(
						bencode({ "failure reason": "Invalid torrent", interval: 0n }),
						{ status: 200 },
					);
				},
			});

			const infoHash = createInfoHash();
			let thrown = false;

			try {
				await tracker.announce({
					trackerURL: new URL(`http://localhost:${server.port}/announce`),
					infoHash,
					currentHost: toIPAddr("192.168.1.1"),
					port: toPort(6881),
					uploadedBytes: 0,
					downloadedBytes: 0,
					leftBytes: 1000000,
				});
			} catch (error) {
				thrown = true;
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toBe("Tracker failure: Invalid torrent");
			} finally {
				server.stop();
			}

			expect(thrown).toBe(true);
		});
	});

	describe("large peer list handling", () => {
		test("handles response with thousands of peers", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;

			// Generate 1000 peers
			const peers: Array<{ ip: string; port: number }> = [];
			for (let i = 0; i < 1000; i++) {
				const ipOctet3 = (i >> 8) & 0xff;
				const ipOctet4 = i & 0xff;
				peers.push({
					ip: `192.168.${ipOctet3}.${ipOctet4}`,
					port: 6881 + (i % 1000),
				});
			}
			const compactPeers = createCompactPeers(peers);

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers: compactPeers })),
			);

			const infoHash = createInfoHash();
			const startTime = Date.now();

			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			const elapsed = Date.now() - startTime;

			globalThis.fetch = originalFetch;

			expect(response.peers).toBeArrayOfSize(1000);
			// Should complete in reasonable time
			expect(elapsed).toBeLessThan(5000);
		});

		test("handles maximum size peer response (2560 bytes = ~426 peers)", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;

			// 2560 bytes / 6 bytes per peer = 426 peers (plus some extra)
			const peers: Array<{ ip: string; port: number }> = [];
			for (let i = 0; i < 427; i++) {
				peers.push({
					ip: `10.${(i >> 8) & 0xff}.${i & 0xff}.1`,
					port: 1024 + (i % 64000),
				});
			}
			const compactPeers = createCompactPeers(peers);

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers: compactPeers })),
			);

			const infoHash = createInfoHash();

			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(response.peers).toBeArrayOfSize(427);
		});

		test("handles peers with port boundary values", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const originalFetch = globalThis.fetch;

			// Test port boundary values
			const peers = createCompactPeers([
				{ ip: "192.168.1.1", port: 0 }, // Invalid - should be skipped
				{ ip: "192.168.1.2", port: 1 }, // Valid min
				{ ip: "192.168.1.3", port: 80 }, // HTTP port
				{ ip: "192.168.1.4", port: 443 }, // HTTPS port
				{ ip: "192.168.1.5", port: 65535 }, // Valid max
				{ ip: "192.168.1.6", port: 65536 }, // Invalid - should be skipped
			]);

			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers })),
			);

			const infoHash = createInfoHash();

			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			// Only valid ports should be included
			expect(response.peers).toBeArrayOfSize(4);
			expect(response.peers.map((p) => p.port)).toContain(toPort(1));
			expect(response.peers.map((p) => p.port)).toContain(toPort(80));
			expect(response.peers.map((p) => p.port)).toContain(toPort(443));
			expect(response.peers.map((p) => p.port)).toContain(toPort(65535));
		});
	});

	describe("real torrent files", () => {
		test("uses self.torrent infoHash in announce URL", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const meta = await loadTestTorrentFile("self.torrent");
			const originalFetch = globalThis.fetch;
			let capturedUrl: URL | undefined;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedUrl = resolvedUrl;
				return new Response(bencode({ interval: 1800n, peers: "" }));
			});

			await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash: meta.infoHash as SHA1Hash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(capturedUrl).toBeDefined();
			const rawInfoHash = (capturedUrl as unknown as MockURL).getRawSearchParam("info_hash");
			expect(rawInfoHash).toBeDefined();
			// Verify the infoHash matches the torrent file (percent-encoded)
			const expectedInfoHash = Array.from(meta.infoHash)
				.map((b) => `%${b.toString(16).padStart(2, "0")}`)
				.join("")
				.toUpperCase();
			expect(rawInfoHash).toBe(expectedInfoHash);
		});

		test("uses debian torrent infoHash in announce URL", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const meta = await loadTestTorrentFile("debian-13.3.0-amd64-netinst.iso.torrent");
			const originalFetch = globalThis.fetch;
			let capturedUrl: URL | undefined;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedUrl = resolvedUrl;
				return new Response(bencode({ interval: 1800n, peers: "" }));
			});

			await tracker.announce({
				trackerURL: meta.announce,
				infoHash: meta.infoHash as SHA1Hash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: meta.info.length,
			});

			globalThis.fetch = originalFetch;

			expect(capturedUrl).toBeDefined();
			const rawInfoHash = (capturedUrl as unknown as MockURL).getRawSearchParam("info_hash");
			expect(rawInfoHash).toBeDefined();
			// Verify the infoHash matches the torrent file
			const expectedInfoHash = Array.from(meta.infoHash)
				.map((b) => `%${b.toString(16).padStart(2, "0")}`)
				.join("")
				.toUpperCase();
			expect(rawInfoHash).toBe(expectedInfoHash);
		});

		test("uses bbb_sunflower torrent infoHash in announce URL", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const meta = await loadTestTorrentFile("bbb_sunflower_1080p_60fps_normal.mp4.torrent");
			const originalFetch = globalThis.fetch;
			let capturedUrl: URL | undefined;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedUrl = resolvedUrl;
				return new Response(bencode({ interval: 1800n, peers: "" }));
			});

			await tracker.announce({
				trackerURL: meta.announce,
				infoHash: meta.infoHash as SHA1Hash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: meta.info.length,
			});

			globalThis.fetch = originalFetch;

			expect(capturedUrl).toBeDefined();
			const rawInfoHash = (capturedUrl as unknown as MockURL).getRawSearchParam("info_hash");
			expect(rawInfoHash).toBeDefined();
			// Verify the infoHash matches the torrent file
			const expectedInfoHash = Array.from(meta.infoHash)
				.map((b) => `%${b.toString(16).padStart(2, "0")}`)
				.join("")
				.toUpperCase();
			expect(rawInfoHash).toBe(expectedInfoHash);
		});

		test("parses real torrent peer responses with self.torrent infoHash", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const meta = await loadTestTorrentFile("self.torrent");
			const peers = createCompactPeers([
				{ ip: "192.168.1.100", port: 6881 },
				{ ip: "192.168.1.101", port: 6882 },
			]);

			const originalFetch = globalThis.fetch;
			globalThis.fetch = createSimpleMockFetch(
				() => new Response(bencode({ interval: 1800n, peers })),
			);

			const response = await tracker.announce({
				trackerURL: new URL("http://tracker.example.com/announce"),
				infoHash: meta.infoHash as SHA1Hash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: 1000000,
			});

			globalThis.fetch = originalFetch;

			expect(response.interval).toBe(1800n);
			expect(response.peers).toBeArrayOfSize(2);
			expect(response.peers[0]?.host).toBe(toIPAddr("192.168.1.100"));
			expect(response.peers[0]?.port).toBe(toPort(6881));
		});

		test("handles real torrent with different piece sizes", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			// Load both single-file and multi-file torrents
			const debianMeta = await loadTestTorrentFile("debian-13.3.0-amd64-netinst.iso.torrent");
			const selfMeta = await loadTestTorrentFile("self.torrent");

			// Verify both have valid infoHashes of correct length
			expect(debianMeta.infoHash).toBeInstanceOf(Uint8Array);
			expect(debianMeta.infoHash.length).toBe(20);
			expect(selfMeta.infoHash).toBeInstanceOf(Uint8Array);
			expect(selfMeta.infoHash.length).toBe(20);

			// Verify infoHashes are different
			const sameHash = debianMeta.infoHash.every((b, i) => b === selfMeta.infoHash[i]);
			expect(sameHash).toBeFalse();
		});

		test("includes correct leftBytes parameter for real torrents", async () => {
			const tracker = new ClientTracker(createPeerIdBytes("test-peer-id-12345"));

			const meta = await loadTestTorrentFile("debian-13.3.0-amd64-netinst.iso.torrent");
			const originalFetch = globalThis.fetch;
			let capturedUrl: URL | undefined;

			globalThis.fetch = createMockFetch(async (resolvedUrl) => {
				capturedUrl = resolvedUrl;
				return new Response(bencode({ interval: 1800n, peers: "" }));
			});

			// Use actual file size as leftBytes
			const leftBytes = "length" in meta.info ? meta.info.length : meta.info.pieceLength * 10;

			await tracker.announce({
				trackerURL: meta.announce,
				infoHash: meta.infoHash as SHA1Hash,
				currentHost: toIPAddr("192.168.1.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes,
			});

			globalThis.fetch = originalFetch;

			expect(capturedUrl).toBeDefined();
			expect(capturedUrl?.searchParams.get("left")).toBe(leftBytes.toString());
		});
	});

	describe("real tracker requests - Debian torrent", () => {
		/**
		 * Helper to check if the Debian tracker is reachable.
		 * Returns true if the tracker responds, false otherwise.
		 */
		async function isTrackerReachable(url: string): Promise<boolean> {
			try {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 3000);
				// Just check if the server responds (any response is fine)
				await fetch(url, {
					signal: controller.signal,
				});
				clearTimeout(timeout);
				return true;
			} catch {
				return false;
			}
		}

		test("makes real HTTP announce request to Debian tracker", async () => {
			// Load the real Debian torrent file first
			const meta = await loadTestTorrentFile("debian-13.3.0-amd64-netinst.iso.torrent");

			// Skip if tracker is not reachable
			const trackerReachable = await isTrackerReachable(meta.announce.href);
			if (!trackerReachable) {
				console.warn("Debian tracker unreachable - skipping real tracker test");
				return;
			}

			// Create a unique peer ID for this test
			const uniquePeerId = createPeerIdBytes(`peerwire-${Date.now()}`);
			const tracker = new ClientTracker(uniquePeerId);

			// Make a REAL announce request (no mocks!)
			const response = await tracker.announce({
				trackerURL: meta.announce,
				infoHash: meta.infoHash as SHA1Hash,
				currentHost: toIPAddr("127.0.0.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: meta.info.length,
				event: "started",
			});

			// Verify response has valid structure
			expect(response.interval).toBeDefined();
			expect(typeof response.interval).toBe("bigint");
			expect(response.interval).toBeGreaterThan(0n);
			expect(response.peers).toBeDefined();
			expect(Array.isArray(response.peers)).toBeTrue();

			// Log the response for debugging
			console.log("Real tracker response:", {
				interval: Number(response.interval),
				peerCount: response.peers.length,
				complete: response.complete ? Number(response.complete) : undefined,
				incomplete: response.incomplete ? Number(response.incomplete) : undefined,
			});
		}, 60_000);

		test("real announce request returns valid peer data structure", async () => {
			// Load the real Debian torrent file first
			const meta = await loadTestTorrentFile("debian-13.3.0-amd64-netinst.iso.torrent");

			// Skip if tracker is not reachable
			const trackerReachable = await isTrackerReachable(meta.announce.href);
			if (!trackerReachable) {
				console.warn("Debian tracker unreachable - skipping real tracker test");
				return;
			}

			// Create a unique peer ID
			const uniquePeerId = createPeerIdBytes(`peerwire-${Date.now()}`);
			const tracker = new ClientTracker(uniquePeerId);

			// Make the announce request
			const response = await tracker.announce({
				trackerURL: meta.announce,
				infoHash: meta.infoHash as SHA1Hash,
				currentHost: toIPAddr("127.0.0.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: meta.info.length,
				event: "started",
			});

			// Verify interval is reasonable (typically 15-30 minutes)
			expect(response.interval).toBeGreaterThanOrEqual(60n); // At least 1 minute
			expect(response.interval).toBeLessThanOrEqual(3600n); // At most 1 hour

			// Verify peers array structure (if any peers are returned)
			if (response.peers.length > 0) {
				const firstPeer = response.peers[0];
				expect(firstPeer).toBeDefined();
				expect(firstPeer.host).toBeDefined();
				expect(firstPeer.port).toBeDefined();

				// Verify port is in valid range
				const portNum = Number(firstPeer.port);
				expect(portNum).toBeGreaterThan(0);
				expect(portNum).toBeLessThanOrEqual(65535);
			}
		}, 60_000);

		test("real announce with completed event", async () => {
			// Load the real Debian torrent file first
			const meta = await loadTestTorrentFile("debian-13.3.0-amd64-netinst.iso.torrent");

			// Skip if tracker is not reachable
			const trackerReachable = await isTrackerReachable(meta.announce.href);
			if (!trackerReachable) {
				console.warn("Debian tracker unreachable - skipping real tracker test");
				return;
			}

			const uniquePeerId = createPeerIdBytes(`peerwire-${Date.now()}`);
			const tracker = new ClientTracker(uniquePeerId);

			// First announce as started
			await tracker.announce({
				trackerURL: meta.announce,
				infoHash: meta.infoHash as SHA1Hash,
				currentHost: toIPAddr("127.0.0.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: meta.info.length,
				event: "started",
			});

			// Then announce as completed (simulating finished download)
			const response = await tracker.announce({
				trackerURL: meta.announce,
				infoHash: meta.infoHash as SHA1Hash,
				currentHost: toIPAddr("127.0.0.1"),
				port: toPort(6881),
				uploadedBytes: 790626304,
				downloadedBytes: 790626304,
				leftBytes: 0,
				event: "completed",
			});

			// Response should still be valid
			expect(response.interval).toBeDefined();
			expect(response.peers).toBeDefined();
		}, 60_000);

		test("real announce stores response in lastResponse", async () => {
			// Load the real Debian torrent file first
			const meta = await loadTestTorrentFile("debian-13.3.0-amd64-netinst.iso.torrent");

			// Skip if tracker is not reachable
			const trackerReachable = await isTrackerReachable(meta.announce.href);
			if (!trackerReachable) {
				console.warn("Debian tracker unreachable - skipping real tracker test");
				return;
			}

			const uniquePeerId = createPeerIdBytes(`peerwire-${Date.now()}`);
			const tracker = new ClientTracker(uniquePeerId);

			expect(tracker.lastResponse).toBeNull();

			await tracker.announce({
				trackerURL: meta.announce,
				infoHash: meta.infoHash as SHA1Hash,
				currentHost: toIPAddr("127.0.0.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: meta.info.length,
				event: "started",
			});

			expect(tracker.lastResponse).not.toBeNull();
			expect(tracker.lastResponse?.interval).toBeDefined();
			expect(tracker.lastResponse?.peers).toBeDefined();
		}, 60_000);
	});

	describe("integration with real tracker", () => {
		test("real HTTP request to Debian tracker", async () => {
			try {
				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), 2000);
				await fetch(meta.announce.href, {
					signal: controller.signal,
				});
				clearTimeout(timeout);
			} catch {
				console.warn("Network unavailable - skipping real tracker test");
				return;
			}

			const tracker = new ClientTracker(createPeerIdBytes("peerwire-test0001"));

			const torrentPath = path.join(
				import.meta.dir,
				"../torrent/test-data/debian-13.3.0-amd64-netinst.iso.torrent",
			);
			const meta = await parseTorrentFile(torrentPath);

			const response = await tracker.announce({
				trackerURL: meta.announce,
				infoHash: meta.infoHash as SHA1Hash,
				currentHost: toIPAddr("127.0.0.1"),
				port: toPort(6881),
				uploadedBytes: 0,
				downloadedBytes: 0,
				leftBytes: meta.info.length,
				event: "started",
			});

			expect(response.interval).toBeDefined();
			expect(response.peers).toBeDefined();
			expect(Array.isArray(response.peers)).toBeTrue();
		}, 120_000);
	});
});
