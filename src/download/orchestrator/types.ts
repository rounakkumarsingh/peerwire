import type { PathLike } from "bun";

export interface DownloadConfig {
	maxPeers: number;
	downloadPath: PathLike;
	blockSizeInBytes: number;
	pipelineDepth: number;
	chokeIntervalInMillis: number;
	trackerAnnounceIntervalInMillis: number;
}

export const DefaultConfig: DownloadConfig = {
	maxPeers: 50,
	downloadPath: "./",
	blockSizeInBytes: 16384,
	pipelineDepth: 5,
	chokeIntervalInMillis: 10000,
	trackerAnnounceIntervalInMillis: 1800000,
};

export enum DownloadState {
	Initializing = "Initializing",
	Downloading = "Downloading",
	Verifying = "Verifying",
	Complete = "Complete",
	Paused = "Paused",
	Error = "Error",
}

export interface DownloadStats {
	progress: number;
	peers: number;
	speed: number;
	size: number;
	remaining: number;
	blocks: number;
}

export type OrchestratorEvents = {
	"state-changed": (state: DownloadState) => void;
	"stats-updated": (stats: DownloadStats) => void;
};

export interface BlockRequest {
	readonly piece: number;
	readonly offset: number;
	readonly length: number;
}

export interface PieceProgress {
	readonly blocks: number;
	readonly completed: number;
	readonly verified: boolean;
}
