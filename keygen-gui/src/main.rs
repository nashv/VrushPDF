//! A small window over the keygen library: issue license keys, look them up,
//! check pasted keys, and revoke or restore them. Everything it does goes
//! through `vrushpdf_keygen`, exactly as the `keygen` command line does, so
//! the two can be used interchangeably.
//!
//!   npm run keygen:gui

use eframe::egui::{self, Color32, RichText, Ui};
use vrushpdf_keygen::{self as keygen, date, Check, Inspection, Issued, Ledger, Paths};

fn main() -> eframe::Result {
    let paths = Paths::standard().unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1);
    });
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("VrushPDF Keygen")
            .with_inner_size([860.0, 600.0])
            .with_min_inner_size([640.0, 420.0]),
        ..Default::default()
    };
    eframe::run_native("VrushPDF Keygen", options, Box::new(|_cc| Ok(Box::new(KeygenApp::new(paths)))))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tab {
    Issue,
    Keys,
    Check,
    Setup,
}

/// The revoke dialog's fields.
struct RevokeForm {
    /// A key id, or a whole key pasted in.
    target: String,
    /// Fixed when revoking a row from the ledger; editable from "Revoke a key…".
    from_ledger: bool,
    reason: String,
}

struct KeygenApp {
    paths: Paths,
    tab: Tab,
    ledger: Ledger,
    checks: Vec<Check>,
    /// Repo files with changes not yet committed, which a release would miss.
    uncommitted: Vec<String>,
    /// Feedback for the last action: (is an error, text).
    status: Option<(bool, String)>,

    email: String,
    note: String,
    last_issued: Option<Issued>,

    search: String,
    revoking: Option<RevokeForm>,

    check_input: String,
    check_result: Option<Result<Inspection, String>>,
}

const OK: Color32 = Color32::from_rgb(22, 163, 74);
const BAD: Color32 = Color32::from_rgb(220, 38, 38);

/// The message to send a buyer with their key.
fn buyer_message(issued: &Issued) -> String {
    format!(
        "Thank you for buying VrushPDF.\n\nYour license key:\n\n{}\n\nTo activate it, open VrushPDF, choose \
         VrushPDF ▸ Enter License… (macOS) or Help ▸ Enter License… (Windows and Linux), and paste the \
         key. It works with VrushPDF 1.0 and later.\n",
        issued.key
    )
}

impl KeygenApp {
    fn new(paths: Paths) -> Self {
        let mut app = Self {
            paths,
            tab: Tab::Issue,
            ledger: Ledger::default(),
            checks: Vec::new(),
            uncommitted: Vec::new(),
            status: None,
            email: String::new(),
            note: String::new(),
            last_issued: None,
            search: String::new(),
            revoking: None,
            check_input: String::new(),
            check_result: None,
        };
        app.reload();
        if !app.ready() {
            app.tab = Tab::Setup;
        }
        app
    }

    /// Reread everything from disk.
    fn reload(&mut self) {
        match Ledger::load(&self.paths) {
            Ok(ledger) => self.ledger = ledger,
            Err(e) => self.status = Some((true, e)),
        }
        self.checks = keygen::diagnose(&self.paths);
        self.uncommitted = uncommitted(&self.paths);
    }

    fn ready(&self) -> bool {
        !self.checks.is_empty() && self.checks.iter().all(|c| c.ok)
    }

    fn report(&mut self, result: Result<String, String>) {
        self.status = Some(match result {
            Ok(text) => (false, text),
            Err(text) => (true, text),
        });
        self.reload();
    }

