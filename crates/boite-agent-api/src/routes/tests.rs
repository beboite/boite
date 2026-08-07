//! What the endpoint refuses, and why.
//!
//! Ported from the desktop copy, which was the only one of the two that had
//! tests. The half that runs headless — the half a remote agent talks to — was
//! the untested one, and it is the same code now.

use super::*;
use crate::testing::Fake;

/// A stand-in for the user's disk: `dev` holds the projects they already have,
/// `home` is their home folder, `elsewhere` is the rest of the machine.
fn disk(fake: &Fake) -> impl Fn(&str) -> String {
    let base = fake.scratch().clone();
    std::fs::create_dir_all(base.join("dev").join("thing")).unwrap();
    std::fs::create_dir_all(base.join("dev").join("team")).unwrap();
    std::fs::create_dir_all(base.join("home").join("ideas")).unwrap();
    std::fs::create_dir_all(base.join("elsewhere").join("deeper")).unwrap();
    std::fs::write(base.join("dev").join("thing").join("README.md"), "mine").unwrap();
    move |rel: &str| {
        let mut p = base.clone();
        for part in rel.split('/') {
            p = p.join(part);
        }
        p.to_string_lossy().to_string()
    }
}

/// The two places a project may go: beside one the user already has, and under
/// their home. The roots hold a project, and `new_project_parents` turns each
/// into its parent, which is why `dev/thing` is registered and `dev` is what
/// comes out.
fn allowing(fake: &mut Fake, at: &impl Fn(&str) -> String) {
    fake.roots.replace(vec![at("dev/thing")]);
    fake.extra_parents = vec![at("home")];
}

fn asking(path: Option<&str>, parent: Option<&str>, adopt: bool) -> CreateProjectIn {
    CreateProjectIn {
        name: "newproj".into(),
        path: path.map(str::to_string),
        parent: parent.map(str::to_string),
        adopt: Some(adopt),
        git: None,
        r#move: None,
        note: None,
    }
}

fn wrong_place() -> Option<String> {
    Some(WRONG_PLACE_FOR_A_PROJECT.to_string())
}

/// The field that used to reach the front end unread on the server: a parent is
/// as arbitrary as a path, and an agent naming a system folder is told so while
/// it is still running rather than being told its project is on the way.
#[test]
fn a_parent_outside_the_places_a_project_may_go_is_refused() {
    let mut fake = Fake::new("parent");
    let at = disk(&fake);
    allowing(&mut fake, &at);
    let refusal = |parent: &str| folder_refusal(&fake, &asking(None, Some(parent), false));

    assert_eq!(refusal(&at("elsewhere")), wrong_place());
    assert_eq!(refusal(&at("elsewhere/deeper")), wrong_place());
    assert_eq!(refusal(&at("dev/../elsewhere")), wrong_place());
    // Beside the projects already there, and under the home folder, are the two
    // that are allowed.
    assert_eq!(refusal(&at("dev")), None);
    assert_eq!(refusal(&at("home")), None);
    assert_eq!(refusal(&at("dev/team")), None);
}

#[test]
fn a_path_outside_the_places_a_project_may_go_is_refused() {
    let mut fake = Fake::new("path");
    let at = disk(&fake);
    allowing(&mut fake, &at);
    let refusal = |path: &str| folder_refusal(&fake, &asking(Some(path), None, false));

    assert_eq!(refusal(&at("elsewhere/newproj")), wrong_place());
    assert_eq!(refusal(&at("elsewhere/deeper/newproj")), wrong_place());
    // Climbing back out of a root lands outside it.
    assert_eq!(refusal(&at("dev/../elsewhere/newproj")), wrong_place());
    assert_eq!(refusal(&at("dev/newproj")), None);
    assert_eq!(refusal(&at("home/ideas/newproj")), None);
}

/// Somebody's work is never taken without saying so, wherever it sits.
#[test]
fn a_folder_with_files_in_it_is_refused_unless_it_is_adopted() {
    let mut fake = Fake::new("occupied");
    let at = disk(&fake);
    allowing(&mut fake, &at);
    let occupied = at("dev/thing");

    let reason = folder_refusal(&fake, &asking(Some(&occupied), None, false));
    assert!(
        reason.is_some_and(|r| r.starts_with(&occupied) && r.contains("adopt")),
        "an occupied folder names itself in the refusal"
    );
    assert_eq!(
        folder_refusal(&fake, &asking(Some(&occupied), None, true)),
        None
    );
}

