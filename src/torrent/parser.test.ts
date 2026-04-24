import { describe, expect, test } from "bun:test";
import path from "node:path";
import type {
	PieceData,
	TorrentMetadataMultipleFilesInfo,
	TorrentMetadataSingleFileInfo,
	UnixTimestamp,
} from "./metadata";
import { parseTorrentFile } from "./parse";

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function isSingleFile(
	info: TorrentMetadataSingleFileInfo | TorrentMetadataMultipleFilesInfo,
): info is TorrentMetadataSingleFileInfo {
	return "length" in info;
}
function isMultipleFile(
	info: TorrentMetadataSingleFileInfo | TorrentMetadataMultipleFilesInfo,
): info is TorrentMetadataMultipleFilesInfo {
	return "files" in info;
}

describe("multiple files torrent", () => {
	test("parses Ubuntu ISO correctly", async () => {
		const torrentPath = path.join(import.meta.dir, "./test-data/self.torrent");
		const meta = await parseTorrentFile(torrentPath);
		expect(meta.announce.toString()).toBe("https://github.com/rounakkumarsingh/peerwire");
		expect(meta.comment).toBe("this repo's torrent");
		expect(meta.createdBy).toBe("mktorrent 1.1");
		expect(meta.creationDate).toBe(1772644670 as UnixTimestamp);
		expect(isMultipleFile(meta.info)).toBeTrue();
		expect(isSingleFile(meta.info)).toBeFalse();
		const info = meta.info as TorrentMetadataMultipleFilesInfo;
		expect(info.name).toBe("peerwire");
		expect(info.pieceLength).toBe(32768 as PieceData);
		expect(info.files).toBeArrayOfSize(15);
		expect(toHex(meta.infoHash)).toBe("645f3a89807b3b02ee4f0e6c722dad8962bb243b");
		expect(info.pieces.length).toBe(7);
	});
});

describe("error handling", () => {
	test("throws when file does not exist", async () => {
		const torrentPath = path.join(import.meta.dir, "test-data/non-existent.torrent");
		expect(async () => await parseTorrentFile(torrentPath)).toThrow();
	});

	test("throws when file is not a valid torrent (e.g., package.json)", async () => {
		const filePath = path.join(import.meta.dir, "../../package.json");
		expect(async () => await parseTorrentFile(filePath)).toThrow();
	});
});

describe("single file torrent", () => {
	test("parses Debian ISO torrent correctly", async () => {
		const torrentPath = path.join(
			import.meta.dir,
			"test-data/debian-13.3.0-amd64-netinst.iso.torrent",
		);
		const meta = await parseTorrentFile(torrentPath);

		expect(meta.announce.toString()).toBe("http://bttracker.debian.org:6969/announce");
		expect(toHex(meta.infoHash)).toBe("86f635034839f1ebe81ab96bee4ac59f61db9dde");
		expect(meta.creationDate).toBe(1768050335 as UnixTimestamp);
		expect(meta.createdBy).toBe("mktorrent 1.1");
		expect(meta.comment).toBe("Debian CD from cdimage.debian.org");

		expect(meta.info.name).toBe("debian-13.3.0-amd64-netinst.iso");

		expect(isMultipleFile(meta.info)).toBeFalse();
		expect(isSingleFile(meta.info)).toBeTrue();
		const info = meta.info as TorrentMetadataSingleFileInfo;
		expect(info.length).toBe(790626304);
		expect(info.pieces.length).toBeGreaterThan(0);
	});
	test("parses video torrent correctly", async () => {
		const torrentPath = path.join(
			import.meta.dir,
			"test-data/bbb_sunflower_1080p_60fps_normal.mp4.torrent",
		);

		const meta = await parseTorrentFile(torrentPath);

		expect(meta.announce.href).toBe("udp://tracker.openbittorrent.com:80/announce");

		expect(meta.announceList).toBeArrayOfSize(2);

		expect(meta.comment).toBe("Big Buck Bunny, Sunflower version");
		expect(meta.createdBy).toBe("uTorrent/3320");
		expect(meta.creationDate).toBe(1387308159 as UnixTimestamp);
		expect(meta.encoding).toBe("UTF-8");
		expect(isSingleFile(meta.info)).toBeTrue();
		expect(isMultipleFile(meta.info)).toBeFalse();
		const info = meta.info as TorrentMetadataSingleFileInfo;
		expect(info.name).toBe("bbb_sunflower_1080p_60fps_normal.mp4");
		expect(info.pieceLength).toBe(524288 as PieceData);
		expect(info.length).toBeGreaterThan(0);
		expect(meta.infoHash.length).toBe(20);
		expect(toHex(meta.infoHash)).toBe("565db305a27ffb321fcc7b064afd7bd73aedda2b");
	});
});
