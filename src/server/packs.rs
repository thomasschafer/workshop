//! The packs, as the app's Packs screen shows them: each pack's skills and drafts, and importing
//! a question into one as a draft.

use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};
use workshop_pack::Draft;

use super::error::{ApiResult, bad_request};
use super::state::Shared;
use crate::pack_files::{Import, Imported};

#[derive(Serialize)]
pub(super) struct Packs {
    packs: Vec<PackShown>,
}

#[derive(Serialize)]
pub(super) struct PackShown {
    id: String,
    name: String,
    /// Whether it can be changed: the sample pack is built in.
    editable: bool,
    skills: Vec<workshop_pack::Skill>,
    drafts: Vec<Draft>,
}

pub(super) async fn packs(State(app): State<Shared>) -> ApiResult<Packs> {
    let editable = !app.config.learning.packs.is_empty();
    let packs = crate::packs::load(&app.config.learning)?
        .into_iter()
        .map(|pack| PackShown {
            id: pack.manifest.id,
            name: pack.manifest.name,
            editable,
            skills: pack.manifest.skills,
            drafts: pack.drafts,
        })
        .collect();
    Ok(Json(Packs { packs }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ImportBody {
    pack: String,
    #[serde(flatten)]
    import: Import,
}

/// Adds a question to a pack as a draft, for the author to make into an item with a check.
pub(super) async fn import(
    State(app): State<Shared>,
    Json(body): Json<ImportBody>,
) -> ApiResult<Imported> {
    let dir = crate::pack_files::pack_dir(&app.config.learning, &body.pack)
        .map_err(|err| bad_request(format!("{err:#}")))?;
    let today = crate::pack_files::date(crate::learning::now_ms().div_euclid(86_400_000));
    let imported = crate::pack_files::import(&dir, body.import, &today)
        .await
        .map_err(|err| bad_request(format!("{err:#}")))?;
    Ok(Json(imported))
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::extract::Request;
    use axum::http::{StatusCode, header};

    use crate::server::testing::{send, test_app, test_app_in};

    fn request(method: &str, path: &str, body: Option<serde_json::Value>) -> Request {
        Request::builder()
            .method(method)
            .uri(path)
            .header(header::COOKIE, "workshop_token=secret")
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.map_or_else(Body::empty, |b| Body::from(b.to_string())))
            .unwrap()
    }

    async fn json(response: axum::response::Response) -> serde_json::Value {
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    #[tokio::test]
    async fn imports_a_question_into_a_pack_of_ones_own() {
        let dir = tempfile::tempdir().unwrap();
        let pack = dir.path().join("pack");
        crate::pack_files::testing::sample_pack_repo(&pack);
        let router = test_app_in(
            dir.path(),
            &format!("[learning]\npacks = [{:?}]\n", pack.display().to_string()),
        );
        let body = serde_json::json!({
            "pack": "sample",
            "text": "What's the chance that three dice all differ?",
            "source": "Made up on a walk",
            "skills": ["probability.counting"],
            "kind": "probability",
        });
        let response = send(&router, request("POST", "/api/packs/import", Some(body))).await;
        assert_eq!(response.status(), StatusCode::OK);
        let imported = json(response).await;
        assert_eq!(imported["draft"]["source"], "Made up on a walk");
        assert!(imported["commit"].is_string());
        let packs = json(send(&router, request("GET", "/api/packs", None)).await).await;
        assert_eq!(packs["packs"][0]["editable"], true);
        assert_eq!(
            packs["packs"][0]["drafts"][0]["text"],
            "What's the chance that three dice all differ?"
        );
        let unknown = serde_json::json!({ "pack": "sample", "text": "Q", "skills": ["chess"] });
        let response = send(&router, request("POST", "/api/packs/import", Some(unknown))).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn says_the_sample_pack_cant_be_changed() {
        let (_dir, router) = test_app().await;
        let packs = json(send(&router, request("GET", "/api/packs", None)).await).await;
        assert_eq!(packs["packs"][0]["editable"], false);
        let body = serde_json::json!({ "pack": "sample", "text": "Q", "skills": ["probability.counting"] });
        let response = send(&router, request("POST", "/api/packs/import", Some(body))).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
