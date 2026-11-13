//! Relays Language Server Protocol messages between a websocket and a language server's stdio.
//! The editor speaks LSP itself; the server handles process lifetime and message framing.
//!
//! A language server can take a long while to be ready, and a phone drops its connection every
//! time it sleeps, so a server whose editor has gone is kept for a while, and the next editor to
//! connect takes it over. The protocol has a server greeted once, by one client, so the relay
//! stands between them: it answers a later editor's greeting as the server answered the first,
//! closes the files an editor left open, and keeps each editor's requests apart.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use axum::extract::ws::{Message, WebSocket};
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{mpsc, oneshot, watch};

use crate::process::{self, ProcessGroup};

/// Larger messages are treated as a protocol error rather than buffered.
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
/// A phone that sleeps or drops off the network can leave its connection half-open. Browsers
/// answer pings automatically, so a connection that stops answering is taken to have gone.
const PING_INTERVAL: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT: Duration = Duration::from_secs(75);
/// How long a language server is kept once its editor has gone, for the next one to take over.
/// Long enough for a phone to be put down and picked up again, and no longer, as a language
/// server is often over a gigabyte of memory.
const KEEP_FOR: Duration = Duration::from_secs(10 * 60);

// ---- Standing between the editor and the server ----

/// What a request's answer is for, once the server gives it.
enum Pending {
    /// An editor's request, by the ID the editor gave it.
    Request(Value),
    /// The first editor's greeting, whose answer is kept for the editors that follow.
    Initialize { id: Value, key: Value },
}

/// The server's answer to the greeting, and what was said to get it.
struct Greeting {
    key: Value,
    result: Value,
}

/// What an editor's message leads to.
#[derive(Debug, Default, PartialEq)]
pub struct Routed {
    pub to_server: Vec<String>,
    pub to_editor: Vec<String>,
}

/// An editor greeted the server differently from the one it was started for, such as with other
/// settings, so it can't take the server over.
#[derive(Debug)]
pub struct DifferentGreeting;

impl std::fmt::Display for DifferentGreeting {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the editor wants a language server set up differently from the one running")
    }
}

impl std::error::Error for DifferentGreeting {}

/// What a language server has been told, across the editors that come and go, and the requests
/// it has yet to answer.
#[derive(Default)]
pub struct Proxy {
    greeting: Option<Greeting>,
    /// Whether the server has been told the greeting is done.
    greeted: bool,
    /// The files the server has open, which an editor that goes leaves behind.
    open: BTreeSet<String>,
    /// Requests the server hasn't answered, by the IDs they were passed on with: the relay's
    /// own, as one editor's IDs start again where another's began.
    pending: HashMap<u64, Pending>,
    next_id: u64,
}

fn parse(text: &str) -> Result<Value> {
    let message: Value = serde_json::from_str(text).context("a message that isn't JSON")?;
    if !message.is_object() {
        bail!("a message that isn't a JSON object");
    }
    Ok(message)
}

/// The parts of a greeting that decide how the server sets itself up.
fn greeting_key(params: &Value) -> Value {
    json!({
        "rootUri": params.get("rootUri"),
        "capabilities": params.get("capabilities"),
        "initializationOptions": params.get("initializationOptions"),
    })
}

fn uri_of(message: &Value) -> Result<String> {
    message
        .pointer("/params/textDocument/uri")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .context("a message about a file that doesn't say which")
}

