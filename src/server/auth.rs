//! Who may use the server: the token, the cookie that keeps it, and the page that asks for it.

use anyhow::{Context, Result};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Redirect, Response};

use super::state::Shared;
use crate::paths::Paths;

const TOKEN_COOKIE: &str = "workshop_token";

// Authentication: the token arrives once in the URL printed by `workshop serve`, and is then
// kept in an HttpOnly cookie.
pub(super) async fn auth(State(app): State<Shared>, request: Request, next: Next) -> Response {
    // What a browser fetches to install Workshop as an app, which may be before it has the
    // token, and which holds nothing private.
    if PUBLIC_ASSETS.contains(&request.uri().path()) {
        return next.run(request).await;
    }
    let query_token = request.uri().query().and_then(|q| {
        q.split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(k, _)| *k == "token")
            .map(|(_, v)| given_token(v))
    });
    if let Some(token) = query_token {
        if !constant_time_eq(token.as_bytes(), app.token.as_bytes()) {
            return unauthorised(Some(
                "That isn't Workshop's link or token. Check it was copied in full.",
            ));
        }
        // Lax rather than Strict: links opened from outside the browser, such as a scanned QR
        // code, count as cross-site, and Strict cookies wouldn't be sent after the redirect.
        // Requests that change anything are protected by the origin check below.
        let cookie = format!(
            "{TOKEN_COOKIE}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000",
            app.token
        );
        let mut response = Redirect::to(request.uri().path()).into_response();
        if let Ok(value) = cookie.parse() {
            response.headers_mut().insert(header::SET_COOKIE, value);
        }
        return response;
    }

    let authorised = cookie_token(request.headers())
        .is_some_and(|t| constant_time_eq(t.as_bytes(), app.token.as_bytes()));
    if !authorised {
        return unauthorised(None);
    }
    let is_websocket = request.headers().contains_key(header::UPGRADE);
    if (request.method() != Method::GET || is_websocket) && !same_origin(request.headers()) {
        return (StatusCode::FORBIDDEN, "Cross-origin request refused").into_response();
    }
    next.run(request).await
}

fn cookie_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == TOKEN_COOKIE)
        .map(|(_, value)| value)
}

fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) else {
        // Non-browser clients don't send an Origin, and browsers always do on these requests.
        return true;
    };
    let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    let origin_host = origin.split_once("://").map_or(origin, |(_, rest)| rest);
    origin_host.eq_ignore_ascii_case(host)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Served without the token: see `auth`.
const PUBLIC_ASSETS: &[&str] = &[
    "/manifest.webmanifest",
    "/sw.js",
    "/icon-192.png",
    "/icon-512.png",
    "/icon-maskable-512.png",
    "/apple-touch-icon.png",
];

/// The token from what was pasted into the form: the token itself, or the whole link with it,
/// which the form's submission encodes.
fn given_token(value: &str) -> String {
    let decoded = urlencoding::decode(&value.replace('+', " "))
        .map_or_else(|_| value.to_owned(), std::borrow::Cow::into_owned);
    let token = match decoded.rsplit_once("token=") {
        Some((_, rest)) => rest.split(['&', '#']).next().unwrap_or(rest),
        None => decoded.as_str(),
    };
    token.trim().to_owned()
}

/// Asks for the link with the token, such as on a phone that hasn't opened it yet, or in an app
/// added to an iPhone's home screen, which doesn't share Safari's cookies.
fn unauthorised(problem: Option<&str>) -> Response {
    let problem = problem
        .map(|p| format!("<p class=problem>{p}</p>"))
        .unwrap_or_default();
    (
        StatusCode::UNAUTHORIZED,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        format!(
            "<!doctype html><meta charset=utf-8>\
             <meta name=viewport content='width=device-width, initial-scale=1'>\
             <meta name=color-scheme content='light dark'><title>Workshop</title>\
             <style>\
             body{{font-family:ui-monospace,'SF Mono','JetBrains Mono','Cascadia Code',Menlo,\
             Consolas,monospace;padding:2rem 1.25rem;max-width:32rem;\
             margin:0 auto;line-height:1.5;background:#f7f6f3;color:#1d1d1f}}\
             @media(prefers-color-scheme:dark){{body{{background:#16161a;color:#ececf1}}}}\
             input,button{{font:inherit;font-size:16px;padding:.7rem .8rem;border-radius:10px;\
             border:1px solid #8888;width:100%;box-sizing:border-box;margin-top:.5rem}}\
             button{{background:#3d6ee0;color:#fff;border:none}}\
             .problem{{color:#d14343}}.muted{{opacity:.7;font-size:.9em}}\
             </style>\
             <h1 style='font-size:1.1rem'>Workshop</h1>{problem}\
             <form method=get action='/'>\
             <label for=token>Paste the link Workshop printed when it started, or its token.\
             </label><input id=token name=token autocomplete=off autocapitalize=off \
             spellcheck=false required><button>Open Workshop</button></form>\
             <p class=muted>On the server, <code>workshop token</code> shows the link again, \
             and <code>workshop token --tailscale</code> a QR code to scan.</p>"
        ),
    )
        .into_response()
}

