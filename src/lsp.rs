//! Relays Language Server Protocol messages between a websocket and a language server's stdio.
//! The editor speaks LSP itself; the server only handles process lifetime and message framing.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::process::{self, ProcessGroup};

/// Larger messages are treated as a protocol error rather than buffered.
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
/// A phone that sleeps or drops off the network can leave its connection half-open, which would
/// keep the language server (often over a gigabyte of memory) running. Browsers answer pings
/// automatically, so a connection that stops answering is closed.
const PING_INTERVAL: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(75);

/// Relays until either side closes, or until `restart` changes, which ends the session so the
/// editor reconnects to a fresh language server.
pub async fn relay(
    socket: WebSocket,
    command: &[String],
    root: &Path,
    environment: &[(String, String)],
    mut restart: tokio::sync::watch::Receiver<u64>,
) -> Result<()> {
    let (program, args) = command
        .split_first()
        .context("empty language server command")?;
    let mut child = process::command(program)
        .args(args)
        .envs(environment.iter().map(|(k, v)| (k, v)))
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("starting language server `{program}`"))?;
    let group = ProcessGroup::of(&child);
    let mut stdin = child.stdin.take().context("stdin not captured")?;
    let stdout = child.stdout.take().context("stdout not captured")?;
    let stderr = child.stderr.take().context("stderr not captured")?;
    let program_name = program.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            tracing::debug!(target: "lsp", "{program_name}: {line}");
        }
    });

    let started = Instant::now();
    let last_heard_ms = Arc::new(AtomicU64::new(0));
    let heard = {
        let last_heard_ms = last_heard_ms.clone();
        move || {
            let now = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            last_heard_ms.store(now, Ordering::Relaxed);
        }
    };

    let (mut ws_tx, mut ws_rx) = socket.split();
    let (outgoing, mut outgoing_rx) = mpsc::channel::<Message>(64);
    let send = async {
        while let Some(message) = outgoing_rx.recv().await {
            ws_tx.send(message).await?;
        }
        anyhow::Ok(())
    };
    let to_server = async {
        while let Some(message) = ws_rx.next().await {
            heard();
            // Phones drop connections without a closing handshake when they sleep or reload,
            // which is a normal way for the session to end.
            let Ok(message) = message else { break };
            match message {
                Message::Text(text) => {
                    let framed = format!("Content-Length: {}\r\n\r\n{}", text.len(), text.as_str());
                    stdin.write_all(framed.as_bytes()).await?;
                    stdin.flush().await?;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        anyhow::Ok(())
    };
    let to_client = {
        let outgoing = outgoing.clone();
        async move {
            let mut reader = BufReader::new(stdout);
            while let Some(message) = read_message(&mut reader).await? {
                outgoing.send(Message::Text(message.into())).await?;
            }
            anyhow::Ok(())
        }
    };
    let keep_alive = async {
        let mut interval = tokio::time::interval(PING_INTERVAL);
        loop {
            interval.tick().await;
            let silent_for = started
                .elapsed()
                .saturating_sub(Duration::from_millis(last_heard_ms.load(Ordering::Relaxed)));
            if silent_for > IDLE_TIMEOUT {
                bail!("the editor stopped responding");
            }
            outgoing.send(Message::Ping(Vec::new().into())).await?;
        }
    };
    let result = tokio::select! {
        r = send => r,
        r = to_server => r,
        r = to_client => r,
        r = keep_alive => r,
        _ = restart.changed() => {
            tracing::info!("restarting the language server");
            Ok(())
        }
        status = child.wait() => {
            let status = status?;
            if status.success() { Ok(()) } else { Err(anyhow::anyhow!("language server exited with {status}")) }
        }
    };
    // Stops the language server and anything it started, such as compiler processes.
    group.finish();
    drop(child);
    result
}

/// Reads one `Content-Length` framed message. Returns `None` at end of stream.
pub async fn read_message<R: AsyncRead + AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Option<String>> {
    let mut content_length = None;
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).await? == 0 {
            return if content_length.is_none() {
                Ok(None)
            } else {
                bail!("language server output ended inside a message header")
            };
        }
        let header = line.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            if content_length.is_some() {
                break;
            }
            continue;
        }
        if let Some((name, value)) = header.split_once(':')
            && name.trim().eq_ignore_ascii_case("content-length")
        {
            content_length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .with_context(|| format!("invalid Content-Length header: {header}"))?,
            );
        }
    }
    let length = content_length.expect("loop only exits once the length is known");
    if length > MAX_MESSAGE_BYTES {
        bail!("language server sent a {length} byte message, which is too large");
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await?;
    Ok(Some(
        String::from_utf8(body).context("language server sent invalid UTF-8")?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_framed_messages() {
        let input = "Content-Length: 2\r\n\r\n{}Content-Type: x\r\nContent-Length: 4\r\n\r\n\"é\"";
        let mut reader = BufReader::new(input.as_bytes());
        assert_eq!(
            read_message(&mut reader).await.unwrap().as_deref(),
            Some("{}")
        );
        assert_eq!(
            read_message(&mut reader).await.unwrap().as_deref(),
            Some("\"é\"")
        );
        assert_eq!(read_message(&mut reader).await.unwrap(), None);
    }

    #[tokio::test]
    async fn rejects_bad_headers() {
        let mut reader = BufReader::new("Content-Length: nope\r\n\r\n".as_bytes());
        assert!(read_message(&mut reader).await.is_err());
        let mut reader = BufReader::new("Content-Length: 5\r\n".as_bytes());
        assert!(read_message(&mut reader).await.is_err());
    }
}
