//! Clean shutdown kills the direct core child. Hard shell exits have no kernel ownership yet.
use std::process::Child;

pub struct CoreJob;

pub fn create_core_job() -> Result<CoreJob, String> {
    Ok(CoreJob)
}

pub fn assign(_job: &CoreJob, _child: &Child) -> Result<(), String> {
    Ok(())
}
