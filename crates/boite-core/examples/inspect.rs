fn main() {
    for path in std::env::args().skip(1) {
        match boite_core::project::inspect_project_blocking(path.clone()) {
            Ok(i) => {
                let icon = i
                    .icon
                    .map(|u| format!("{}… ({} chars)", &u[..40.min(u.len())], u.len()))
                    .unwrap_or_else(|| "none".into());
                println!("{path}\n  name={} tech={:?}\n  icon={icon}", i.name, i.tech);
            }
            Err(e) => println!("{path}\n  error: {e}"),
        }
    }
}
