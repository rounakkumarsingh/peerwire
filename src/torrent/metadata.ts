export type UnixTimestamp = number & { readonly __brand: "UnixTimestamp" };
export type TrackerURL = URL & { readonly __brand: "TrackerURL" };

export interface TorrentMetadata {
	info: TorrentMetadataMultipleFilesInfo | TorrentMetadataSingleFileInfo;
	infoHash: SHA1Hash;
	announce: TrackerURL;
	announceList?: TrackerURL[][];
	creationDate?: UnixTimestamp;
	comment?: string;
	createdBy?: string;
	encoding?: string;
}

export type SHA1Hash = Uint8Array & { readonly __brand: "SHA1Hash" };
export type PieceData = number & { readonly __brand: "PieceLength" };

export interface TorrentMetadataFileInfo {
	pieceLength: PieceData; // nominal piece size, usually power of 2. Current Best Practice -> <= 512KiB
	pieces: SHA1Hash[]; // array of 20-byte SHA1 hashes
	private?: boolean;
}

export type MD5Hex = string & { readonly __brand: "MD5Hex" };

export interface TorrentMetadataSingleFileInfo extends TorrentMetadataFileInfo {
	name: string; // Name of file
	length: number; // length of file
	md5sum?: MD5Hex;
}

export interface TorrentMetadataFileEntry {
	length: number;
	md5sum?: MD5Hex;
	path: readonly string[]; // an array of dirs and a file name at last. eg, dir1/dir2/file -> ['dir1', 'dir2', 'file']
}

export interface TorrentMetadataMultipleFilesInfo
	extends TorrentMetadataFileInfo {
	name: string; // name of the directory
	files: TorrentMetadataFileEntry[]; // one for each file
}
