//! Standalone benchmark module for batch session transitions.
#![deny(unsafe_op_in_unsafe_fn)]

#[path = "../src/lib.rs"]
mod session;

const CAPACITY: usize = 32;
static mut TIMES: [f64; CAPACITY] = [0.0; CAPACITY];
static mut OUTCOMES: [u8; CAPACITY] = [0; CAPACITY];

#[unsafe(no_mangle)]
pub extern "C" fn replay_times() -> *mut f64 {
    (&raw mut TIMES).cast()
}

#[unsafe(no_mangle)]
pub extern "C" fn replay_outcomes() -> *const u8 {
    (&raw const OUTCOMES).cast()
}

#[unsafe(no_mangle)]
pub extern "C" fn replay(count: usize, mut previous: f64, idle_ms: u32) -> f64 {
    if count > CAPACITY {
        return f64::NAN;
    }

    for index in 0..count {
        // Each call runs synchronously in one unshared WASM instance.
        // Both fixed-size scratch buffers are initialized and index is in bounds.
        let now = unsafe { replay_times().add(index).read() };
        let decision = session::session_transition(now, previous, idle_ms);
        unsafe {
            (&raw mut OUTCOMES)
                .cast::<u8>()
                .add(index)
                .write(decision as u8)
        };
        if decision == 2 || (decision == 1 && now > previous) {
            previous = now;
        }
    }
    previous
}