pub fn load_or_create_token(paths: &Paths) -> Result<String> {
    let file = paths.token_file();
    match std::fs::read_to_string(&file) {
        Ok(token) if !token.trim().is_empty() => return Ok(token.trim().to_owned()),
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(err).with_context(|| format!("reading {}", file.display())),
    }
    let token = format!(
        "{:032x}{:032x}",
        rand::random::<u128>(),
        rand::random::<u128>()
    );
    crate::paths::write_private(&file, token.as_bytes())?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use axum::body::Body;

    use super::*;
    use crate::server::testing::{send, test_app};

    #[tokio::test]
    async fn token_link_sets_a_cookie_that_works_after_the_redirect() {
        let (_dir, router) = test_app().await;
        let response = send(
            &router,
            Request::get("/?token=secret").body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(response.headers()[header::LOCATION], "/");
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(cookie.contains("SameSite=Lax"), "{cookie}");
        assert!(cookie.contains("HttpOnly"), "{cookie}");

        let pair = cookie.split(';').next().unwrap().to_owned();
        let response = send(
            &router,
            Request::get("/api/bootstrap")
                .header(header::COOKIE, pair)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn rejects_missing_and_wrong_tokens() {
        let (_dir, router) = test_app().await;
        for request in [
            Request::get("/api/bootstrap").body(Body::empty()).unwrap(),
            Request::get("/?token=wrong").body(Body::empty()).unwrap(),
            Request::get("/api/bootstrap")
                .header(header::COOKIE, "workshop_token=wrong")
                .body(Body::empty())
                .unwrap(),
        ] {
            assert_eq!(
                send(&router, request).await.status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }

    #[test]
    fn takes_the_token_from_a_pasted_link() {
        assert_eq!(given_token("secret"), "secret");
        assert_eq!(given_token(" secret "), "secret");
        assert_eq!(
            given_token("https%3A%2F%2Fbox.ts.net%2F%3Ftoken%3Dsecret"),
            "secret"
        );
        assert_eq!(given_token("http://a/?x=1&token=secret&y=2"), "secret");
    }

    #[tokio::test]
    async fn serves_what_installing_needs_without_the_token() {
        let (_dir, router) = test_app().await;
        let request = Request::get("/manifest.webmanifest")
            .body(Body::empty())
            .unwrap();
        assert_eq!(send(&router, request).await.status(), StatusCode::OK);
        let request = Request::get("/index.html").body(Body::empty()).unwrap();
        assert_eq!(
            send(&router, request).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn rejects_cross_origin_writes() {
        let (_dir, router) = test_app().await;
        let request = Request::put("/api/state")
            .header(header::COOKIE, "workshop_token=secret")
            .header(header::HOST, "laptop.ts.net")
            .header(header::ORIGIN, "https://evil.example")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap();
        assert_eq!(send(&router, request).await.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn compares_tokens() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    #[test]
    fn reads_token_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "a=1; workshop_token=xyz; b=2".parse().unwrap(),
        );
        assert_eq!(cookie_token(&headers), Some("xyz"));
    }

    #[test]
    fn checks_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "box.tail.ts.net".parse().unwrap());
        assert!(same_origin(&headers));
        headers.insert(header::ORIGIN, "https://box.tail.ts.net".parse().unwrap());
        assert!(same_origin(&headers));
        headers.insert(header::ORIGIN, "https://evil.example".parse().unwrap());
        assert!(!same_origin(&headers));
    }
}
