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
				!target.isConnected ||
				!entry.isIntersecting ||
				Math.fround(entry.intersectionRatio) < comparableThreshold ||
				bounds.width <= 0 ||
				bounds.height <= 0
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
		observer = undefined;
		if (
			document.visibilityState !== "visible" ||
			typeof IntersectionObserver === "undefined"
		)
			return;

		observer = new IntersectionObserver(notify, { threshold });
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
			observer = undefined;
			pending.clear();
			reported.clear();
		},
	};
}
