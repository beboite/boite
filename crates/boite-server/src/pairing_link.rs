//! The pairing link, as something a person can act on.
//!
//! A device is paired by opening a URL, and typing a hundred-character
//! credential into a phone is how a pairing flow gets skipped in favour of
//! copying the workspace secret across — which is the thing being removed. So
//! the link is drawn: a QR in the terminal for the operator standing at a
//! headless box, and a matrix on the wire for the devices screen in the app.
//!
//! One encoder for both. The app gets a matrix of bits rather than markup,
//! because a server-rendered SVG dropped into the page with `{@html}` would be
//! a second place the server can write into the DOM, and the QR is fifteen
//! lines of `<rect>` on the other side.

use boite_core::pairing::ScopeSet;
use serde::Serialize;

/// How long an invitation stands by default.
///
/// Long enough to walk to the other device, short enough that a link left in a
/// scrollback is not a standing offer. `pairing.create` clamps whatever it is
/// asked for into [60s, 24h].
pub const DEFAULT_TTL_MS: i64 = 10 * 60_000;

/// A QR code as bits, for a client that draws its own squares.
#[derive(Debug, Clone, Serialize)]
pub struct QrMatrix {
    pub size: usize,
    /// One string per row, `1` for a dark module. Strings rather than nested
    /// arrays because this is drawn, never computed with, and it is a tenth of
    /// the JSON.
    pub rows: Vec<String>,
}

/// The link as a QR, or `None` when it will not fit one.
///
/// `None` rather than an error: the URL beside it is the credential-carrying
/// half and is always there, so a QR that could not be built costs a
/// convenience and not the pairing.
pub fn qr_matrix(url: &str) -> Option<QrMatrix> {
    let code = qrcode::QrCode::new(url.as_bytes()).ok()?;
    let width = code.width();
    let colors = code.to_colors();
    let rows = colors
        .chunks(width)
        .map(|row| {
            row.iter()
                .map(|c| if *c == qrcode::Color::Dark { '1' } else { '0' })
                .collect()
        })
        .collect();
    Some(QrMatrix { size: width, rows })
}

/// The same code for a terminal, two rows of modules per line of text.
///
/// A quiet zone of four modules is part of the spec rather than padding:
/// without it a scanner reading a QR flush against a prompt finds no finder
/// pattern. `Dense1x2` is what makes the result square on a font that is not.
pub fn qr_terminal(url: &str) -> Option<String> {
    let code = qrcode::QrCode::new(url.as_bytes()).ok()?;
    Some(
        code.render::<qrcode::render::unicode::Dense1x2>()
            .quiet_zone(true)
            .dark_color(qrcode::render::unicode::Dense1x2::Light)
            .light_color(qrcode::render::unicode::Dense1x2::Dark)
            .build(),
    )
}

/// What the operator sees after minting one, ready to print.
///
/// The token appears exactly twice, both times as part of the link, and never
/// on its own line: a token on its own line is a token somebody copies into a
/// chat window.
pub fn printed(url: &str, label: &str, scopes: ScopeSet, minutes: i64) -> String {
    let mut out = String::new();
    if let Some(qr) = qr_terminal(url) {
        out.push_str(&qr);
        out.push('\n');
    }
    out.push_str(&format!("device:  {label}\n"));
    out.push_str(&format!("scopes:  {}\n", scopes.to_text()));
    out.push_str(&format!("expires: in {minutes} minutes, and after one use\n\n"));
    out.push_str(&format!("{url}\n"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_link_becomes_a_square_of_bits() {
        let qr = qr_matrix("https://boite.example/#pair=aa.bb").unwrap();
        assert!(qr.size >= 21, "{}", qr.size);
        assert_eq!(qr.rows.len(), qr.size);
        for row in &qr.rows {
            assert_eq!(row.chars().count(), qr.size);
            assert!(row.chars().all(|c| c == '0' || c == '1'), "{row}");
        }
    }

    /// A URL too long for any version of the symbol costs the picture and
    /// nothing else. The link beside it is what actually carries the token.
    #[test]
    fn a_link_nothing_can_encode_costs_the_picture_and_not_the_pairing() {
        let huge = format!("https://boite.example/#pair={}", "a".repeat(8000));
        assert!(qr_matrix(&huge).is_none());
        assert!(qr_terminal(&huge).is_none());
        // And the printed form still says what was minted.
        let printed = printed(&huge, "phone", ScopeSet::standard(), 10);
        assert!(printed.contains(&huge));
        assert!(printed.contains("read,write,terminal,approve"));
    }

    /// The token is in the link and never on a line of its own.
    #[test]
    fn nothing_printed_offers_the_token_on_its_own() {
        let url = "https://boite.example/#pair=aa11.bb22";
        let out = printed(url, "Nuno phone", ScopeSet::standard(), 10);
        for line in out.lines() {
            let line = line.trim();
            assert_ne!(line, "aa11.bb22");
        }
        assert!(out.contains(url));
        assert!(out.contains("Nuno phone"));
    }
}
