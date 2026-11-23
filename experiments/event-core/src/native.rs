//! Node-API adapter. Input is borrowed from the host buffer during each call.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::Validator;

#[napi]
pub struct EventCore(Validator);

#[napi]
impl EventCore {
    #[napi(constructor)]
    pub fn new(profile: Buffer) -> Result<Self> {
        Validator::new(&profile)
            .map(Self)
            .ok_or_else(|| Error::from_reason("invalid projection profile"))
    }

    #[napi]
    pub fn project(&self, requests: Buffer) -> Option<Buffer> {
        self.0.project(&requests).map(Buffer::from)
    }
}
