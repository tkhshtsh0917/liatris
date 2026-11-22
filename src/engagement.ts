type EngagementOptions = {
	signal: AbortSignal;
	idleMs?: number;
	onCheckpoint: (engagedMs: number) => void;
};

const activityEvents = ["pointerdown", "keydown", "wheel"] as const;

/** Measures whole-second deltas for one consented, rendered detail view. */
export function observeEngagement({
	signal,
	idleMs = 60_000,
	onCheckpoint,
}: EngagementOptions) {
	if (!Number.isSafeInteger(idleMs) || idleMs < 1_000 || idleMs > 3_600_000) {
		throw new RangeError(
			"engagement idle timeout must be between 1000 and 3600000 milliseconds",
		);
	}
	if (signal.aborted) return { checkpoint() {}, close() {} };

	const listeners = new AbortController();
	const registration = {
		signal: listeners.signal,
		passive: true,
		capture: true,
	};
	let displayed = true;
	let eligible = document.visibilityState === "visible" && document.hasFocus();
	let lastMonotonic = performance.now();
	let lastWall = Date.now();
	let idleRemaining = idleMs;
	let unreported = 0;

	function settle() {
		const mono = performance.now();
		const wall = Date.now();
		const elapsed = Math.max(0, mono - lastMonotonic);
		if (eligible) unreported += Math.min(elapsed, idleRemaining);

		// The wall clock can advance during sleep while the monotonic clock pauses.
		idleRemaining = Math.max(
			0,
			idleRemaining - Math.max(elapsed, wall - lastWall),
		);
		lastMonotonic = mono;
		lastWall = wall;
	}

	function checkpoint() {
		if (listeners.signal.aborted || signal.aborted) return;

		settle();
		const wholeSeconds = Math.floor(unreported / 1000) * 1000;
		unreported -= wholeSeconds;
		if (wholeSeconds > 0) onCheckpoint(wholeSeconds);
	}

	function syncVisibility() {
		checkpoint();
		eligible =
			displayed &&
			document.visibilityState === "visible" &&
			document.hasFocus();
	}

	function onActivity(event: Event) {
		if (
			!event.isTrusted ||
			!displayed ||
			document.visibilityState !== "visible" ||
			!document.hasFocus()
		)
			return;

		settle();
		eligible = true;
		idleRemaining = idleMs;
	}

	function close() {
		listeners.abort();
		unreported = 0;
		signal.removeEventListener("abort", close);
	}

	for (const type of activityEvents)
		document.addEventListener(type, onActivity, registration);
	document.addEventListener("visibilitychange", syncVisibility, registration);
	window.addEventListener("focus", syncVisibility, {
		...registration,
		capture: false,
	});
	window.addEventListener(
		"blur",
		() => {
			checkpoint();
			eligible = false;
		},
		{ ...registration, capture: false },
	);
	window.addEventListener(
		"pagehide",
		() => {
			displayed = false;
			syncVisibility();
		},
		registration,
	);
	window.addEventListener(
		"pageshow",
		() => {
			displayed = true;
			syncVisibility();
		},
		registration,
	);
	signal.addEventListener("abort", close, { once: true });

	return { checkpoint, close };
}