/// A project already at that folder is a reuse, and a reuse asks none of the
/// questions above — including the one about where a project may go, which is
/// why a known folder outside every root is still not refused.
#[test]
fn a_project_already_there_is_reused_rather_than_refused() {
    for (tag, folder) in [("inside", "dev/thing"), ("outside", "elsewhere/thing")] {
        let mut fake = Fake::new(&format!("known-{tag}"));
        let at = disk(&fake);
        allowing(&mut fake, &at);
        let cwd = at(folder);
        fake.store
            .save_project(
                &boite_core::model::Project {
                    id: "p".into(),
                    name: "p".into(),
                    cwd: cwd.clone(),
                    icon: None,
                    archived: false,
                    git_root: None,
                    worktrees: None,
                },
                1,
            )
            .unwrap();
        assert_eq!(folder_refusal(&fake, &asking(Some(&cwd), None, false)), None);
    }
}

/// The path is where the project goes, so it is the one that answers. A caller
/// who named neither is left to Boite, which puts the folder beside the projects
/// already there.
#[test]
fn the_path_answers_when_both_are_given_and_nothing_does_when_neither_is() {
    let mut fake = Fake::new("both");
    let at = disk(&fake);
    allowing(&mut fake, &at);

    assert_eq!(
        folder_refusal(
            &fake,
            &asking(Some(&at("dev/newproj")), Some(&at("elsewhere")), false)
        ),
        None
    );
    assert_eq!(
        folder_refusal(
            &fake,
            &asking(Some(&at("elsewhere/newproj")), Some(&at("dev")), false)
        ),
        wrong_place()
    );
    assert_eq!(folder_refusal(&fake, &asking(None, None, false)), None);
    // A field holding nothing but spaces is a field nobody filled.
    assert_eq!(
        folder_refusal(&fake, &asking(Some("  "), Some(""), false)),
        None
    );
}

/// Ambiguity is refused rather than guessed: picking one would move a
/// conversation into the wrong repository, and the folder it then works in is
/// not something an undo covers.
#[test]
fn a_name_two_projects_answer_to_is_refused() {
    let fake = Fake::new("resolve");
    // Two of the three deliberately share a name.
    for (id, name, cwd) in [
        ("p1", "alpha", "/w/one"),
        ("p2", "beta", "/w/two"),
        ("p3", "alpha", "/w/three"),
    ] {
        fake.store
            .save_project(
                &boite_core::model::Project {
                    id: id.into(),
                    name: name.into(),
                    cwd: cwd.into(),
                    icon: None,
                    archived: false,
                    git_root: None,
                    worktrees: None,
                },
                1,
            )
            .unwrap();
    }

    // An id, a path and a name that only one project answers to.
    assert_eq!(
        resolve_project(&fake, "p2").unwrap(),
        ("p2".into(), "beta".into())
    );
    assert_eq!(resolve_project(&fake, "/w/three").unwrap().0, "p3");
    assert_eq!(resolve_project(&fake, "BETA").unwrap().0, "p2");
    assert!(resolve_project(&fake, "alpha")
        .unwrap_err()
        .contains("more than one project"));
    assert!(resolve_project(&fake, "nothing")
        .unwrap_err()
        .contains("projects_list"));
    assert_eq!(
        resolve_project(&fake, "   ").unwrap_err(),
        "name the project to move into"
    );
}

/// A caller with a terminal behind it, as `auth::identify` would have built one.
fn agent(project_id: &str, thread_id: &str) -> Caller {
    Caller {
        project_id: project_id.into(),
        thread_id: Some(thread_id.into()),
        grant: boite_core::capability::Grant::Owner,
        agent: None,
    }
}

