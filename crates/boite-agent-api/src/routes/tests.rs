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

// ------------------------------------------------------------ the browser pane

use boite_core::screen::{Pane, Rect, Screen, Window};

fn owner(project: &str, thread: Option<&str>) -> Caller {
    Caller {
        project_id: project.into(),
        thread_id: thread.map(str::to_string),
        grant: boite_core::capability::Grant::Owner,
        agent: None,
    }
}

fn on_screen(project: &str, panes: Vec<Pane>) -> Screen {
    Screen {
        at: 1,
        project_id: project.into(),
        window: Window { width: 1280.0, height: 720.0, focused: true },
        panes,
        overlays: Vec::new(),
    }
}

fn framed(id: &str, url: &str, driven_by: Option<&str>) -> Pane {
    Pane {
        id: id.into(),
        kind: "browser".into(),
        title: "localhost".into(),
        thread_id: None,
        url: Some(url.into()),
        page: Some("loaded".into()),
        driven_by: driven_by.map(str::to_string),
        rect: Rect { x: 0.0, y: 0.0, w: 640.0, h: 600.0 },
        focused: false,
        // Framed and driven while the user reads another group is the ordinary
        // case now, and none of the rules below turn on being looked at. Only
        // the screenshot does, and it refuses on the webview side.
        visible: Some(false),
    }
}

/// Nothing to point, an id that is not there, and two to choose between are
/// three different things to do next, so they are three different sentences.
#[test]
fn a_browser_call_says_which_of_the_three_ways_it_could_not_find_a_pane() {
    let caller = owner("p1", Some("t1"));

    let none = on_screen("p1", Vec::new());
    assert!(which_pane(&none, &caller, None).unwrap_err().contains("no browser pane is open"));

    let one = on_screen("p1", vec![framed("pane-a", "http://localhost:1/", Some("t1"))]);
    assert!(which_pane(&one, &caller, Some("pane-z")).unwrap_err().contains("no browser pane called"));
    assert_eq!(which_pane(&one, &caller, None).unwrap(), "pane-a");

    let two = on_screen(
        "p1",
        vec![
            framed("pane-a", "http://localhost:1/", Some("t1")),
            framed("pane-b", "http://localhost:2/", Some("t1")),
        ],
    );
    assert!(which_pane(&two, &caller, None).unwrap_err().contains("say which"));
    assert_eq!(which_pane(&two, &caller, Some("pane-b")).unwrap(), "pane-b");
}

/// The hand-back, which is the whole product answer to "an agent is driving my
/// pane". Clearing the mark is all the user does, and it is enforced here.
#[test]
fn a_pane_the_user_took_back_is_no_longer_the_agents_to_point() {
    let caller = owner("p1", Some("t1"));
    let driven = on_screen("p1", vec![framed("pane-a", "http://localhost:1/", Some("t1"))]);
    assert!(which_pane(&driven, &caller, None).is_ok());

    let reclaimed = on_screen("p1", vec![framed("pane-a", "http://localhost:1/", None)]);
    assert_eq!(which_pane(&reclaimed, &caller, None).unwrap_err(), NOT_YOURS);

    // And another terminal's pane is not this one's either.
    let theirs = on_screen("p1", vec![framed("pane-a", "http://localhost:1/", Some("t2"))]);
    assert_eq!(which_pane(&theirs, &caller, None).unwrap_err(), NOT_YOURS);
}

/// A credentials file has no terminal behind it, so it opened nothing and
/// drives nothing. Written as its own case because an empty thread id compared
/// against an absent mark would otherwise match every pane the user owns.
#[test]
fn a_credential_with_no_terminal_drives_no_pane() {
    let caller = owner("p1", None);
    let user_owned = on_screen("p1", vec![framed("pane-a", "http://localhost:1/", None)]);
    assert_eq!(which_pane(&user_owned, &caller, None).unwrap_err(), NOT_YOURS);
}

