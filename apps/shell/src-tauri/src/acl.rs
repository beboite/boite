//! Check the packaged permissions against the same resolver Tauri uses for IPC.

#[cfg(test)]
mod tests {
    use tauri::ipc::Origin;

    #[test]
    fn shell_commands_are_granted_to_the_main_ui_only() {
        let mut context: tauri::Context<tauri::test::MockRuntime> = crate::shell_context();
        let authority = context.runtime_authority_mut();
        let handlers = include_str!("lib.rs").split("tauri::generate_handler![").nth(1).unwrap().split("])").next().unwrap();
        for handler in handlers.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let command = handler.rsplit("::").next().unwrap();
            assert!(authority.resolve_access(command, "main", "main", &Origin::Local).is_some(), "{command} not allowed by ACL");
            assert!(authority.resolve_access(command, "main", "boite-browser:test", &Origin::Local).is_none(), "{command} granted to a browser page");
            let remote = Origin::Remote { url: "https://example.test/".parse().unwrap() };
            assert!(authority.resolve_access(command, "main", "main", &remote).is_none(), "{command} granted to a remote origin");
        }
    }

    #[test]
    fn quota_popup_can_connect_and_listen_without_browser_control() {
        let mut context: tauri::Context<tauri::test::MockRuntime> = crate::shell_context();
        let authority = context.runtime_authority_mut();
        for command in ["core_endpoint", "quota_window", "plugin:event|listen", "plugin:event|unlisten"] {
            assert!(authority.resolve_access(command, "quotas", "quotas", &Origin::Local).is_some(), "quota popup cannot invoke {command}");
        }
        for command in ["browser_create", "browser_protocol", "browser_cookies", "quit_shell", "save_attachment"] {
            assert!(authority.resolve_access(command, "quotas", "quotas", &Origin::Local).is_none(), "quota popup can invoke {command}");
        }
    }
}