/// A gated call is not carried out. It is recorded, the user is told, and the
/// agent is told to stop asking.
#[test]
fn a_call_across_projects_waits_for_the_user() {
    let fake = Fake::new("gate").with_project("p1", "/w/one");
    let caller = agent("p1", "t1");
    let request = json!({ "kind": "thread.move", "threadId": "t1", "projectId": "p2" });

    let Json(answer) = ask_the_user(&fake, &caller, "thread.move", "other", request.clone());

    assert_eq!(answer["retryable"], json!(false));
    assert_eq!(answer["status"], json!(boite_core::approval::AWAITING));
    // No `error` field, deliberately. Every client on the far side reads one as
    // a failed call, and this call did not fail.
    assert!(answer.get("error").is_none(), "{answer}");
    assert!(answer["note"].as_str().unwrap().contains("worked"));
    // Nothing was dispatched. This is the whole difference from the route it
    // replaced, which handed the move to a device and answered success.
    assert!(fake.asked.lock().unwrap().is_empty());
    assert_eq!(fake.announced.lock().unwrap().as_slice(), [Change::Approvals]);

    let open = fake.store.open_approvals().unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].action, "thread.move");
    assert_eq!(open[0].detail, "other");
    assert_eq!(open[0].thread_id, "t1");
    assert_eq!(open[0].id, answer["approvalId"].as_str().unwrap());

    // And allowing it runs what was stored, not a rebuild of it.
    let decided = crate::decide(&fake, &open[0].id, boite_core::approval::Verdict::Allowed, 99)
        .unwrap()
        .expect("the first answer lands");
    assert_eq!(decided.id, open[0].id);
    assert_eq!(fake.asked.lock().unwrap().as_slice(), [request]);
}

/// Refusing one dispatches nothing at all.
#[test]
fn a_refused_call_never_runs() {
    let fake = Fake::new("gate-refuse").with_project("p1", "/w/one");
    let caller = agent("p1", "t1");
    let Json(answer) = ask_the_user(
        &fake,
        &caller,
        "project.create",
        "newproj",
        json!({ "kind": "project.create", "name": "newproj" }),
    );
    let id = answer["approvalId"].as_str().unwrap().to_string();

    crate::decide(&fake, &id, boite_core::approval::Verdict::Refused, 99)
        .unwrap()
        .expect("the answer lands");
    assert!(fake.asked.lock().unwrap().is_empty());
    assert!(fake.store.open_approvals().unwrap().is_empty());
}

/// Yolo answers for the user, and leaves the same trail as a card they clicked.
#[test]
fn yolo_allows_the_call_without_asking() {
    let fake = Fake::new("gate-yolo").with_project("p1", "/w/one");
    fake.store
        .save_settings(&json!({ "mcpYolo": true }))
        .unwrap();
    let caller = agent("p1", "t1");
    let request = json!({ "kind": "thread.spawn", "projectId": "p2" });

    let Json(answer) = ask_the_user(&fake, &caller, "thread.spawn", "other", request.clone());

    assert_eq!(answer["status"], json!(boite_core::approval::AUTO_ALLOWED));
    assert_eq!(answer["ok"], json!(true));
    // Dispatched, not queued: nothing is left for the user to answer.
    assert_eq!(fake.asked.lock().unwrap().as_slice(), [request]);
    assert!(fake.store.open_approvals().unwrap().is_empty());
}

/// And the toggle is read per call, so turning it off stops the next one rather
/// than the next session.
#[test]
fn yolo_off_still_waits() {
    let fake = Fake::new("gate-yolo-off").with_project("p1", "/w/one");
    fake.store
        .save_settings(&json!({ "mcpYolo": false }))
        .unwrap();
    let Json(answer) = ask_the_user(
        &fake,
        &agent("p1", "t1"),
        "thread.spawn",
        "other",
        json!({ "kind": "thread.spawn" }),
    );
    assert_eq!(answer["status"], json!(boite_core::approval::AWAITING));
    assert!(fake.asked.lock().unwrap().is_empty());
}

/// A credential with no terminal behind it does not get to ask at all, so the
/// user is never shown a card for it. The refusal is the answer, and it says
/// retrying is pointless.
#[test]
fn a_credentials_file_is_refused_before_anybody_is_asked() {
    let fake = Fake::new("gate-project-grant").with_project("p1", "/w/one");
    let caller = Caller {
        project_id: "p1".into(),
        thread_id: None,
        grant: boite_core::capability::Grant::Project,
        agent: None,
    };
    let refusal = permitted(&fake, &caller, Capability::MutateAcross, "thread.move", "");
    let Err(Json(body)) = refusal else {
        panic!("a credentials file must not reach across projects");
    };
    assert_eq!(body["retryable"], json!(false));
    assert!(fake.store.open_approvals().unwrap().is_empty());
}
