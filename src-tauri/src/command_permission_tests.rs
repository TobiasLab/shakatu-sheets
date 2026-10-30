//! A command registered in `lib.rs` but missing from `build.rs` or every capability compiles and passes other tests,
//! then fails at runtime with "not allowed. Command not found". These checks read the three sources as text.

use std::collections::BTreeSet;

fn registered_commands() -> BTreeSet<String> {
    let source = include_str!("lib.rs");
    let start = source
        .find("generate_handler![")
        .expect("lib.rs registers commands with generate_handler!");
    // Attributes such as `#[cfg(...)]` contain `]`, so look for the end of the macro call.
    let end = start
        + source[start..]
            .find("]);")
            .expect("end of generate_handler!");
    source[start + "generate_handler![".len()..end]
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("//"))
        .map(|line| {
            let path = line.trim_end_matches(',');
            path.rsplit("::").next().unwrap_or(path).to_string()
        })
        .collect()
}

fn manifest_commands() -> BTreeSet<String> {
    let source = include_str!("../build.rs");
    let start = source
        .find("const COMMANDS")
        .expect("build.rs declares COMMANDS");
    let end = start + source[start..].find("];").expect("end of COMMANDS");
    source[start..end]
        .lines()
        .filter_map(|line| line.trim().strip_prefix('"')?.split('"').next())
        .map(str::to_string)
        .collect()
}

fn granted_permissions(capability: &str) -> BTreeSet<String> {
    let value: serde_json::Value = serde_json::from_str(capability).expect("valid capability JSON");
    value["permissions"]
        .as_array()
        .expect("capability lists permissions")
        .iter()
        .filter_map(|permission| permission.as_str().map(str::to_string))
        .collect()
}

#[test]
fn every_registered_command_is_declared_in_the_build_manifest() {
    assert_eq!(registered_commands(), manifest_commands());
}

// A grant in the overlay's capability does not let the main window call a command, so check the main window's alone.
// Only overlay placement is withheld from it.
#[test]
fn the_main_window_may_call_every_command_except_overlay_placement() {
    let granted = granted_permissions(include_str!("../capabilities/default.json"));
    let missing: Vec<_> = manifest_commands()
        .into_iter()
        .filter(|command| command != "adjust_session_overlay")
        .filter(|command| !granted.contains(&format!("allow-{}", command.replace('_', "-"))))
        .collect();
    assert!(
        missing.is_empty(),
        "commands the main window may not call: {missing:?}"
    );
}