impl Proxy {
    /// Takes a message from the editor, and says what to pass on to the server and what to
    /// answer the editor with directly.
    pub fn editor_said(&mut self, text: &str) -> Result<Routed> {
        let mut message = parse(text)?;
        let mut routed = Routed::default();
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let id = message.get("id").cloned();
        match (method.as_deref(), id) {
            (Some("initialize"), Some(id)) => {
                let key = greeting_key(message.get("params").unwrap_or(&Value::Null));
                match &self.greeting {
                    Some(greeting) if greeting.key == key => routed.to_editor.push(
                        json!({ "jsonrpc": "2.0", "id": id, "result": greeting.result })
                            .to_string(),
                    ),
                    Some(_) => return Err(DifferentGreeting.into()),
                    None => {
                        let relayed = self.pend(Pending::Initialize { id, key });
                        message["id"] = json!(relayed);
                        routed.to_server.push(message.to_string());
                    }
                }
            }
            (Some("initialized"), None) => {
                if !self.greeted {
                    self.greeted = true;
                    routed.to_server.push(text.to_owned());
                }
            }
            // The server outlives the editor, so an editor can't stop it.
            (Some("shutdown"), Some(id)) => routed
                .to_editor
                .push(json!({ "jsonrpc": "2.0", "id": id, "result": null }).to_string()),
            (Some("exit"), None) => {}
            (Some("textDocument/didOpen"), None) => {
                self.open.insert(uri_of(&message)?);
                routed.to_server.push(text.to_owned());
            }
            (Some("textDocument/didClose"), None) => {
                self.open.remove(&uri_of(&message)?);
                routed.to_server.push(text.to_owned());
            }
            (Some("$/cancelRequest"), None) => {
                let cancelled = message.pointer("/params/id");
                let relayed = self
                    .pending
                    .iter()
                    .find_map(|(relayed, pending)| match pending {
                        Pending::Request(id) | Pending::Initialize { id, .. }
                            if Some(id) == cancelled =>
                        {
                            Some(*relayed)
                        }
                        _ => None,
                    });
                // Already answered, or never asked: nothing to cancel.
                if let Some(relayed) = relayed {
                    message["params"]["id"] = json!(relayed);
                    routed.to_server.push(message.to_string());
                }
            }
            (Some(_), Some(id)) => {
                let relayed = self.pend(Pending::Request(id));
                message["id"] = json!(relayed);
                routed.to_server.push(message.to_string());
            }
            // Other notifications, and answers to the server's own requests.
            _ => routed.to_server.push(text.to_owned()),
        }
        Ok(routed)
    }

    fn pend(&mut self, pending: Pending) -> u64 {
        self.next_id += 1;
        self.pending.insert(self.next_id, pending);
        self.next_id
    }

    /// Takes a message from the server, and gives what to pass on to the editor, if anything:
    /// an answer to a request of an editor that has since gone is dropped.
    pub fn server_said(&mut self, text: &str) -> Result<Option<String>> {
        let mut message = parse(text)?;
        if message.get("method").is_some() {
            return Ok(Some(text.to_owned()));
        }
        let Some(relayed) = message.get("id").and_then(Value::as_u64) else {
            bail!("the language server sent an answer to no request");
        };
        Ok(match self.pending.remove(&relayed) {
            None => None,
            Some(Pending::Request(id)) => {
                message["id"] = id;
                Some(message.to_string())
            }
            Some(Pending::Initialize { id, key }) => {
                if let Some(result) = message.get("result") {
                    self.greeting = Some(Greeting {
                        key,
                        result: result.clone(),
                    });
                }
                message["id"] = id;
                Some(message.to_string())
            }
        })
    }

    /// What to tell the server as its editor goes: to stop working on what the editor asked,
    /// whose answers nobody is waiting for, and to close the files it had open, which the next
    /// editor opens again as they then are.
    pub fn editor_gone(&mut self) -> Vec<String> {
        let mut to_server: Vec<String> = Vec::new();
        let mut asked: Vec<u64> = self.pending.keys().copied().collect();
        asked.sort_unstable();
        for id in asked {
            to_server.push(
                json!({ "jsonrpc": "2.0", "method": "$/cancelRequest", "params": { "id": id } })
                    .to_string(),
            );
        }
        self.pending.clear();
        for uri in std::mem::take(&mut self.open) {
            to_server.push(
                json!({
                    "jsonrpc": "2.0",
                    "method": "textDocument/didClose",
                    "params": { "textDocument": { "uri": uri } },
                })
                .to_string(),
            );
        }
        to_server
    }

    /// Whether the server has been greeted, and so can be taken over by another editor.
    fn ready(&self) -> bool {
        self.greeting.is_some() && self.greeted
    }
}

