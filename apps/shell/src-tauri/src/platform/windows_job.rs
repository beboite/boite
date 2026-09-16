//! Owns the core process tree through KILL_ON_JOB_CLOSE. Nested agent jobs remain supported.
use std::os::windows::io::AsRawHandle;
use std::process::Child;

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// Owns the job handle and closes it on drop.
pub struct CoreJob(HANDLE);

// A job handle is a kernel handle: valid from every thread of the process,
// and this one is only moved into the shell state and dropped from there.
unsafe impl Send for CoreJob {}

impl Drop for CoreJob {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

fn last_error() -> u32 {
    unsafe { GetLastError() }
}

pub fn create_core_job() -> Result<CoreJob, String> {
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err(format!("CreateJobObjectW failed, error {}", last_error()));
    }
    let job = CoreJob(handle);

    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let set = unsafe {
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            std::ptr::addr_of!(limits).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if set == 0 {
        return Err(format!(
            "SetInformationJobObject(JobObjectExtendedLimitInformation) failed, error {}",
            last_error()
        ));
    }
    Ok(job)
}

pub fn assign(job: &CoreJob, child: &Child) -> Result<(), String> {
    let assigned =
        unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) };
    if assigned == 0 {
        return Err(format!(
            "AssignProcessToJobObject failed, error {}",
            last_error()
        ));
    }
    Ok(())
}
