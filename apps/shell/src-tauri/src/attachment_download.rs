//! Ticketed files stream to Downloads without a full-body IPC allocation.
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{Manager, Webview};
use crate::attachments::{finish_save, safe_name, Saved};

// ARTIFACT_MAX_BYTES in @boite/contracts.
const MAX_BYTES: u64 = 512 * 1024 * 1024;

fn ticket_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "url: expected a ticketed HTTP(S) file")?;
    let ticket = url.path().strip_prefix("/file/").unwrap_or("");
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        || ticket.len() < 32 || !ticket.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')) {
        return Err("url: expected a ticketed HTTP(S) file without credentials, query or fragment".into());
    }
    Ok(url)
}

fn reserve(directory: &Path, name: &str) -> Result<(PathBuf, File), String> {
    fs::create_dir_all(directory).map_err(|e| format!("downloads folder: {e}"))?;
    let name = safe_name(name);
    let path = Path::new(&name);
    let stem = path.file_stem().and_then(|v| v.to_str()).unwrap_or("attachment");
    let extension = path.extension().and_then(|v| v.to_str());
    for n in 1..=999 {
        let candidate = directory.join(if n == 1 { name.clone() } else {
            match extension { Some(ext) => format!("{stem} ({n}).{ext}"), None => format!("{stem} ({n})") }
        });
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(file) => return Ok((candidate, file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("download file: {e}")),
        }
    }
    Err("download file: no available name".into())
}

async fn download(directory: &Path, name: &str, url: reqwest::Url, idle_timeout: Duration) -> Result<PathBuf, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15)).read_timeout(idle_timeout)
        .build().map_err(|e| e.without_url().to_string())?;
    let mut response = client.get(url).send().await.map_err(|e| e.without_url().to_string())?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("download: HTTP {}; refresh the attachment and retry", response.status()));
    }
    if response.content_length().is_some_and(|size| size > MAX_BYTES) {
        return Err("download: expected at most 512 MB".into());
    }
    let expected = response.content_length();
    let (path, mut file) = reserve(directory, name)?;
    let result: Result<(), String> = async {
        let mut total = 0u64;
        while let Some(chunk) = response.chunk().await.map_err(|e| e.without_url().to_string())? {
            total += chunk.len() as u64;
            if total > MAX_BYTES { return Err("download: expected at most 512 MB".into()); }
            file.write_all(&chunk).map_err(|e| format!("download file: {e}"))?;
        }
        if expected.is_some_and(|size| size != total) { return Err("download: incomplete file".into()); }
        file.sync_all().map_err(|e| format!("download file: {e}"))
    }.await;
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(path)
}

#[tauri::command]
pub async fn save_attachment_url(webview: Webview, name: String, url: String, open: bool) -> Result<Saved, String> {
    crate::browser::only_main(&webview)?;
    let url = ticket_url(&url)?;
    let directory = webview.app_handle().path().download_dir().map_err(|e| format!("downloads folder: {e}"))?;
    finish_save(download(&directory, &name, url, Duration::from_secs(60)).await?, open)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;

    #[test]
    fn streaming_download_keeps_large_files_and_removes_truncated_ones() {
        let dir = std::env::temp_dir().join(format!("boite-download-stream-{}", std::process::id()));
        for truncated in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 2048];
                stream.read(&mut request).unwrap();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", 6 * 1024 * 1024).unwrap();
                for _ in 0..if truncated { 1 } else { 768 } { stream.write_all(&[73; 8192]).unwrap(); }
            });
            let url = ticket_url(&format!("http://{address}/file/{}", "a".repeat(64))).unwrap();
            let result = tauri::async_runtime::block_on(download(&dir, "clip.mp4", url, Duration::from_secs(60)));
            server.join().unwrap();
            if truncated {
                assert!(result.is_err());
                assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
            } else {
                let path = result.unwrap();
                assert_eq!(fs::metadata(&path).unwrap().len(), 6 * 1024 * 1024);
                assert!(fs::read(&path).unwrap().iter().all(|&byte| byte == 73));
                fs::remove_file(path).unwrap();
            }
        }
        fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn slow_active_downloads_finish_but_stalled_downloads_remove_partial_files() {
        let dir = std::env::temp_dir().join(format!("boite-download-timeout-{}", std::process::id()));
        let idle_timeout = Duration::from_secs(1);
        for stalled in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let (release, wait_for_client) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_nodelay(true).unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = [0u8; 2048];
                stream.read(&mut request).unwrap();
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nx").unwrap();
                if stalled {
                    // Keep the socket open until the client times out, with a deadline if it never does.
                    return wait_for_client.recv_timeout(Duration::from_secs(5)).is_ok();
                }
                for _ in 1..12 {
                    std::thread::sleep(Duration::from_millis(250));
                    if stream.write_all(b"x").is_err() { return false; }
                }
                true
            });
            let url = ticket_url(&format!("http://{address}/file/{}", "a".repeat(64))).unwrap();
            let started = std::time::Instant::now();
            let result = tauri::async_runtime::block_on(download(&dir, "clip.mp4", url, idle_timeout));
            let elapsed = started.elapsed();
            let _ = release.send(());
            let server_finished = server.join().unwrap();
            if stalled {
                assert!(result.is_err());
                assert!(server_finished, "the client must time out before the server closes the socket");
                assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
            } else {
                let path = result.expect("regular progress must keep the download alive");
                assert!(elapsed > idle_timeout);
                assert!(server_finished);
                assert_eq!(fs::read(&path).unwrap(), b"xxxxxxxxxxxx");
                fs::remove_file(path).unwrap();
            }
        }
        fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn only_ticket_routes_can_be_downloaded_and_existing_files_are_preserved() {
        let ticket = "a".repeat(64);
        assert!(ticket_url(&format!("http://127.0.0.1:4311/file/{ticket}")).is_ok());
        for value in ["file:///tmp/file", "https://host/file/no", "https://host/shutdown", "https://user:pass@host/file/"] {
            assert!(ticket_url(value).is_err());
        }
        assert!(ticket_url(&format!("https://host/file/{ticket}?secret=yes")).is_err());
        let dir = std::env::temp_dir().join(format!("boite-download-{}", std::process::id()));
        let (first, mut file) = reserve(&dir, "../../clip.mp4").unwrap();
        file.write_all(b"keep").unwrap();
        drop(file);
        let (second, file) = reserve(&dir, "clip.mp4").unwrap();
        drop(file);
        assert_ne!(first, second);
        assert_eq!(fs::read(&first).unwrap(), b"keep");
        fs::remove_file(first).unwrap();
        fs::remove_file(second).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
