fn main() {
    #[cfg(feature = "native-addon")]
    napi_build::setup();
}