/// What to answer the server with while it has no editor: its requests, such as for settings
/// or to show its progress, get an empty answer, so it isn't left waiting. The rest, such as
/// the problems it's found, is dropped: the next editor is told afresh as it opens its files.
pub fn answer_without_editor(text: &str) -> Result<Option<String>> {
    let message = parse(text)?;
    Ok(match (message.get("method"), message.get("id")) {
        (Some(_), Some(id)) => {
            Some(json!({ "jsonrpc": "2.0", "id": id, "result": null }).to_string())
        }
        _ => None,
    })
}

// ---- The servers ----

/// What a language server was started with. Another editor can only take over a server started
/// with the same.
#[derive(Clone, PartialEq)]
pub struct Setup {
    pub command: Vec<String>,
    pub root: PathBuf,
    pub environment: Vec<(String, String)>,
    /// Which restart of the language servers this is, such as after installing packages.
    pub restart: u64,
}

/// A running language server, killed with everything it started when dropped.
struct Server {
    setup: Setup,
    child: Child,
    stdin: ChildStdin,
    /// Each message the server writes, read as it comes so the server is never kept waiting.
    from_server: mpsc::Receiver<Result<String>>,
    proxy: Proxy,
    /// After `child`, so the group is killed once the child has been.
    _group: ProcessGroup,
}

impl Server {
    fn start(setup: Setup) -> Result<Self> {
        let (program, args) = setup
            .command
            .split_first()
            .context("empty language server command")?;
        let mut child = process::command(program)
            .args(args)
            .envs(setup.environment.iter().map(|(k, v)| (k, v)))
            .current_dir(&setup.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .with_context(|| format!("starting language server `{program}`"))?;
        let group = ProcessGroup::of(&child);
        let stdin = child.stdin.take().context("stdin not captured")?;
        let stdout = child.stdout.take().context("stdout not captured")?;
        let stderr = child.stderr.take().context("stderr not captured")?;
        let program_name = program.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "lsp", "{program_name}: {line}");
            }
        });
        let (messages, from_server) = mpsc::channel(64);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let message = read_message(&mut reader).await;
                let done = !matches!(message, Ok(Some(_)));
                let sent = match message.transpose() {
                    Some(message) => messages.send(message).await.is_ok(),
                    None => false,
                };
                if done || !sent {
                    break;
                }
            }
        });
        Ok(Self {
            setup,
            child,
            stdin,
            from_server,
            proxy: Proxy::default(),
            _group: group,
        })
    }

    async fn write(&mut self, message: &str) -> Result<()> {
        let framed = format!("Content-Length: {}\r\n\r\n{message}", message.len());
        self.stdin.write_all(framed.as_bytes()).await?;
        self.stdin.flush().await?;
        Ok(())
    }
}

/// How an editor's time with a server ended.
enum Ending {
    /// The editor went, or stopped answering: the server can be kept for the next.
    EditorGone,
    /// The language servers are being restarted.
    Restart,
}

/// A server waiting for an editor, which asking for it hands over.
struct Waiting {
    setup: Setup,
    ask: oneshot::Sender<oneshot::Sender<Server>>,
}

/// The language servers whose editors have gone, kept for the next editor to take over.
#[derive(Default)]
pub struct Servers {
    waiting: std::sync::Mutex<Vec<Waiting>>,
}

impl Servers {
    /// Relays between an editor's websocket and a language server: one kept from an editor that
    /// has gone, if there's one started the same way, or a new one. Returns once the editor has
    /// gone, the server has stopped, or `restart` changes, which ends the session so the editor
    /// reconnects to a fresh server.
    pub async fn relay(
        &self,
        socket: WebSocket,
        command: &[String],
        root: &Path,
        environment: &[(String, String)],
        mut restart: watch::Receiver<u64>,
    ) -> Result<()> {
        let setup = Setup {
            command: command.to_vec(),
            root: root.to_owned(),
            environment: environment.to_vec(),
            restart: *restart.borrow_and_update(),
        };
        let mut server = match self.take(&setup).await {
            Some(server) => {
                tracing::debug!(target: "lsp", "taking over a running language server");
                server
            }
            None => Server::start(setup)?,
        };
        match serve(socket, &mut server, &mut restart).await? {
            Ending::EditorGone => self.keep(server, restart).await,
            Ending::Restart => tracing::info!("restarting the language server"),
        }
        Ok(())
    }