    /// The whole window. `App::ui` and the tests both call this.
    fn show(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            ui.heading("VrushPDF Keygen");
            ui.add_space(16.0);
            for (tab, label) in [(Tab::Issue, "Issue"), (Tab::Keys, "Keys"), (Tab::Check, "Check key"), (Tab::Setup, "Setup")] {
                if ui.selectable_label(self.tab == tab, label).clicked() {
                    self.tab = tab;
                }
            }
        });
        ui.separator();

        if let Some((error, text)) = &self.status {
            ui.label(RichText::new(text).color(if *error { BAD } else { OK }));
            ui.add_space(4.0);
        }

        let footer = 28.0;
        egui::ScrollArea::vertical()
            .max_height(ui.available_height() - footer)
            .auto_shrink([false, false])
            .show(ui, |ui| match self.tab {
                Tab::Issue => self.issue_tab(ui),
                Tab::Keys => self.keys_tab(ui),
                Tab::Check => self.check_tab(ui),
                Tab::Setup => self.setup_tab(ui),
            });

        ui.separator();
        ui.horizontal(|ui| {
            if self.ready() {
                ui.label(RichText::new("● Ready to issue keys").color(OK));
            } else {
                ui.label(RichText::new("● Can't issue keys: see Setup").color(BAD));
            }
            if !self.uncommitted.is_empty() {
                ui.separator();
                ui.label(format!(
                    "Uncommitted: {}. Commit and release for revocations to take effect.",
                    self.uncommitted.join(", ")
                ));
            }
        });

        self.revoke_dialog(ui);
    }

    // ------------------------------------------------------------- issue

    fn issue_tab(&mut self, ui: &mut Ui) {
        if !self.ready() {
            ui.label(RichText::new("This machine can't issue keys yet. Open Setup to see why.").color(BAD));
            ui.add_space(8.0);
        }
        egui::Grid::new("issue").num_columns(2).spacing([12.0, 8.0]).show(ui, |ui| {
            let label = ui.label("Email");
            ui.add(egui::TextEdit::singleline(&mut self.email).hint_text("buyer@example.com").desired_width(320.0))
                .labelled_by(label.id);
            ui.end_row();
            let label = ui.label("Note");
            ui.add(egui::TextEdit::singleline(&mut self.note).hint_text("order number, invoice…").desired_width(320.0))
                .labelled_by(label.id);
            ui.end_row();
        });
        ui.add_space(8.0);
        let can_issue = self.ready() && keygen::valid_email(&self.email);
        if ui.add_enabled(can_issue, egui::Button::new("Issue key")).clicked() {
            match keygen::issue(&self.paths, &self.email, &self.note) {
                Ok(issued) => {
                    let text = format!("Issued key {} for {}.", issued.id, issued.email);
                    self.last_issued = Some(issued);
                    self.email.clear();
                    self.note.clear();
                    self.report(Ok(text));
                }
                Err(e) => self.report(Err(e)),
            }
        }

        if let Some(issued) = self.last_issued.clone() {
            ui.add_space(16.0);
            ui.group(|ui| {
                ui.label(RichText::new(format!("Key for {} (id {})", issued.email, issued.id)).strong());
                let mut key = issued.key.clone();
                ui.add(egui::TextEdit::multiline(&mut key).desired_rows(3).desired_width(f32::INFINITY).interactive(false));
                ui.horizontal(|ui| {
                    if ui.button("Copy key").clicked() {
                        ui.ctx().copy_text(issued.key.clone());
                        self.status = Some((false, "Key copied.".into()));
                    }
                    if ui.button("Copy message for the buyer").clicked() {
                        ui.ctx().copy_text(buyer_message(&issued));
                        self.status = Some((false, "Message with the key and instructions copied.".into()));
                    }
                });
            });
        }
    }

    // -------------------------------------------------------------- keys

    fn keys_tab(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            let label = ui.label("Search");
            ui.add(egui::TextEdit::singleline(&mut self.search).hint_text("email, id or note").desired_width(240.0))
                .labelled_by(label.id);
            let revoked = self.ledger.keys.iter().filter(|k| k.revoked.is_some()).count();
            ui.label(format!("{} keys, {revoked} revoked", self.ledger.keys.len()));
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("Revoke a key…").on_hover_text("For a key not in this list: paste it or its id").clicked() {
                    self.revoking = Some(RevokeForm { target: String::new(), from_ledger: false, reason: String::new() });
                }
            });
        });
        ui.add_space(6.0);

        let needle = self.search.trim().to_lowercase();
        let mut rows: Vec<Issued> = self
            .ledger
            .keys
            .iter()
            .filter(|k| {
                needle.is_empty()
                    || k.email.to_lowercase().contains(&needle)
                    || k.id.contains(&needle)
                    || k.note.to_lowercase().contains(&needle)
            })
            .cloned()
            .collect();
        rows.reverse(); // newest first

        if rows.is_empty() {
            ui.label(if self.ledger.keys.is_empty() { "No keys recorded yet." } else { "No keys match." });
            return;
        }

        egui::Grid::new("keys").striped(true).num_columns(6).spacing([14.0, 6.0]).show(ui, |ui| {
            for header in ["Issued", "Email", "Id", "Note", "Status", ""] {
                ui.label(RichText::new(header).strong());
            }
            ui.end_row();
            for k in &rows {
                ui.label(date(k.issued_at));
                ui.label(&k.email);
                ui.monospace(&k.id);
                ui.label(&k.note);
                match &k.revoked {
                    Some(r) => {
                        let reason = if r.reason.is_empty() { String::new() } else { format!(": {}", r.reason) };
                        ui.label(RichText::new(format!("Revoked {}{reason}", date(r.at))).color(BAD));
                    }
                    None => {
                        ui.label(RichText::new("Valid").color(OK));
                    }
                }
                ui.horizontal(|ui| {
                    if ui.small_button("Copy key").clicked() {
                        ui.ctx().copy_text(k.key.clone());
                        self.status = Some((false, format!("Key {} copied.", k.id)));
                    }
                    if k.revoked.is_none() {
                        if ui.small_button("Revoke…").clicked() {
                            self.revoking = Some(RevokeForm { target: k.id.clone(), from_ledger: true, reason: String::new() });
                        }
                    } else if ui.small_button("Restore").on_hover_text("Take it off the revocation list").clicked() {
                        let result = keygen::restore(&self.paths, &k.id).map(|()| format!("Key {} restored.", k.id));
                        self.report(result);
                    }
                });
                ui.end_row();
            }
        });
    }

    fn revoke_dialog(&mut self, ui: &mut Ui) {
        let Some(form) = &mut self.revoking else { return };
        let id = keygen::id_of(&self.paths, &form.target);
        let recorded = id.as_deref().and_then(|id| self.ledger.find(id)).cloned();
        let mut action: Option<bool> = None; // Some(true) revoke, Some(false) cancel

        egui::Modal::new(egui::Id::new("revoke")).show(ui.ctx(), |ui| {
            ui.set_width(420.0);
            ui.heading("Revoke a license key");
            ui.add_space(6.0);
            if form.from_ledger {
                ui.label(format!(
                    "{} (id {})",
                    recorded.as_ref().map(|r| r.email.as_str()).unwrap_or("?"),
                    form.target
                ));
            } else {
                let label = ui.label("Key or id");
                ui.add(egui::TextEdit::singleline(&mut form.target).hint_text("8-digit id, or the whole key").desired_width(f32::INFINITY))
                    .labelled_by(label.id);
                match (&id, &recorded) {
                    (Some(id), Some(r)) => ui.label(format!("{id}: {}", r.email)),
                    (Some(id), None) => ui.label(format!("{id}: not in the ledger (issued elsewhere or earlier)")),
                    (None, _) if !form.target.trim().is_empty() => ui.label(RichText::new("Not a key id or a valid key.").color(BAD)),
                    _ => ui.label(""),
                };
            }
            ui.add_space(6.0);
            let label = ui.label("Reason");
            ui.add(egui::TextEdit::singleline(&mut form.reason).hint_text("refund, leaked…").desired_width(f32::INFINITY))
                .labelled_by(label.id);
            ui.add_space(6.0);
            ui.label(
                RichText::new(
                    "The key stops working in the next VrushPDF release. Commit revoked_keys.txt and \
                     issued-keys.json, then release.",
                )
                .small(),
            );
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                if ui.add_enabled(id.is_some(), egui::Button::new("Revoke")).clicked() {
                    action = Some(true);
                }
                if ui.button("Cancel").clicked() {
                    action = Some(false);
                }
            });
        });

        match action {
            Some(true) => {
                let form = self.revoking.take().expect("dialog is open");
                let id = id.expect("enabled only with an id");
                let result = keygen::revoke(&self.paths, &id, &form.reason).map(|()| {
                    format!("Key {id} revoked. It stops working in the next release, once committed.")
                });
                self.report(result);
            }
            Some(false) => self.revoking = None,
            None => {}
        }
    }

    // ------------------------------------------------------------- check

    fn check_tab(&mut self, ui: &mut Ui) {
        let label = ui.label("Paste a license key to see who it was issued to and whether it is still valid.");
        let changed = ui
            .add(egui::TextEdit::multiline(&mut self.check_input).desired_rows(3).desired_width(f32::INFINITY).hint_text("VRSH.…"))
            .labelled_by(label.id)
            .changed();
        if changed {
            self.check_result =
                if self.check_input.trim().is_empty() { None } else { Some(keygen::inspect(&self.paths, &self.check_input)) };
        }
        ui.add_space(8.0);

        let Some(result) = self.check_result.clone() else { return };
        match result {
            Err(e) => {
                ui.label(RichText::new(format!("✖ {e}")).color(BAD));
            }
            Ok(seen) => {
                if seen.revoked {
                    ui.label(RichText::new("✖ Revoked: the next release refuses this key").color(BAD).strong());
                } else {
                    ui.label(RichText::new("✔ Valid").color(OK).strong());
                }
                egui::Grid::new("check").num_columns(2).spacing([12.0, 4.0]).show(ui, |ui| {
                    for (name, value) in [
                        ("Email", seen.payload.email.clone()),
                        ("Id", seen.payload.id.clone()),
                        ("Issued", date(seen.payload.iat)),
                        ("Signed by", seen.signer.clone()),
                        (
                            "Ledger",
                            match &seen.recorded {
                                Some(r) if !r.note.is_empty() => format!("recorded ({})", r.note),
                                Some(_) => "recorded".into(),
                                None => "not recorded (issued elsewhere or before the ledger)".into(),
                            },
                        ),
                    ] {
                        ui.label(name);
                        ui.label(value);
                        ui.end_row();
                    }
                });
                if !seen.revoked && ui.button("Revoke…").clicked() {
                    self.revoking = Some(RevokeForm {
                        target: seen.payload.id.clone(),
                        from_ledger: seen.recorded.is_some(),
                        reason: String::new(),
                    });
                }
            }
        }
    }

    // ------------------------------------------------------------- setup

    fn setup_tab(&mut self, ui: &mut Ui) {
        ui.label(RichText::new("Can this machine issue keys the app accepts?").strong());
        ui.add_space(4.0);
        egui::Grid::new("checks").num_columns(3).spacing([10.0, 6.0]).show(ui, |ui| {
            for c in &self.checks {
                ui.label(RichText::new(if c.ok { "✔" } else { "✖" }).color(if c.ok { OK } else { BAD }));
                ui.label(&c.label);
                ui.label(&c.detail);
                ui.end_row();
            }
        });
        ui.add_space(8.0);
        if ui.button("Check again").clicked() {
            self.reload();
            self.status = Some((false, "Checked again.".into()));
        }

        ui.add_space(16.0);
        ui.label(RichText::new("Files").strong());
        egui::Grid::new("files").num_columns(2).spacing([10.0, 4.0]).show(ui, |ui| {
            for (name, path) in [
                ("Signing key", &self.paths.signing_key),
                ("Trusted public keys", &self.paths.public_keys),
                ("Revocation list", &self.paths.revoked),
                ("Ledger", &self.paths.ledger),
            ] {
                ui.label(name);
                ui.monospace(path.display().to_string());
                ui.end_row();
            }
        });

        if !self.paths.signing_key.exists() {
            ui.add_space(16.0);
            ui.label(
                "This machine has no signing key. Create one to issue keys from here; its public key is \
                 added to the trusted list, which takes effect in the next release. Back the signing key up.",
            );
            if ui.button("Create signing key").clicked() {
                let result = keygen::init(&self.paths, false)
                    .map(|public| format!("Signing key created; public key {public} added to the trusted list."));
                self.report(result);
            }
        }
    }
}

