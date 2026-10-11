//! Relays Language Server Protocol messages between a websocket and a language server's stdio.
//! The editor speaks LSP itself; the server only handles process lifetime and message framing.

use std::path::Path;
use std::process::Stdio;

use anyhow::{Context, Result, bail};
use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// Larger messages are treated as a protocol error rather than buffered.
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

pub async fn relay(socket: WebSocket, command: &[String], root: &Path) -> Result<()> {
    let (program, args) = command
        .split_first()
        .context("empty language server command")?;
    let mut child = Command::new(program)
        .args(args)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("starting language server `{program}`"))?;
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

    let (mut ws_tx, mut ws_rx) = socket.split();
    let to_server = async {
        while let Some(message) = ws_rx.next().await {
            match message? {
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
    let to_client = async {
        let mut reader = BufReader::new(stdout);
        while let Some(message) = read_message(&mut reader).await? {
            ws_tx.send(Message::Text(message.into())).await?;
        }
        anyhow::Ok(())
    };
    let result = tokio::select! {
        r = to_server => r,
        r = to_client => r,
        status = child.wait() => {
            let status = status?;
            if status.success() { Ok(()) } else { Err(anyhow::anyhow!("language server exited with {status}")) }
        }
    };
    // Dropping the child kills the server if it's still running.
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