/// The regression that made the browser tools unusable in the one situation
/// they exist for: an agent working while the user reads something else. The
/// window used to answer only for the project whose group it was drawing, so an
/// agent in another project was told "the window is showing another project
/// right now" by every browser call, including for the pane it had opened
/// itself a second earlier. Every group stays mounted, so that pane is loaded
/// and answering the whole time.
#[test]
fn a_pane_stays_the_callers_wherever_the_user_is_looking() {
    let fake = Fake::new("browser-project").with_project("p1", "/w/one");
    let caller = owner("p1", Some("t1"));
    *fake.screen.lock().unwrap() = Some(on_screen(
        "p2",
        vec![framed("pane-a", "http://localhost:1/", Some("t1"))],
    ));

    let screen = window_showing(&fake).expect("a window that is up answers");
    assert_eq!(which_pane(&screen, &caller, None).unwrap(), "pane-a");
}

/// And the other half: being on the screen was never what made a pane the
/// agent's, so nothing about looking elsewhere hands it one it does not own.
#[test]
fn the_mark_is_the_only_thing_that_makes_a_pane_the_callers() {
    let caller = owner("p1", Some("t1"));
    // Two panes the user owns and one of the caller's, which is the ordinary
    // shape of a window once the description carries every group's panes.
    let mixed = on_screen(
        "p2",
        vec![
            framed("pane-a", "http://localhost:1/", None),
            framed("pane-b", "http://localhost:2/", Some("t2")),
            framed("pane-c", "http://localhost:3/", Some("t1")),
        ],
    );
    // Named nothing: its own, rather than "three panes are open, say which".
    assert_eq!(which_pane(&mixed, &caller, None).unwrap(), "pane-c");
    // Named somebody else's: told whose it is, not told it does not exist.
    assert_eq!(which_pane(&mixed, &caller, Some("pane-b")).unwrap_err(), NOT_YOURS);
    assert_eq!(which_pane(&mixed, &caller, Some("pane-a")).unwrap_err(), NOT_YOURS);

    // None of its own, and the sentence points at how to get one.
    let theirs = on_screen("p1", vec![framed("pane-a", "http://localhost:1/", Some("t2"))]);
    assert_eq!(which_pane(&theirs, &caller, None).unwrap_err(), NOT_YOURS);
}

/// A host with no window says so rather than answering an empty list. "No
/// browser pane is open" and "I cannot see whether one is" send an agent to two
/// different places, which is the same reason `transcripts_dir` answers `None`.
#[test]
fn a_boite_with_no_window_says_so_rather_than_answering_empty() {
    let fake = Fake::new("browser-headless").with_project("p1", "/w/one");
    assert_eq!(window_showing(&fake).unwrap_err(), NO_WINDOW_TO_LOOK_AT);
}

/// The status answer is scoped to the caller: a pane id means nothing to an
/// agent that is not driving it, so what goes out is whether it is theirs.
#[test]
fn status_says_whose_a_pane_is_rather_than_which_thread_holds_it() {
    let mine = describe(
        &on_screen("p1", vec![framed("pane-a", "http://localhost:1/", Some("t1"))]),
        &owner("p1", Some("t1")),
    );
    assert_eq!(mine[0]["yours"], json!(true));
    assert_eq!(mine[0]["url"], json!("http://localhost:1/"));
    assert_eq!(mine[0]["page"], json!("loaded"));
    assert!(mine[0].get("drivenBy").is_none());

    let theirs = describe(
        &on_screen("p1", vec![framed("pane-a", "http://localhost:1/", Some("t2"))]),
        &owner("p1", Some("t1")),
    );
    assert_eq!(theirs[0]["yours"], json!(false));
}

/// The question routes are strict where the verbs are lenient: a verb can be
/// dispatched blind because the device re-checks, but a question needs an
/// answer channel, so a host whose devices cannot answer says so up front.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_page_question_on_a_deviceless_host_is_refused_with_the_reason() {
    let fake = Fake::new("browser-no-answers").with_project("p1", "/w/one");
    *fake.screen.lock().unwrap() =
        Some(on_screen("p1", vec![framed("pane-a", "http://localhost:1/", Some("t1"))]));
    let shared: Shared = std::sync::Arc::new(fake);

    let out = browser_snapshot(
        State(shared),
        Extension(owner("p1", Some("t1"))),
        axum::extract::Query(SnapshotIn { pane_id: None, mode: None, max_chars: None }),
    )
    .await
    .unwrap();
    assert_eq!(out.0["error"], json!(crate::DEVICE_CANNOT_ANSWER));
}

