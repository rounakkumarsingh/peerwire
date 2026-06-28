import { PeerWireConnection } from "./peer/communication";
import type { SHA1Hash, TorrentMetadataSingleFileInfo } from "./torrent/metadata";
import { parseTorrentFile } from "./torrent/parse";
import { ClientTracker } from "./tracker/tracker";
import { generatePeerId } from "./tracker/utils";

const torrentFilePath = await parseTorrentFile(
	`${import.meta.dir}/torrent/test-data/debian-13.3.0-amd64-netinst.iso.torrent`,
);
console.log(torrentFilePath);
const info = torrentFilePath.info as TorrentMetadataSingleFileInfo;

const x = new ClientTracker(generatePeerId());

const y = await x.announce({
	trackerURL: new URL(torrentFilePath.announce),
	downloadedBytes: 0,
	infoHash: torrentFilePath.infoHash,
	uploadedBytes: 0,
	leftBytes: info.length,
	currentHost: "127.0.0.1" as import("./tracker/types").IPAddr,
	port: 6881 as import("./tracker/types").Port,
	event: "started",
});

console.log(`\nFound ${y.peers.length} peers. Connecting to all...\n`);

// Connect to all peers concurrently
const connections = await Promise.allSettled(
	y.peers.map(async (peer) => {
		try {
			const conn = await PeerWireConnection.connect(
				peer,
				torrentFilePath.infoHash,
				x.peerId as Uint8Array as SHA1Hash,
				torrentFilePath,
			);
			console.log(`[${peer.host}:${peer.port}] Connected successfully`);
			return conn;
		} catch (err) {
			console.log(`[${peer.host}:${peer.port}] Connection failed:`, (err as Error).message);
			throw err;
		}
	}),
);

const successfulConnections = connections
	.filter((r): r is PromiseFulfilledResult<PeerWireConnection> => r.status === "fulfilled")
	.map((r) => r.value);

console.log(
	`\n✓ Successfully connected to ${successfulConnections.length}/${y.peers.length} peers`,
);
console.log("Listening for messages from all connected peers...\n");

// Keep process alive without blocking the event loop
// The socket connection keeps the process alive automatically
await new Promise(() => {});
