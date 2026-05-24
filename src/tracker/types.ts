import { isIP } from "node:net";

export type IPAddr = string & { __brand: "ip"; readonly: true };
export type Port = number & { __brand: "port"; readonly: true };

export function isIPAddr(ip: string): ip is IPAddr {
	return isIP(ip) !== 0;
}

export type Hostname = string & { __brand: "hostname"; readonly: true };

export function isHostname(value: string): value is Hostname {
	if (!value || value.length > 253) return false;
	const labels = value.split(".");
	const isValidLength = labels.every(
		(label) => label.length >= 1 && label.length <= 63,
	);
	if (!isValidLength) return false;
	const hostnameRegex = /^([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])$/;
	return labels.every((label) => hostnameRegex.test(label));
}

export function isPort(port: number): port is Port {
	return 0 <= port && port <= 65535;
}

export type PeerId = Uint8Array & { readonly __brand: "PeerId" };

export function createPeerId(buf: Uint8Array): PeerId {
	if (buf.length !== 20) {
		throw new Error("PeerId must be exactly 20 bytes");
	}
	return buf as PeerId;
}

export type TrackerPeer = {
	peerId?: PeerId;
	host: IPAddr | Hostname;
	port: Port;
};

export type TrackerResponse = {
	failure?: string;
	warning?: string;
	interval?: bigint;
	trackerId?: string;
	minInterval?: bigint;
	complete?: bigint;
	incomplete?: bigint;
	peers: TrackerPeer[];
};