/// The happy path end to end: the request that reaches the device carries the
/// verb, the pane and a requestId, and the device's answer comes back to the
/// very call that asked, stamped with the pane it was about.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_snapshot_rides_out_and_the_answer_rides_back() {
    let fake = Fake::new("browser-snapshot").with_project("p1", "/w/one");
    *fake.screen.lock().unwrap() =
        Some(on_screen("p1", vec![framed("pane-a", "http://localhost:1/", Some("t1"))]));
    *fake.answer_with.lock().unwrap() = Some(json!({
        "url": "http://localhost:1/app",
        "title": "App",
        "elements": [{ "u": "u1", "r": "button", "n": "Save" }]
    }));
    let shared: Shared = std::sync::Arc::new(fake);

    let out = browser_snapshot(
        State(shared.clone()),
        Extension(owner("p1", Some("t1"))),
        axum::extract::Query(SnapshotIn {
            pane_id: None,
            mode: Some("elements".into()),
            max_chars: None,
        }),
    )
    .await
    .unwrap();
    assert_eq!(out.0["paneId"], json!("pane-a"));
    assert_eq!(out.0["url"], json!("http://localhost:1/app"));
    assert_eq!(out.0["elements"][0]["u"], json!("u1"));
}

/// The mark still rules: a question at a pane the agent is not driving is the
/// same refusal as a verb, before anything reaches a device.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_question_at_a_reclaimed_pane_is_not_the_agents_to_ask() {
    let fake = Fake::new("browser-question-mark").with_project("p1", "/w/one");
    *fake.screen.lock().unwrap() =
        Some(on_screen("p1", vec![framed("pane-a", "http://localhost:1/", None)]));
    *fake.answer_with.lock().unwrap() = Some(json!({ "ok": true }));
    let shared: Shared = std::sync::Arc::new(fake);

    let out = browser_click(
        State(shared),
        Extension(owner("p1", Some("t1"))),
        Json(ClickIn { pane_id: None, uid: "u1".into(), double: None }),
    )
    .await
    .unwrap();
    assert_eq!(out.0["error"], json!(NOT_YOURS));
}

