const tokenPattern = /^[A-Za-z0-9._~+/-]+={0,2}$/;

/** Checks transport syntax and size. Authentication is performed by the verifier. */
export function isBearerToken(token: unknown): token is string {
	return (
		typeof token === "string" &&
		token.length <= 4096 &&
		token.trim() === token &&
		tokenPattern.test(token)
	);
}