    /// A waiting server started with `setup`, if there is one still running.
    async fn take(&self, setup: &Setup) -> Option<Server> {
        loop {
            let waiting = {
                let mut all = self.waiting.lock().expect("waiting servers lock poisoned");
                let at = all.iter().position(|w| &w.setup == setup)?;
                all.swap_remove(at)
            };
            let (give, taken) = oneshot::channel();
            // One that stopped waiting, having been kept long enough, has nobody to ask.
            if waiting.ask.send(give).is_ok()
                && let Ok(server) = taken.await
            {
                return Some(server);
            }
        }
    }

    /// Keeps a server whose editor has gone, for a while, answering what it asks meanwhile.
    async fn keep(&self, mut server: Server, mut restart: watch::Receiver<u64>) {
        // One that was never greeted has nothing to save the next editor.
        if !server.proxy.ready() {
            return;
        }
        for message in server.proxy.editor_gone() {
            if let Err(err) = server.write(&message).await {
                tracing::debug!(target: "lsp", "not keeping the language server: {err:#}");
                return;
            }
        }
        let (ask, mut asked) = oneshot::channel::<oneshot::Sender<Server>>();
        {
            let mut all = self.waiting.lock().expect("waiting servers lock poisoned");
            all.retain(|w| !w.ask.is_closed());
            all.push(Waiting {
                setup: server.setup.clone(),
                ask,
            });
        }
        tokio::spawn(async move {
            let until = tokio::time::sleep(KEEP_FOR);
            tokio::pin!(until);
            loop {
                tokio::select! {
                    give = &mut asked => {
                        if let Ok(give) = give {
                            // If whoever asked has gone, the server is dropped, and so stopped.
                            let _ = give.send(server);
                        }
                        return;
                    }
                    message = server.from_server.recv() => {
                        let answer = match message {
                            Some(Ok(text)) => answer_without_editor(&text),
                            Some(Err(err)) => Err(err),
                            None => return,
                        };
                        let written = match answer {
                            Ok(Some(answer)) => server.write(&answer).await,
                            Ok(None) => Ok(()),
                            Err(err) => Err(err),
                        };
                        if let Err(err) = written {
                            tracing::warn!("language server: {err:#}");
                            return;
                        }
                    }
                    _ = &mut until => return,
                    _ = restart.changed() => return,
                    _ = server.child.wait() => return,
                }
            }
        });
    }
}