/// A mode this does not know is a sentence, not a guess at what was meant.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unknown_snapshot_mode_is_refused_by_name() {
    let fake = Fake::new("browser-mode").with_project("p1", "/w/one");
    let shared: Shared = std::sync::Arc::new(fake);
    let out = browser_snapshot(
        State(shared),
        Extension(owner("p1", Some("t1"))),
        axum::extract::Query(SnapshotIn {
            pane_id: None,
            mode: Some("screenshotish".into()),
            max_chars: None,
        }),
    )
    .await
    .unwrap();
    assert!(out.0["error"].as_str().unwrap().contains("elements, diff or text"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawn_answers_with_the_new_thread_id() {
    let fake = Fake::new("spawn-id").with_project("p1", "/w/one").with_thread("t1", "p1");
    *fake.answer_with.lock().unwrap() = Some(json!({ "threadId": "new-1" }));
    let shared: Shared = std::sync::Arc::new(fake);
    let out = thread_spawn(
        State(shared),
        Extension(agent("p1", "t1")),
        Json(SpawnIn {
            agent: Some("claude".into()),
            project: None,
            prompt: None,
        }),
    )
    .await
    .unwrap();
    assert_eq!(out.0["ok"], json!(true));
    assert_eq!(out.0["threadId"], json!("new-1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn spawn_without_a_device_is_not_success() {
    let fake = Fake::new("spawn-nobody").with_project("p1", "/w/one").with_thread("t1", "p1");
    let shared: Shared = std::sync::Arc::new(fake);
    let out = thread_spawn(
        State(shared),
        Extension(agent("p1", "t1")),
        Json(SpawnIn {
            agent: None,
            project: None,
            prompt: None,
        }),
    )
    .await
    .unwrap();
    assert!(out.0.get("error").is_some(), "{:?}", out.0);
    assert_ne!(out.0.get("ok"), Some(&json!(true)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pane_open_forwards_the_path() {
    let fake = std::sync::Arc::new(
        Fake::new("pane-path").with_project("p1", "/w/one").with_thread("t1", "p1"),
    );
    *fake.answer_with.lock().unwrap() = Some(json!({ "ok": true }));
    let shared: Shared = fake.clone();
    let out = pane_open(
        State(shared),
        Extension(agent("p1", "t1")),
        Json(PaneOpenIn {
            kind: "editor".into(),
            url: None,
            path: Some("src/lib.rs".into()),
            side: None,
        }),
    )
    .await
    .unwrap();
    assert_eq!(out.0["ok"], json!(true));
    let asked = fake.asked.lock().unwrap();
    assert_eq!(asked[0]["path"], json!("src/lib.rs"));
    assert_eq!(asked[0]["pane"], json!("editor"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_reports_a_known_sibling() {
    let fake = Fake::new("wait").with_project("p1", "/w/one").with_thread("sib", "p1");
    let shared: Shared = std::sync::Arc::new(fake);
    let out = thread_wait(
        State(shared),
        Extension(agent("p1", "t1")),
        axum::extract::Query(ThreadWaitIn {
            thread_id: "sib".into(),
            timeout_ms: Some(0),
        }),
    )
    .await
    .unwrap();
    assert_eq!(out.0["threadId"], json!("sib"));
    assert_eq!(out.0["live"], json!(false));
    assert!(out.0.get("status").is_some(), "{:?}", out.0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn whereami_names_this_thread_and_project() {
    let fake = Fake::new("where").with_project("p1", "/w/one").with_thread("t1", "p1");
    let shared: Shared = std::sync::Arc::new(fake);
    let out = whereami(State(shared), Extension(agent("p1", "t1")))
        .await
        .unwrap();
    assert_eq!(out.0["thread"], json!("t1"));
    assert_eq!(out.0["project"], json!("p1"));
    assert_eq!(out.0["projectId"], json!("p1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn finish_allows_when_there_is_no_worktree() {
    let fake = Fake::new("finish").with_project("p1", "/w/one").with_thread("t1", "p1");
    let shared: Shared = std::sync::Arc::new(fake);
    let out = finish(
        State(shared),
        Extension(agent("p1", "t1")),
        axum::extract::Query(FinishIn {
            stop_hook_active: None,
        }),
    )
    .await
    .unwrap();
    assert_eq!(out.0["allow"], json!(true));
}

/// The cap is per orchestrator and counts only live workers: settle one and
/// the next spawn goes through.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_orchestrator_past_the_worker_cap_is_refused_by_name() {
    let fake = Fake::new("spawn-cap")
        .with_project("p1", "/w/one")
        .with_thread("boss", "p1")
        .with_child("w1", "p1", "boss")
        .with_child("w2", "p1", "boss")
        .with_child("w3", "p1", "boss");
    fake.store.stamp_orchestrator_role("boss", None).unwrap();
    *fake.answer_with.lock().unwrap() = Some(json!({ "threadId": "new-1" }));
    let fake = std::sync::Arc::new(fake);
    let ask = |shared: Shared| async move {
        thread_spawn(
            State(shared),
            Extension(agent("p1", "boss")),
            Json(SpawnIn {
                agent: Some("claude".into()),
                project: None,
                prompt: None,
            }),
        )
        .await
        .unwrap()
    };
    let refused = ask(fake.clone() as Shared).await;
    assert!(
        refused.0["error"].as_str().unwrap().contains("TOO_MANY_WORKERS"),
        "{:?}",
        refused.0
    );
    fake.store
        .update_thread_field(
            "w3",
            boite_core::store::ThreadCol::SettledAt,
            boite_core::store::ColVal::Int(1),
        )
        .unwrap();
    let allowed = ask(fake.clone() as Shared).await;
    assert_eq!(allowed.0["ok"], json!(true), "{:?}", allowed.0);
}

/// The row is the proof for `/v1/say`, same as on the bus.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn say_is_the_orchestrators_alone_and_announces() {
    let fake = std::sync::Arc::new(
        Fake::new("say-role")
            .with_project("p1", "/w/one")
            .with_thread("worker", "p1")
            .with_thread("boss", "p1"),
    );
    fake.store.stamp_orchestrator_role("boss", None).unwrap();
    let body = || SayIn {
        text: "done".into(),
        aloud: Some("done".into()),
        urgency: Some("answer".into()),
    };
    let refused = say(
        State(fake.clone() as Shared),
        Extension(agent("p1", "worker")),
        Json(body()),
    )
    .await
    .unwrap();
    assert!(refused.0["error"].as_str().unwrap().contains("not one"));
    assert!(fake.announced.lock().unwrap().is_empty());

    let said = say(
        State(fake.clone() as Shared),
        Extension(agent("p1", "boss")),
        Json(body()),
    )
    .await
    .unwrap();
    assert!(said.0["messageId"].as_str().is_some(), "{:?}", said.0);
    assert!(matches!(
        fake.announced.lock().unwrap().as_slice(),
        [crate::Change::Orchestrator]
    ));
}

/// A zero-timeout pulse on a quiet host answers now and honestly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_quiet_pulse_with_no_wait_answers_now() {
    let fake = std::sync::Arc::new(
        Fake::new("pulse-now").with_project("p1", "/w/one").with_thread("boss", "p1"),
    );
    let out = pulse(
        State(fake.clone() as Shared),
        Extension(agent("p1", "boss")),
        axum::extract::Query(PulseIn {
            since_seq: Some(0),
            timeout_ms: Some(0),
            project: None,
        }),
    )
    .await
    .unwrap();
    assert_eq!(out.0["timedOut"], json!(false));
    assert_eq!(out.0["moments"], json!([]));
}

/// A scoped orchestrator's pulse is clamped to its project: whatever project
/// it asks for, it reads its own and nothing else.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_scoped_orchestrator_reads_its_own_project_whatever_it_asks() {
    let fake = std::sync::Arc::new(
        Fake::new("pulse-clamp").with_project("p1", "/w/one").with_thread("qboss", "p1"),
    );
    fake.store().stamp_orchestrator_role("qboss", Some("p1")).unwrap();
    fake.store()
        .append_moment("thread.phase", Some("p1"), None, "own", "phase", 1)
        .unwrap();
    fake.store()
        .append_moment("thread.phase", Some("p2"), None, "other", "phase", 2)
        .unwrap();
    let out = pulse(
        State(fake.clone() as Shared),
        Extension(agent("p1", "qboss")),
        axum::extract::Query(PulseIn {
            since_seq: Some(0),
            timeout_ms: Some(0),
            project: Some("p2".into()),
        }),
    )
    .await
    .unwrap();
    let moments = out.0["moments"].as_array().unwrap().clone();
    assert_eq!(moments.len(), 1, "{moments:?}");
    assert_eq!(moments[0]["detail"], json!("own"), "{moments:?}");
}

/// A scoped orchestrator spawning outside its project is refused by name,
/// before any permission is asked: crossing over is the one capability its
/// scope withholds.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_scoped_orchestrator_cannot_spawn_across() {
    let fake = Fake::new("spawn-across")
        .with_project("p1", "/w/one")
        .with_project("p2", "/w/two")
        .with_thread("qboss", "p1");
    fake.store().stamp_orchestrator_role("qboss", Some("p1")).unwrap();
    let shared: Shared = std::sync::Arc::new(fake);
    let out = thread_spawn(
        State(shared),
        Extension(agent("p1", "qboss")),
        Json(SpawnIn {
            agent: Some("claude".into()),
            project: Some("p2".into()),
            prompt: None,
        }),
    )
    .await
    .unwrap();
    assert!(
        out.0["error"].as_str().unwrap().contains("OUT_OF_SCOPE"),
        "{:?}",
        out.0
    );
}
