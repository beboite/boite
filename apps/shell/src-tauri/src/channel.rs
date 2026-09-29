//! The install channel: which install of Boite this executable is.

/// Which install of Boite this executable is. Stable and dev are two installs
/// on one machine, and three things separate them: the bundle identifier, the
/// product name, and the data directory. Only the identifier decides, read once
/// from the compiled config, so no environment variable can move a build to
/// another channel and no dev shell can adopt the stable core.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Dev,
}

impl Channel {
    /// `com.boite.two` is stable, `com.boite.two.dev` is dev.
    pub fn of_identifier(identifier: &str) -> Self {
        if identifier.ends_with(".dev") {
            Channel::Dev
        } else {
            Channel::Stable
        }
    }

    /// The directory name under the OS data root. It is the same name
    /// `dataDirName` returns in `packages/core/src/paths.ts`: the shell reads
    /// `core.json` where the core writes it, or it adopts the wrong core.
    pub fn data_dir_name(self) -> &'static str {
        match self {
            Channel::Stable => "boite2",
            Channel::Dev => "boite2-dev",
        }
    }

    /// What the window title and the tray tooltip read.
    pub fn product_name(self) -> &'static str {
        match self {
            Channel::Stable => "Boite",
            Channel::Dev => "Boite Dev",
        }
    }

    /// What this shell appends to the core's argv, so the core it starts picks
    /// the same default data directory the shell will look in.
    pub fn core_args(self) -> Vec<String> {
        match self {
            Channel::Stable => Vec::new(),
            Channel::Dev => vec!["--channel".to_string(), "dev".to_string()],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Channel;

    #[test]
    fn the_identifier_is_the_only_thing_that_names_the_channel() {
        assert_eq!(Channel::of_identifier("com.boite.two"), Channel::Stable);
        assert_eq!(Channel::of_identifier("com.boite.two.dev"), Channel::Dev);
        // A name that merely mentions dev is not a channel: only the suffix is.
        assert_eq!(Channel::of_identifier("com.boite.devtwo"), Channel::Stable);
    }

    #[test]
    fn a_channel_names_its_own_data_directory_and_product() {
        assert_eq!(Channel::Stable.data_dir_name(), "boite2");
        assert_eq!(Channel::Dev.data_dir_name(), "boite2-dev");
        assert_eq!(Channel::Stable.product_name(), "Boite");
        assert_eq!(Channel::Dev.product_name(), "Boite Dev");
    }

    #[test]
    fn only_the_dev_channel_puts_anything_on_the_cores_argv() {
        assert!(Channel::Stable.core_args().is_empty());
        assert_eq!(Channel::Dev.core_args(), vec!["--channel", "dev"]);
    }
}
