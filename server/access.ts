import type { IncomingMessage } from "node:http";
import { isBearerToken } from "../src/bearer.ts";
import type { Profile } from "../src/profile.ts";

type Scope = Pick<Profile, "tenant" | "application">;

export type VerifiedBearer = Scope & {
	audience: string;
	permission: string;
	expiresAtMs: number;
};

export type IntakeAccess =
	| {
			audience: string;
			/** Authenticates a credential and returns its trusted claims. */
			verifyBearer: (token: string) => Promise<VerifiedBearer | undefined>;
	  }
	| {
			/** Enables direct local development on this exact IPv4 loopback origin. */
			loopbackOrigin: string;
	  };

type AccessFailure = 401 | 403 | 503;

function loopbackAccess(origin: string) {
	const url = new URL(origin);
	if (
		url.origin !== origin ||
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1"
	) {
		throw new TypeError("expected an HTTP IPv4 loopback origin");
	}

	return (request: IncomingMessage): 403 | undefined => {
		const {
			origin: sentOrigin,
			host,
			"sec-fetch-site": site,
		} = request.headers;
		if (
			request.socket.localAddress !== "127.0.0.1" ||
			request.socket.remoteAddress !== "127.0.0.1" ||
			request.socket.localPort !== Number(url.port || 80) ||
			host !== url.host ||
			(sentOrigin !== undefined && sentOrigin !== origin) ||
			(site !== undefined && site !== "same-origin")
		)
			return 403;
	};
}

function readBearer(request: IncomingMessage) {
	const values = request.headersDistinct.authorization;
	if (values?.length !== 1) return;

	const token = /^Bearer (.+)$/i.exec(values[0])?.[1];
	if (isBearerToken(token)) return token;
}

/** Checks the connection policy before reading or parsing an event body. */
export function createIntakeAccess(scope: Scope, access: IntakeAccess) {
	if ("loopbackOrigin" in access) {
		if ("verifyBearer" in access)
			throw new TypeError("expected exactly one intake access policy");
		return loopbackAccess(access.loopbackOrigin);
	}
	const { audience, verifyBearer } = access;
	if (
		typeof verifyBearer !== "function" ||
		typeof audience !== "string" ||
		!audience.trim()
	) {
		throw new TypeError(
			"intake requires a token verifier and trusted audience",
		);
	}

	return async (
		request: IncomingMessage,
	): Promise<AccessFailure | undefined> => {
		const token = readBearer(request);
		if (!token) return 401;

		let authorized: VerifiedBearer | undefined;
		try {
			authorized = await verifyBearer(token);
		} catch {
			return 503;
		}
		if (
			!authorized ||
			authorized.audience !== audience ||
			!Number.isSafeInteger(authorized.expiresAtMs) ||
			authorized.expiresAtMs <= Date.now()
		)
			return 401;

		if (
			authorized.tenant !== scope.tenant ||
			authorized.application !== scope.application ||
			authorized.permission !== "liatris:write"
		)
			return 403;
	};
}
