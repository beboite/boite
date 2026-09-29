//! Where a shell that failed says why.

use std::io::Write;
use std::path::Path;

/// Where a shell that failed writes why. A release build has no console
/// (`windows_subsystem = "windows"`), so without this file a setup error or a
/// panic was the app starting and vanishing without a word.
pub(crate) const FAILURE_LOG: &str = "shell-error.log";

/// Appends one line to `<dataDir>/shell-error.log` and stderr. It never fails:
/// it runs while the shell is already failing.
pub(crate) fn record_failure(directory: &Path, text: &str) {
    eprintln!("[shell] {text}");
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    let _ = std::fs::create_dir_all(directory);
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(directory.join(FAILURE_LOG)) {
        let _ = writeln!(file, "[unix {seconds}] {text}");
    }
}

#[cfg(test)]
mod tests {
    use super::{record_failure, FAILURE_LOG};

    #[test]
    fn a_failure_is_appended_to_the_log_in_the_data_directory() {
        let directory = std::env::temp_dir().join(format!("boite-failure-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        record_failure(&directory, "first");
        record_failure(&directory, "second");
        let text = std::fs::read_to_string(directory.join(FAILURE_LOG)).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert!(lines[0].starts_with("[unix ") && lines[0].ends_with("] first"), "{text}");
        assert!(lines[1].ends_with("] second"), "{text}");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