impl eframe::App for KeygenApp {
    fn ui(&mut self, ui: &mut Ui, _frame: &mut eframe::Frame) {
        egui::Frame::central_panel(ui.style()).show(ui, |ui| self.show(ui));
    }
}

/// Which of the files a release needs have uncommitted changes, by name.
fn uncommitted(paths: &Paths) -> Vec<String> {
    let files = [&paths.revoked, &paths.ledger, &paths.public_keys];
    let Some(dir) = paths.ledger.parent() else { return Vec::new() };
    let output = std::process::Command::new("git")
        .current_dir(dir)
        .arg("status")
        .arg("--porcelain")
        .args(files.iter().map(|p| p.as_os_str()))
        .output();
    let Ok(output) = output else { return Vec::new() };
    if !output.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    files
        .iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .filter(|name| text.lines().any(|line| line.ends_with(name.as_str())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use egui::accesskit::Role;
    use egui_kittest::kittest::Queryable;
    use egui_kittest::Harness;
    use std::fs;

    fn sandbox(name: &str) -> Paths {
        let dir = std::env::temp_dir().join(format!("keygen-gui-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let paths = Paths {
            signing_key: dir.join("signing-key"),
            public_keys: dir.join("license_key.pub"),
            revoked: dir.join("revoked_keys.txt"),
            ledger: dir.join("issued-keys.json"),
        };
        fs::write(&paths.public_keys, "# trusted\n").unwrap();
        fs::write(&paths.revoked, "# revoked\n").unwrap();
        paths
    }

    /// Click into a field, as a user would, then type: keystrokes go to the focused widget.
    fn fill(h: &mut Harness<'static, KeygenApp>, role: Role, label: Option<&str>, text: &str) {
        fn node<'h>(h: &'h Harness<'static, KeygenApp>, role: Role, label: Option<&'h str>) -> egui_kittest::Node<'h> {
            match label {
                Some(label) => h.get_by_role_and_label(role, label),
                None => h.get_by_role(role),
            }
        }
        node(h, role, label).focus();
        h.run();
        node(h, role, label).type_text(text);
        h.run();
    }

    fn harness(app: KeygenApp) -> Harness<'static, KeygenApp> {
        Harness::builder()
            .with_size(egui::vec2(900.0, 700.0))
            .build_ui_state(|ui, app: &mut KeygenApp| app.show(ui), app)
    }

    #[test]
    fn issue_revoke_and_restore_through_the_window() {
        let paths = sandbox("flow");
        keygen::init(&paths, false).unwrap();
        let mut h = harness(KeygenApp::new(paths.clone()));

        fill(&mut h, Role::TextInput, Some("Email"), "buyer@example.com");
        fill(&mut h, Role::TextInput, Some("Note"), "order 7");
        h.get_by_label("Issue key").click();
        h.run();
        let issued = h.state().last_issued.clone().expect("a key was issued");
        assert_eq!(issued.email, "buyer@example.com");
        assert_eq!(Ledger::load(&paths).unwrap().keys, vec![issued.clone()]);

        h.get_by_label("Keys").click();
        h.run();
        h.get_by_label("Revoke…").click();
        h.run();
        fill(&mut h, Role::TextInput, Some("Reason"), "refund");
        h.get_by_label("Revoke").click();
        h.run();
        assert!(keygen::is_revoked(&paths, &issued.id));
        assert_eq!(Ledger::load(&paths).unwrap().keys[0].revoked.as_ref().unwrap().reason, "refund");

        h.get_by_label("Restore").click();
        h.run();
        assert!(!keygen::is_revoked(&paths, &issued.id));
    }

    #[test]
    fn check_tab_reports_valid_and_revoked_keys() {
        let paths = sandbox("check");
        keygen::init(&paths, false).unwrap();
        let issued = keygen::issue(&paths, "a@b.co", "").unwrap();
        let mut h = harness(KeygenApp::new(paths.clone()));

        h.get_by_label("Check key").click();
        h.run();
        fill(&mut h, Role::MultilineTextInput, None, &issued.key);
        assert!(h.query_by_label("✔ Valid").is_some());

        keygen::revoke(&paths, &issued.id, "").unwrap();
        fill(&mut h, Role::MultilineTextInput, None, " ");
        assert!(h.query_by_label_contains("Revoked").is_some());
    }

    #[test]
    fn without_a_signing_key_it_opens_on_setup() {
        let paths = sandbox("setup");
        let mut h = harness(KeygenApp::new(paths.clone()));
        assert_eq!(h.state().tab, Tab::Setup);
        h.get_by_label("Create signing key").click();
        h.run();
        assert!(h.state().ready(), "{:?}", h.state().checks);
    }
}
