//! Runs editing cases through Helix and records what it does, for scripts/helix-oracle/oracle.sh,
//! which copies this into a Helix checkout's helix-term/tests. ORACLE_IN is a JSON array of cases,
//! and each result is written to ORACLE_OUT as a line of JSON, as oracle.sh describes.
#![cfg(feature = "integration")]

#[path = "test/helpers.rs"]
#[allow(dead_code)]
mod helpers;

use std::cell::RefCell;

use helix_core::test;
use helix_view::{current_ref, doc};
use serde_json::{json, Value};

use helpers::*;

#[tokio::test(flavor = "multi_thread")]
async fn oracle() -> anyhow::Result<()> {
    let path = std::env::var("ORACLE_IN").expect("ORACLE_IN");
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let out_path = std::env::var("ORACLE_OUT").expect("ORACLE_OUT");
    let mut sink = std::io::BufWriter::new(std::fs::File::create(out_path)?);
    for (index, case) in cases.into_iter().enumerate() {
        let input = case["input"].as_str().expect("input").to_string();
        let mut keys = case["keys"].as_str().expect("keys").to_string();
        if let Some(lang) = case["lang"].as_str() {
            keys = format!(":lang {lang}<ret>{keys}");
        }
        // Loaded from a file, as a document is opened, so its text isn't an undoable change.
        let (text, selection) = test::print(&LineFeedHandling::AsIs.apply(&input));
        let dir = tempfile::tempdir()?;
        let ext = match case["lang"].as_str() {
            Some("haskell") => "hs",
            Some("python") => "py",
            Some("rust") => "rs",
            Some("go") => "go",
            Some("typescript") => "ts",
            _ => "txt",
        };
        let path = dir.path().join(format!("case.{ext}"));
        std::fs::write(&path, &text)?;
        let mut builder = AppBuilder::new().with_file(path.clone(), None);
        if let Some(cfg) = case["config"].as_str() {
            let mut config = test_config();
            config.editor = toml::from_str::<toml::Value>(cfg)?
                .try_into()
                .map(|e: helix_view::editor::Config| helix_view::editor::Config {
                    lsp: test_editor_config().lsp,
                    word_completion: test_editor_config().word_completion,
                    workspace_trust: test_editor_config().workspace_trust,
                    ..e
                })?;
            builder = builder.with_config(config);
        }
        let out: RefCell<Value> = RefCell::new(Value::Null);
        let run = async {
            let mut app = builder.build()?;
            {
                let (view, doc) = helix_view::current!(app.editor);
                assert_eq!(doc.text().to_string(), text, "the file loaded as written");
                doc.set_selection(view.id, selection.clone());
            }
            test_key_sequences(
                &mut app,
                vec![(
                    Some(&keys),
                    Some(&|app: &helix_term::application::Application| {
                        let (view, doc) = current_ref!(app.editor);
                        let _ = doc!(app.editor);
                        let state = test::plain(doc.text().slice(..), doc.selection(view.id));
                        let status = app.editor.get_status().map(|(m, s)| format!("{s:?}: {m}"));
                        let sel = doc.selection(view.id);
                        let ranges: Vec<_> = sel.iter().map(|r| json!([r.anchor, r.head])).collect();
                        *out.borrow_mut() = json!({
                            "output": state,
                            "text": doc.text().to_string(),
                            "ranges": ranges,
                            "primary": sel.primary_index(),
                            "status": status,
                            "mode": format!("{:?}", app.editor.mode),
                        });
                    }),
                )],
                false,
            )
            .await
        };
        let mut result = match run.await {
            Ok(()) => out.into_inner(),
            Err(e) => json!({ "error": e.to_string(), "partial": out.into_inner() }),
        };
        result["index"] = json!(index);
        use std::io::Write;
        writeln!(sink, "{}", serde_json::to_string(&result)?)?;
        sink.flush()?;
    }
    Ok(())
}
