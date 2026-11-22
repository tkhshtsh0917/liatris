import { defaultMinVisiblePercent, type Profile } from "./profile.ts";

type Registration = { ordinal: number };

/**
 * Measures geometric visibility for explicitly registered cards in one result set.
 * Each rank is reported at most once. Close the observer when replacing the set
 * or revoking consent. The host supplies the event and its search context.
 */
export function observeResultImpressions(
	config: Partial<Profile["impressions"]>,
	onImpression: (ordinal: number) => void,
) {
	const percent = config.minVisiblePercent ?? defaultMinVisiblePercent;
	if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
		throw new RangeError(
			"minimum visible percent must be an integer from 1 to 100",
		);
	}

	const threshold = percent / 100;
	// Some engines expose the observer's ratio at single-precision resolution.
	const comparableThreshold = Math.fround(threshold);
	const pending = new Map<Element, Registration>();
	const reported = new Set<number>();
	let observer: IntersectionObserver | undefined;
	let resizeObserver: ResizeObserver | undefined;
	let closed = false;

	function notify(
		entries: IntersectionObserverEntry[],
		source: IntersectionObserver,
	) {
		if (source !== observer || document.visibilityState !== "visible") return;

		const observations = entries.map((entry) => ({
			entry,
			card: pending.get(entry.target),
		}));
		for (const { entry, card } of observations) {
			const { target, boundingClientRect: bounds } = entry;
			if (
				closed ||
				source !== observer ||
				!card ||
				card !== pending.get(target) ||
				!target.isConnected
			)
				continue;

			if (bounds.width <= 0 || bounds.height <= 0) {
				resizeObserver?.observe(target, { box: "border-box" });
				continue;
			}
			resizeObserver?.unobserve(target);
			if (
				!entry.isIntersecting ||
				Math.fround(entry.intersectionRatio) < comparableThreshold
			)
				continue;

			source.unobserve(target);
			pending.delete(target);
			if (reported.has(card.ordinal)) continue;

			reported.add(card.ordinal);
			onImpression(card.ordinal);
		}
	}

	function unregister(target: Element) {
		pending.delete(target);
		resizeObserver?.unobserve(target);
		const source = observer;
		if (!source) return;

		source.unobserve(target);
		// A recycled element can still have queued observations for its old rank.
		notify(
			source.takeRecords().filter((entry) => entry.target !== target),
			source,
		);
	}

	function syncVisibility() {
		observer?.disconnect();
		resizeObserver?.disconnect();
		observer = undefined;
		resizeObserver = undefined;
		if (
			document.visibilityState !== "visible" ||
			typeof IntersectionObserver === "undefined"
		)
			return;

		const source = new IntersectionObserver(notify, { threshold });
		observer = source;
		if (typeof ResizeObserver !== "undefined") {
			resizeObserver = new ResizeObserver((entries, resize) => {
				if (observer !== source) return;
				for (const { target } of entries) {
					const card = pending.get(target);
					if (!card || !target.isConnected) continue;
					const { width, height } = target.getBoundingClientRect();
					if (width <= 0 || height <= 0) continue;

					// A zero area target can already have an intersection ratio of 1.
					resize.unobserve(target);
					source.unobserve(target);
					notify(
						source.takeRecords().filter((entry) => entry.target !== target),
						source,
					);
					if (observer === source && pending.get(target) === card)
						source.observe(target);
				}
			});
		}
		for (const target of pending.keys()) observer.observe(target);
	}

	document.addEventListener("visibilitychange", syncVisibility);
	syncVisibility();

	return {
		/** Registers a card by its displayed 1-based rank. Returns an unregister callback. */
		observe(target: Element, ordinal: number) {
			if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
				throw new RangeError("expected a positive displayed rank");
			}
			if (closed) throw new Error("impression observer is closed");

			if (pending.has(target)) unregister(target);
			if (closed) throw new Error("impression observer is closed");
			if (reported.has(ordinal)) return () => {};

			const card = { ordinal };
			pending.set(target, card);
			observer?.observe(target);
			return () => {
				if (pending.get(target) !== card) return;
				unregister(target);
			};
		},
		close() {
			closed = true;
			document.removeEventListener("visibilitychange", syncVisibility);
			observer?.disconnect();
			resizeObserver?.disconnect();
			observer = undefined;
			resizeObserver = undefined;
			pending.clear();
			reported.clear();
		},
	};
}
