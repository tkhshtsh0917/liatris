//! Inactivity-based session boundaries for native and browser hosts.
#![deny(unsafe_op_in_unsafe_fn)]

/// The GA4-inspired default of 30 minutes of inactivity in milliseconds.
pub const DEFAULT_IDLE_MS: u32 = 30 * 60 * 1_000;
const MINUTE_MS: u32 = 60 * 1_000;
const DAY_MS: u32 = 24 * 60 * MINUTE_MS;
const MAX_CLOCK_ROLLBACK_MS: f64 = 5.0 * 60_000.0;
const MAX_DATE_MS: f64 = 8_640_000_000_000_000.0;

fn valid_time(value: f64) -> bool {
    (0.0..=MAX_DATE_MS).contains(&value) && value.fract() == 0.0
}

/// Returns the supported default inactivity timeout for host callers.
#[unsafe(no_mangle)]
pub extern "C" fn session_default_idle_ms() -> u32 {
    DEFAULT_IDLE_MS
}

/// Classifies an activity at `now_ms` using the last accepted activity time.
/// Pass `-1` for absent state and `0` for the default timeout.
/// Returns `0` for invalid input, `1` to keep, or `2` to start a session.
#[unsafe(no_mangle)]
pub extern "C" fn session_transition(now_ms: f64, previous_ms: f64, idle_ms: u32) -> u32 {
    let idle_ms = if idle_ms == 0 {
        DEFAULT_IDLE_MS
    } else {
        idle_ms
    };
    if !valid_time(now_ms) || !(MINUTE_MS..=DAY_MS).contains(&idle_ms) {
        return 0;
    }
    if previous_ms == -1.0 {
        return 2;
    }
    if !valid_time(previous_ms) {
        return 0;
    }

    let elapsed = now_ms - previous_ms;
    if elapsed >= f64::from(idle_ms) || elapsed < -MAX_CLOCK_ROLLBACK_MS {
        return 2;
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inactivity_expires_at_the_boundary() {
        assert_eq!(session_transition(0.0, -1.0, 0), 2);
        assert_eq!(session_transition(1_799_999.0, 0.0, 0), 1);
        assert_eq!(session_transition(1_800_000.0, 0.0, 0), 2);
        assert_eq!(session_transition(60_000.0, 0.0, 60_000), 2);
    }

    #[test]
    fn clock_small_reversals_keep_session_while_large_reversals_start_one() {
        assert_eq!(session_transition(0.0, 300_000.0, 0), 1);
        assert_eq!(session_transition(0.0, 300_001.0, 0), 2);
    }

    #[test]
    fn rejects_invalid_clock_and_timeout() {
        assert_eq!(session_transition(f64::NAN, 1.0, 0), 0);
        assert_eq!(session_transition(1.0, f64::INFINITY, 0), 0);
        assert_eq!(session_transition(-1.0, -1.0, 0), 0);
        assert_eq!(session_transition(1.0, -2.0, 0), 0);
        assert_eq!(session_transition(1.0, -1.0, 1), 0);
        assert_eq!(session_transition(1.0, -1.0, DAY_MS + 1), 0);
    }
}