/// Relays between an editor and a server until one of them goes.
async fn serve(
    mut socket: WebSocket,
    server: &mut Server,
    restart: &mut watch::Receiver<u64>,
) -> Result<Ending> {
    let mut last_heard = Instant::now();
    let mut ping = tokio::time::interval(PING_INTERVAL);
    loop {
        tokio::select! {
            message = socket.recv() => {
                last_heard = Instant::now();
                // Phones drop connections without a closing handshake when they sleep or
                // reload, which is a normal way for the session to end.
                let text = match message {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                        return Ok(Ending::EditorGone);
                    }
                    Some(Ok(_)) => continue,
                };
                let routed = server.proxy.editor_said(text.as_str())?;
                for message in routed.to_server {
                    server.write(&message).await?;
                }
                for message in routed.to_editor {
                    if socket.send(Message::Text(message.into())).await.is_err() {
                        return Ok(Ending::EditorGone);
                    }
                }
            }
            message = server.from_server.recv() => {
                let text = message.context("the language server closed its output")??;
                if let Some(message) = server.proxy.server_said(&text)?
                    && socket.send(Message::Text(message.into())).await.is_err()
                {
                    return Ok(Ending::EditorGone);
                }
            }
            _ = ping.tick() => {
                if last_heard.elapsed() > IDLE_TIMEOUT
                    || socket.send(Message::Ping(Vec::new().into())).await.is_err()
                {
                    return Ok(Ending::EditorGone);
                }
            }
            _ = restart.changed() => return Ok(Ending::Restart),
            status = server.child.wait() => {
                let status = status?;
                bail!("language server exited with {status}");
            }
        }
    }
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

    fn value(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    const GREETING: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":7,"rootUri":"file:///aoc","capabilities":{"textDocument":{}}}}"#;
    const GREETED: &str = r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#;

    fn open(uri: &str) -> String {
        json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": { "textDocument": { "uri": uri, "text": "" } },
        })
        .to_string()
    }

    /// A proxy whose server has been greeted by a first editor.
    fn greeted() -> Proxy {
        let mut proxy = Proxy::default();
        let routed = proxy.editor_said(GREETING).unwrap();
        let relayed = value(&routed.to_server[0])["id"].clone();
        let answer = json!({ "jsonrpc": "2.0", "id": relayed, "result": { "capabilities": { "hoverProvider": true } } });
        proxy.server_said(&answer.to_string()).unwrap();
        proxy.editor_said(GREETED).unwrap();
        proxy
    }

    #[test]
    fn greets_the_server_once_and_answers_later_editors_itself() {
        let mut proxy = Proxy::default();
        assert!(!proxy.ready());
        let first = proxy.editor_said(GREETING).unwrap();
        assert!(first.to_editor.is_empty());
        let passed_on = value(&first.to_server[0]);
        assert_eq!(passed_on["method"], "initialize");
        let answer = json!({ "jsonrpc": "2.0", "id": passed_on["id"], "result": { "capabilities": { "hoverProvider": true } } });
        // The answer goes back under the editor's own ID.
        let back = value(&proxy.server_said(&answer.to_string()).unwrap().unwrap());
        assert_eq!(back["id"], 1);
        assert_eq!(proxy.editor_said(GREETED).unwrap().to_server, [GREETED]);
        assert!(proxy.ready());

        // The next editor, with another process and request ID, is answered without the server.
        proxy.editor_gone();
        let again = GREETING
            .replace(r#""id":1"#, r#""id":"a""#)
            .replace("7", "8");
        let second = proxy.editor_said(&again).unwrap();
        assert!(second.to_server.is_empty());
        let answered = value(&second.to_editor[0]);
        assert_eq!(answered["id"], "a");
        assert_eq!(answered["result"]["capabilities"]["hoverProvider"], true);
        assert_eq!(proxy.editor_said(GREETED).unwrap(), Routed::default());
    }

    #[test]
    fn refuses_an_editor_that_greets_the_server_differently() {
        let mut proxy = greeted();
        let other = GREETING.replace("file:///aoc", "file:///elsewhere");
        let err = proxy.editor_said(&other).unwrap_err();
        assert!(err.downcast_ref::<DifferentGreeting>().is_some());
    }

    #[test]
    fn keeps_each_editors_requests_apart() {
        let mut proxy = greeted();
        let hover = r#"{"jsonrpc":"2.0","id":5,"method":"textDocument/hover","params":{}}"#;
        let first = value(&proxy.editor_said(hover).unwrap().to_server[0])["id"].clone();
        // The editor goes before the answer comes, and the server is told not to bother.
        let told = proxy.editor_gone();
        assert_eq!(value(&told[0])["method"], "$/cancelRequest");
        assert_eq!(value(&told[0])["params"]["id"], first);
        // The next editor uses the same ID for something else.
        let second = value(&proxy.editor_said(hover).unwrap().to_server[0])["id"].clone();
        assert_ne!(first, second);
        let late = json!({ "jsonrpc": "2.0", "id": first, "result": "stale" }).to_string();
        assert_eq!(proxy.server_said(&late).unwrap(), None);
        let fresh = json!({ "jsonrpc": "2.0", "id": second, "result": "fresh" }).to_string();
        let back = value(&proxy.server_said(&fresh).unwrap().unwrap());
        assert_eq!(back["id"], 5);
        assert_eq!(back["result"], "fresh");
    }

    #[test]
    fn cancels_by_the_id_a_request_was_passed_on_with() {
        let mut proxy = greeted();
        let hover = r#"{"jsonrpc":"2.0","id":5,"method":"textDocument/hover","params":{}}"#;
        let relayed = value(&proxy.editor_said(hover).unwrap().to_server[0])["id"].clone();
        let cancel = r#"{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":5}}"#;
        let passed_on = value(&proxy.editor_said(cancel).unwrap().to_server[0]);
        assert_eq!(passed_on["params"]["id"], relayed);
        // Cancelling what was never asked tells the server nothing.
        let unknown = r#"{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":99}}"#;
        assert_eq!(proxy.editor_said(unknown).unwrap(), Routed::default());
    }

    #[test]
    fn closes_the_files_an_editor_leaves_open() {
        let mut proxy = greeted();
        proxy.editor_said(&open("file:///aoc/a.py")).unwrap();
        proxy.editor_said(&open("file:///aoc/b.py")).unwrap();
        let close = r#"{"jsonrpc":"2.0","method":"textDocument/didClose","params":{"textDocument":{"uri":"file:///aoc/a.py"}}}"#;
        assert_eq!(proxy.editor_said(close).unwrap().to_server, [close]);
        let told = proxy.editor_gone();
        assert_eq!(told.len(), 1);
        assert_eq!(value(&told[0])["method"], "textDocument/didClose");
        assert_eq!(
            value(&told[0])["params"]["textDocument"]["uri"],
            "file:///aoc/b.py"
        );
        // Nothing is left for the editor after to close.
        assert!(proxy.editor_gone().is_empty());
    }

    #[test]
    fn keeps_the_server_running_when_an_editor_says_to_stop() {
        let mut proxy = greeted();
        let shutdown = r#"{"jsonrpc":"2.0","id":9,"method":"shutdown"}"#;
        let routed = proxy.editor_said(shutdown).unwrap();
        assert!(routed.to_server.is_empty());
        assert_eq!(
            value(&routed.to_editor[0]),
            json!({ "jsonrpc": "2.0", "id": 9, "result": null })
        );
        let exit = r#"{"jsonrpc":"2.0","method":"exit"}"#;
        assert_eq!(proxy.editor_said(exit).unwrap(), Routed::default());
    }

    #[test]
    fn passes_on_what_the_server_asks_and_says_and_the_editors_answers() {
        let mut proxy = greeted();
        let asks = r#"{"jsonrpc":"2.0","id":3,"method":"workspace/configuration","params":{}}"#;
        assert_eq!(proxy.server_said(asks).unwrap().as_deref(), Some(asks));
        let answer = r#"{"jsonrpc":"2.0","id":3,"result":[null]}"#;
        assert_eq!(proxy.editor_said(answer).unwrap().to_server, [answer]);
        let says = r#"{"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{}}"#;
        assert_eq!(proxy.server_said(says).unwrap().as_deref(), Some(says));
    }

    #[test]
    fn refuses_messages_it_cant_read() {
        let mut proxy = greeted();
        assert!(proxy.editor_said("not json").is_err());
        assert!(proxy.editor_said("[]").is_err());
        assert!(
            proxy
                .server_said(r#"{"jsonrpc":"2.0","result":1}"#)
                .is_err()
        );
        assert!(
            proxy
                .editor_said(r#"{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{}}"#)
                .is_err()
        );
    }

    #[test]
    fn answers_the_server_itself_while_it_has_no_editor() {
        let asks = r#"{"jsonrpc":"2.0","id":3,"method":"workspace/configuration","params":{}}"#;
        assert_eq!(
            value(&answer_without_editor(asks).unwrap().unwrap()),
            json!({ "jsonrpc": "2.0", "id": 3, "result": null })
        );
        let says = r#"{"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{}}"#;
        assert_eq!(answer_without_editor(says).unwrap(), None);
        assert_eq!(
            answer_without_editor(r#"{"jsonrpc":"2.0","id":4,"result":1}"#).unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn rejects_bad_headers() {
        let mut reader = BufReader::new("Content-Length: nope\r\n\r\n".as_bytes());
        assert!(read_message(&mut reader).await.is_err());
        let mut reader = BufReader::new("Content-Length: 5\r\n".as_bytes());
        assert!(read_message(&mut reader).await.is_err());
    }
}
